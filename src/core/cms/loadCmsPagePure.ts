/**
 * Framework-agnostic page loader.
 *
 * This is the pure logical core of `loadCmsPage`. It takes a request URL +
 * matcher context as plain values and returns the resolved page (with section
 * loaders run) plus cache metadata. Hosts (TanStack, Next.js, Remix, plain
 * Node) build their own `MatcherContext` from request primitives, call this,
 * then translate `cacheMetadata` into response headers themselves.
 *
 * The TanStack wrapper (`src/tanstack/routes/cmsRoute.ts`) is a thin caller
 * that pulls request data from `getRequestUrl`/`getCookies`/etc. and re-emits
 * `cacheMetadata` via `setResponseHeader`.
 */

import { detectDevice, type Device } from "../sdk/useDevice";
import { type CacheProfileName, detectCacheProfile } from "../sdk/cacheHeaders";
import { normalizeUrlsInObject } from "../sdk/normalizeUrls";
import { preloadSectionComponents } from "./registry";
import {
  type DeferredSection,
  type MatcherContext,
  type PageSeo,
  type ResolvedSection,
  extractSeoFromProps,
  extractSeoFromSections,
  resolveDecoPage,
} from "./resolve";
import { getSiteSeo } from "./loader";
import { runSectionLoaders, runSingleSectionLoader } from "./sectionLoaders";

/**
 * Return shape for `loadCmsPagePure`. Mirrors the data the TanStack loader
 * has historically returned, plus a `cacheMetadata` object so non-TanStack
 * hosts can decide what response headers to emit.
 */
export interface LoadedCmsPage {
  name: string;
  path: string;
  params: Record<string, string>;
  blockKey?: string;
  resolvedSections: ResolvedSection[];
  deferredSections: DeferredSection[];
  cacheProfile: CacheProfileName;
  pageUrl: string;
  pagePath: string;
  seo: PageSeo;
  device: Device;
  /**
   * Hints for the host transport layer about how this response can be cached.
   * The pure loader does not set HTTP headers itself — the host does, based
   * on these flags.
   */
  cacheMetadata: {
    /** Safe to edge-cache. Hosts typically translate this into `X-Deco-Cacheable: true`. */
    cacheable: boolean;
    /** Optional `Cache-Control` value the host should emit. */
    cacheControl?: string;
  };
}

/**
 * Framework-agnostic page loader. Use from any non-TanStack host (Next.js,
 * Remix, plain Node, ...). The caller supplies a `MatcherContext` and is
 * responsible for translating `result.cacheMetadata` into response headers.
 *
 * @returns the resolved page, or null if no page matches the path.
 */
export async function loadCmsPagePure(
  fullPath: string,
  ctx: MatcherContext,
): Promise<LoadedCmsPage | null> {
  const [basePath] = fullPath.split("?");
  const pageUrl = ctx.url ?? fullPath;
  const userAgent = ctx.userAgent ?? "";

  const page = await resolveDecoPage(basePath, ctx);
  if (!page) return null;

  // Build a Request for section loaders. Prefer the supplied request so that
  // header-derived state (auth, cookies, geo) flows into loaders unchanged.
  const request =
    ctx.request ??
    new Request(pageUrl, {
      headers: ctx.headers ?? {},
    });

  const enrichedSections = await runSectionLoaders(page.resolvedSections, request);

  // Pre-import eager section modules so their default exports are cached
  // in resolvedComponents. This ensures SSR renders with direct component
  // refs, and the client hydration can skip React.lazy/Suspense.
  const eagerKeys = enrichedSections.map((s) => s.component);
  await preloadSectionComponents(eagerKeys);

  const cacheProfile = detectCacheProfile(basePath);
  const device = detectDevice(userAgent);

  const seo = await buildPageSeo(page.seoSection, enrichedSections, request);

  // Drop seoSection — it's an internal artifact, not serialized to client.
  const { seoSection: _seo, ...pageData } = page;

  return {
    ...pageData,
    resolvedSections: normalizeUrlsInObject(enrichedSections),
    deferredSections: normalizeUrlsInObject(page.deferredSections),
    cacheProfile,
    pageUrl,
    pagePath: basePath,
    seo,
    device,
    cacheMetadata: {
      // Pages resolved from the CMS are edge-cacheable by default; the host
      // decides the actual TTL via `cacheProfile`.
      cacheable: true,
    },
  };
}

// ---------------------------------------------------------------------------
// SEO assembly — same logic as the TanStack loader, kept private to the pure
// module so non-TanStack hosts inherit identical SEO behavior.
// ---------------------------------------------------------------------------

async function buildPageSeo(
  seoSection: ResolvedSection | null | undefined,
  enrichedSections: ResolvedSection[],
  request: Request,
): Promise<PageSeo> {
  const sectionSeo = extractSeoFromSections(enrichedSections);
  const siteSeo = getSiteSeo();

  if (!seoSection) {
    const merged: PageSeo = { ...sectionSeo };
    if (siteSeo.title && !merged.title) merged.title = siteSeo.title;
    if (siteSeo.description && !merged.description) merged.description = siteSeo.description;
    if (siteSeo.image && !merged.image) merged.image = siteSeo.image;

    const titleTemplate = effectiveTemplate(siteSeo.titleTemplate);
    const descTemplate = effectiveTemplate(siteSeo.descriptionTemplate);
    if (titleTemplate && merged.title) {
      merged.title = titleTemplate.replace("%s", merged.title);
    }
    if (descTemplate && merged.description) {
      merged.description = descTemplate.replace("%s", merged.description);
    }
    return merged;
  }

  let enrichedProps = seoSection.props;
  try {
    const enriched = await runSingleSectionLoader(seoSection, request);
    if (enriched) enrichedProps = enriched.props;
  } catch {
    /* loader failed — use raw resolved props */
  }

  const pageSeo = extractSeoFromProps(enrichedProps);

  if (!pageSeo.title && siteSeo.title) pageSeo.title = siteSeo.title;
  if (!pageSeo.description && siteSeo.description) pageSeo.description = siteSeo.description;
  if (!pageSeo.image && siteSeo.image) pageSeo.image = siteSeo.image;

  const rawProps = seoSection.props;
  const titleTemplate =
    effectiveTemplate(rawProps.titleTemplate as string | undefined) ??
    effectiveTemplate(siteSeo.titleTemplate);
  const descTemplate =
    effectiveTemplate(rawProps.descriptionTemplate as string | undefined) ??
    effectiveTemplate(siteSeo.descriptionTemplate);

  if (titleTemplate && pageSeo.title) {
    pageSeo.title = titleTemplate.replace("%s", pageSeo.title);
  }
  if (descTemplate && pageSeo.description) {
    pageSeo.description = descTemplate.replace("%s", pageSeo.description);
  }

  return { ...sectionSeo, ...pageSeo };
}

function effectiveTemplate(tmpl: string | undefined): string | undefined {
  if (!tmpl || tmpl.trim() === "" || tmpl.trim() === "%s") return undefined;
  return tmpl;
}
