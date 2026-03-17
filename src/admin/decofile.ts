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
  const authHeader = request.headers.get("authorization") || "";
  const expectedToken =
    (env?.DECO_RELOAD_TOKEN as string | undefined) ??
    (typeof globalThis.process !== "undefined"
      ? globalThis.process.env?.DECO_RELOAD_TOKEN
      : undefined);

  if (expectedToken && !authHeader.includes(expectedToken)) {
    return new Response("Unauthorized", { status: 401 });
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
