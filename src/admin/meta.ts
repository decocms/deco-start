import { djb2Hex } from "../sdk/djb2";
import { composeMeta, type MetaResponse } from "./schema";

let metaData: MetaResponse | null = null;
let cachedEtag: string | null = null;

/**
 * Invalidate the cached ETag so the admin re-fetches meta after a
 * hot-reload or decofile change.
 *
 * Called by decofile.ts after setBlocks() — no server-side loader import
 * needed here, keeping this module safe for client-side bundles.
 */
export function invalidateMetaCache() {
  cachedEtag = null;
}

/**
 * Set the schema metadata that /deco/meta will return.
 * Runs composeMeta() to inject framework-level schemas (pages, etc.)
 * on top of the site-generated section schemas.
 */
export function setMetaData(data: MetaResponse) {
  metaData = composeMeta(data);
  cachedEtag = null;
}

/**
 * Content-based hash for ETag.
 * Uses DJB2 over the serialised JSON so any definition change
 * results in a different ETag, forcing admin to re-fetch.
 */
function getEtag(): string {
  if (!cachedEtag) {
    const str = JSON.stringify(metaData || {});
    cachedEtag = `"meta-${djb2Hex(str)}"`;
  }
  return cachedEtag;
}

export function handleMeta(request: Request): Response {
  if (!metaData) {
    return new Response(JSON.stringify({ error: "Schema not initialized" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ifNoneMatch = request.headers.get("if-none-match");
  const etag = getEtag();

  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const body = JSON.stringify({ ...metaData, etag });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ETag: etag,
      "Cache-Control": "must-revalidate",
    },
  });
}
