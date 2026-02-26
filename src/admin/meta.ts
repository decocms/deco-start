let metaData: any = null;
let cachedEtag: string | null = null;

/**
 * Set the schema metadata that /deco/meta will return.
 * Called by the site at startup with the generated schema.
 */
export function setMetaData(data: any) {
  metaData = data;
  cachedEtag = null;
}

function getEtag(): string {
  if (!cachedEtag) {
    const hash = JSON.stringify(metaData || {}).length.toString(36);
    cachedEtag = `"meta-${hash}"`;
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

  return new Response(JSON.stringify(metaData), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ETag: etag,
      "Cache-Control": "must-revalidate",
    },
  });
}
