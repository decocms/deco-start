import metaData from "./meta.gen.json";

let cachedEtag: string | null = null;

function getEtag(): string {
  if (!cachedEtag) {
    const hash = JSON.stringify(metaData).length.toString(36);
    cachedEtag = `"meta-${hash}"`;
  }
  return cachedEtag;
}

export function handleMeta(request: Request): Response {
  const ifNoneMatch = request.headers.get("if-none-match");
  const etag = getEtag();

  if (ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag },
    });
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
