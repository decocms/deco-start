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
  return await loadCmsPagePure(req.url, ctx);
}
