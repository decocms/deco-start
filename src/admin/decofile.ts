import { KV_KEYS } from "../cms/blockSource";
import { getRevision, loadBlocks, setBlocks } from "../cms/loader";
import { clearLoaderCache } from "../sdk/cachedLoader";
import { getFastDeployKV } from "../sdk/kvHydration";
import { getRuntimeEnv } from "../sdk/otelAdapters";
import { invalidateMetaCache } from "./meta";

export function handleDecofileRead(): Response {
  const blocks = loadBlocks();
  const revision = getRevision();

  return new Response(JSON.stringify(blocks), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      ...(revision ? { ETag: `"${revision}"` } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Delta payloads
//
// Studio (admin.deco.cx) and CI can POST a partial update instead of the whole
// decofile. The delta envelope is:
//
//   { "blocks": { "<blockName>": <blockJson> | null, ... } }
//
// where a `null` value deletes that block. A delta is identified by a body that
// has EXACTLY one top-level key, `blocks`, holding an object — a full decofile
// always carries many top-level block keys (Site, pages-*, …), so there is no
// realistic collision. Any other object body is treated as a full decofile
// replacement (backward-compatible with the dev Vite plugin).
// ---------------------------------------------------------------------------

interface DeltaPayload {
  blocks: Record<string, unknown | null>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isDeltaPayload(body: unknown): body is DeltaPayload {
  return isObject(body) && Object.keys(body).length === 1 && isObject(body.blocks);
}

/** Apply a delta over the current decofile: set non-null values, delete nulls. */
function applyDelta(
  base: Record<string, unknown>,
  delta: Record<string, unknown | null>,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [name, value] of Object.entries(delta)) {
    if (value === null || value === undefined) {
      delete merged[name];
    } else {
      merged[name] = value;
    }
  }
  return merged;
}

/**
 * Write the current in-memory decofile snapshot to KV so other isolates pick
 * it up on their next revision poll. No-op (returns false) when fast-deploy is
 * disabled. The revision stored MUST equal the runtime's `getRevision()` so
 * pollers don't see a permanent mismatch.
 */
async function writeSnapshotToKV(env: Record<string, unknown> | undefined): Promise<boolean> {
  const kv = env ? getFastDeployKV(env) : null;
  if (!kv) return false;

  const blocks = loadBlocks();
  const revision = getRevision();
  await kv.put(KV_KEYS.SNAPSHOT, JSON.stringify(blocks));
  if (revision) await kv.put(KV_KEYS.REVISION, revision);
  return true;
}

export async function handleDecofileReload(
  request: Request,
  env?: Record<string, unknown>,
): Promise<Response> {
  // Resolve the runtime env once. Prefer an explicitly-passed env, then the
  // per-request Workers env stashed by workerEntry (`setRuntimeEnv`). Used for
  // both the reload token and the fast-deploy KV binding.
  const runtimeEnv = env ?? getRuntimeEnv();

  // In dev mode the Vite plugin POSTs new blocks here to hot-reload without
  // module invalidation (which breaks TanStack Start/Router state). Skip auth
  // so the plugin can POST from localhost.
  // Uses import.meta.env.DEV directly (not isDevMode()) because isDevMode()
  // bypass auth. Vite statically replaces import.meta.env.DEV with `false`
  // in production builds, so this branch is dead-code-eliminated.
  const isViteDev = !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
  if (!isViteDev) {
    const authHeader = request.headers.get("Authorization") || "";
    const expectedToken =
      (runtimeEnv?.DECO_RELEASE_RELOAD_TOKEN as string | undefined) ??
      (typeof globalThis.process !== "undefined"
        ? globalThis.process.env?.DECO_RELEASE_RELOAD_TOKEN
        : undefined);

    if (!expectedToken || authHeader !== expectedToken) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!isObject(body)) {
    return new Response(JSON.stringify({ error: "Body must be a JSON object" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const previousBlockCount = Object.keys(loadBlocks()).length;

  // Delta merge (partial update) or full decofile replacement.
  let nextBlocks: Record<string, unknown>;
  let isDelta: boolean;
  if (isDeltaPayload(body)) {
    nextBlocks = applyDelta(loadBlocks(), body.blocks);
    isDelta = true;
  } else {
    nextBlocks = body;
    isDelta = false;
  }

  setBlocks(nextBlocks);
  // Invalidate the meta ETag so the admin re-fetches the schema on next poll.
  invalidateMetaCache();
  // Clear stale loader cache entries after decofile update
  clearLoaderCache();

  // Fast-deploy: persist the new snapshot to KV so other isolates converge.
  // A failed KV write does NOT fail the request — this isolate is already
  // updated; we surface `kvWritten: false` so the caller can retry.
  let kvWritten = false;
  try {
    kvWritten = await writeSnapshotToKV(runtimeEnv);
  } catch (e) {
    console.warn("[CMS/KV] write-through after publish failed:", e);
  }

  const newBlockCount = Object.keys(nextBlocks).length;
  const revision = getRevision();

  return new Response(
    JSON.stringify({
      ok: true,
      mode: isDelta ? "delta" : "full",
      previousBlockCount,
      newBlockCount,
      revision,
      kvWritten,
      timestamp: Date.now(),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
