import { buildMatcherContextFromNext, loadCmsPage } from "@decocms/start/next";
import { findPageByPath } from "@decocms/start/cms";
import { cacheHeaders } from "@decocms/start/sdk/cacheHeaders";

export default async function SmokePage() {
  // Reference the symbols so they're not tree-shaken.
  const req = new Request("http://localhost/");
  const ctx = buildMatcherContextFromNext(req);
  const types = [
    typeof loadCmsPage,
    typeof findPageByPath,
    typeof cacheHeaders,
    typeof ctx,
  ];
  return <pre>{JSON.stringify({ types }, null, 2)}</pre>;
}
