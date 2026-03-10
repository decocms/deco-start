import { onChange } from "../cms/loader";
import { composeMeta, type MetaResponse } from "./schema";

let metaData: MetaResponse | null = null;
let cachedEtag: string | null = null;

// Auto-invalidate the cached ETag when the decofile changes.
// This ensures the admin re-fetches meta after a hot-reload.
onChange(() => {
  cachedEtag = null;
});

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
 * Uses a simple DJB2-style hash over the serialised JSON so any
 * definition change results in a different ETag, forcing admin to
 * re-fetch rather than use stale cached meta.
 */
function getEtag(): string {
  if (!cachedEtag) {
    const str = JSON.stringify(metaData || {});
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
    }
    cachedEtag = `"meta-${hash.toString(36)}"`;
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
