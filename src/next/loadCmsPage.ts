import { loadCmsPagePure, type LoadedCmsPage } from "../core/cms/loadCmsPagePure";
import { buildMatcherContextFromNext } from "./ctx";

/**
 * Load a Deco CMS page from a Next.js App Router route handler or RSC.
 * Returns the resolved page or null if no page matches.
 *
 * @example
 * import { loadCmsPage } from "@decocms/start/next";
 * const result = await loadCmsPage(new Request(`http://localhost${pathname}`));
 */
export async function loadCmsPage(req: Request): Promise<LoadedCmsPage | null> {
  const ctx = buildMatcherContextFromNext(req);
  // ctx.path is the pathname extracted from req.url by
  // buildMatcherContextFromNext. Pass it (NOT req.url) — req.url is the
  // absolute URL per the WHATWG Fetch spec, and loadCmsPagePure treats
  // its first argument as a path that flows into findPageByPath.
  return await loadCmsPagePure(ctx.path ?? new URL(req.url).pathname, ctx);
}
