import { djb2Hex } from "../sdk/djb2.ts";
import { composeMeta, type MetaResponse } from "./schema.ts";

// Use globalThis to share meta state across module instances.
// The daemon middleware imports this module via native import() (outside Vite SSR),
// while setup.ts calls setMetaData() via Vite SSR — these are different module instances.
// globalThis bridges them so both see the same metaData.
const G = globalThis as unknown as {
  __deco_meta_data?: MetaResponse | null;
  __deco_meta_etag?: string | null;
};

function getMetaData(): MetaResponse | null {
  return G.__deco_meta_data ?? null;
}

function setMetaDataInternal(data: MetaResponse | null) {
  G.__deco_meta_data = data;
}

function getCachedEtag(): string | null {
  return G.__deco_meta_etag ?? null;
}

function setCachedEtag(etag: string | null) {
  G.__deco_meta_etag = etag;
}

/**
 * Invalidate the cached ETag so the admin re-fetches meta after a
 * hot-reload or decofile change.
 *
 * Called by decofile.ts after setBlocks() — no server-side loader import
 * needed here, keeping this module safe for client-side bundles.
 */
export function invalidateMetaCache() {
  setCachedEtag(null);
}

/**
 * Set the schema metadata that /deco/meta will return.
 * Runs composeMeta() to inject framework-level schemas (pages, etc.)
 * on top of the site-generated section schemas.
 */
export function setMetaData(data: MetaResponse) {
  setMetaDataInternal(composeMeta(data));
  setCachedEtag(null);
}

/**
 * Content-based hash for ETag.
 * Uses DJB2 over the serialised JSON so any definition change
 * results in a different ETag, forcing admin to re-fetch.
 */
function getEtag(): string {
  let etag = getCachedEtag();
  if (!etag) {
    const str = JSON.stringify(getMetaData() || {});
    etag = `"meta-${djb2Hex(str)}"`;
    setCachedEtag(etag);
  }
  return etag;
}

export function handleMeta(request: Request): Response {
  const metaData = getMetaData();
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
