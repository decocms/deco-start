import { getRevision, loadBlocks, setBlocks } from "../cms/loader";
import { clearLoaderCache } from "../sdk/cachedLoader";
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

export async function handleDecofileReload(
  request: Request,
  env?: Record<string, unknown>,
): Promise<Response> {
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
      (env?.DECO_RELEASE_RELOAD_TOKEN as string | undefined) ??
      (typeof globalThis.process !== "undefined"
        ? globalThis.process.env?.DECO_RELEASE_RELOAD_TOKEN
        : undefined);

    if (!expectedToken || authHeader !== expectedToken) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let newBlocks: Record<string, unknown>;
  try {
    newBlocks = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!newBlocks || typeof newBlocks !== "object") {
    return new Response(JSON.stringify({ error: "Body must be a JSON object" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const previousBlockCount = Object.keys(loadBlocks()).length;

  setBlocks(newBlocks);
  // Invalidate the meta ETag so the admin re-fetches the schema on next poll.
  invalidateMetaCache();
  // Clear stale loader cache entries after decofile update
  clearLoaderCache();

  const newBlockCount = Object.keys(newBlocks).length;
  const revision = getRevision();

  return new Response(
    JSON.stringify({
      ok: true,
      previousBlockCount,
      newBlockCount,
      revision,
      timestamp: Date.now(),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
