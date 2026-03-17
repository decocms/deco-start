/**
 * CMS Route Helpers
 *
 * Reusable building blocks for CMS catch-all and homepage routes.
 * Since TanStack Router requires routes to be file-based in the site repo,
 * we export helper functions and config that sites use in their route files.
 *
 * @example Site's `src/routes/$.tsx`:
 * ```ts
 * import { createFileRoute, notFound } from "@tanstack/react-router";
 * import { loadCmsPage, cmsRouteConfig } from "@decocms/start/routes";
 * import { DecoPageRenderer } from "@decocms/start/hooks";
 *
 * export const Route = createFileRoute("/$")({
 *   ...cmsRouteConfig({
 *     siteName: "My Store",
 *     defaultTitle: "My Store - Best products",
 *     ignoreSearchParams: ["skuId"],
 *   }),
 * });
 * ```
 */

import { createServerFn } from "@tanstack/react-start";
import {
  getCookies,
  getRequest,
  getRequestHeader,
  getRequestUrl,
} from "@tanstack/react-start/server";
import { createElement } from "react";
import { preloadSectionComponents } from "../cms/registry";
import type { DeferredSection, MatcherContext, PageSeo, ResolvedSection } from "../cms/resolve";
import {
  extractSeoFromProps,
  extractSeoFromSections,
  resolveDecoPage,
  resolveDeferredSection,
} from "../cms/resolve";
import { getSiteSeo } from "../cms/loader";
import { runSectionLoaders, runSingleSectionLoader } from "../cms/sectionLoaders";
import {
  type CacheProfile,
  cacheHeaders,
  detectCacheProfile,
  routeCacheDefaults,
} from "../sdk/cacheHeaders";
import { normalizeUrlsInObject } from "../sdk/normalizeUrls";
import { type Device, detectDevice } from "../sdk/useDevice";

const isServer = typeof document === "undefined";

// ---------------------------------------------------------------------------
// Server function — loads a CMS page, runs section loaders, detects cache
// ---------------------------------------------------------------------------

type PageResult = Awaited<ReturnType<typeof loadCmsPageInternal>>;
const pageInflight = new Map<string, Promise<PageResult>>();

async function loadCmsPageInternal(fullPath: string) {
  const [basePath] = fullPath.split("?");
  const serverUrl = getRequestUrl();
  // Prefer the real server URL when available — it preserves duplicate query
  // params (e.g. filter.category-1=a&filter.category-1=b) that the TanStack
  // Router search object (plain Record<string,string>) would collapse.
  const realUrlPath = serverUrl.pathname + serverUrl.search;
  const urlWithSearch =
    realUrlPath.startsWith(basePath) && serverUrl.search
      ? serverUrl.toString()
      : fullPath.includes("?")
        ? new URL(fullPath, serverUrl.origin).toString()
        : serverUrl.toString();

  const originRequest = getRequest();
  const matcherCtx: MatcherContext = {
    userAgent: getRequestHeader("user-agent") ?? "",
    url: urlWithSearch,
    path: basePath,
    cookies: getCookies(),
    request: originRequest,
  };
  const page = await resolveDecoPage(basePath, matcherCtx);
  if (!page) return null;

  const request = new Request(urlWithSearch, {
    headers: originRequest.headers,
  });
  const enrichedSections = await runSectionLoaders(page.resolvedSections, request);

  // Pre-import eager section modules so their default exports are cached
  // in resolvedComponents. This ensures SSR renders with direct component
  // refs, and the client hydration can skip React.lazy/Suspense.
  const eagerKeys = enrichedSections.map((s) => s.component);
  await preloadSectionComponents(eagerKeys);

  const cacheProfile = detectCacheProfile(basePath);
  const ua = getRequestHeader("user-agent") ?? "";
  const device = detectDevice(ua);

  // Build SEO: merge page-level seo block (primary) with section-contributed SEO (secondary)
  const seo = await buildPageSeo(page.seoSection, enrichedSections, request);

  // Destructure seoSection out — it's an internal artifact, not serialized to client
  const { seoSection: _seo, ...pageData } = page;

  return {
    ...pageData,
    resolvedSections: normalizeUrlsInObject(enrichedSections),
    deferredSections: normalizeUrlsInObject(page.deferredSections),
    cacheProfile,
    pageUrl: urlWithSearch,
    seo,
    device,
  };
}

export const loadCmsPage = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => data as string)
  .handler(async (ctx) => {
    const fullPath = ctx.data;
    const [basePath] = fullPath.split("?");

    const existing = pageInflight.get(basePath);
    if (existing) return existing;

    const promise = loadCmsPageInternal(fullPath).finally(() => pageInflight.delete(basePath));
    pageInflight.set(basePath, promise);
    return promise;
  });

/**
 * Same as loadCmsPage but hardcoded to "/" path.
 * Avoids passing data through the server function for the homepage.
 */
export const loadCmsHomePage = createServerFn({ method: "GET" }).handler(async () => {
  const request = getRequest();
  const ua = getRequestHeader("user-agent") ?? "";
  const matcherCtx: MatcherContext = {
    userAgent: ua,
    url: getRequestUrl().toString(),
    path: "/",
    cookies: getCookies(),
    request,
  };
  const page = await resolveDecoPage("/", matcherCtx);
  if (!page) return null;
  const enrichedSections = await runSectionLoaders(page.resolvedSections, request);

  const eagerKeys = enrichedSections.map((s) => s.component);
  await preloadSectionComponents(eagerKeys);

  const device = detectDevice(ua);
  const seo = await buildPageSeo(page.seoSection, enrichedSections, request);

  const { seoSection: _seo, ...pageData } = page;

  return {
    ...pageData,
    resolvedSections: normalizeUrlsInObject(enrichedSections),
    deferredSections: normalizeUrlsInObject(page.deferredSections),
    seo,
    device,
  };
});

// ---------------------------------------------------------------------------
// Deferred section loader — resolves + enriches a single section on demand
// ---------------------------------------------------------------------------

export const loadDeferredSection = createServerFn({ method: "POST" })
  .inputValidator(
    (data: unknown) =>
      data as { component: string; rawProps: Record<string, any>; pagePath: string; pageUrl?: string },
  )
  .handler(async (ctx) => {
    const { component, rawProps, pagePath, pageUrl } = ctx.data;

    const originRequest = getRequest();
    const serverUrl = getRequestUrl().toString();
    const matcherCtx: MatcherContext = {
      userAgent: getRequestHeader("user-agent") ?? "",
      url: pageUrl || serverUrl,
      path: pagePath,
      cookies: getCookies(),
      request: originRequest,
    };

    const section = await resolveDeferredSection(component, rawProps, pagePath, matcherCtx);
    if (!section) return null;

    const request = new Request(pageUrl || serverUrl, {
      headers: originRequest.headers,
    });
    const enriched = await runSingleSectionLoader(section, request);
    return normalizeUrlsInObject(enriched);
  });

// ---------------------------------------------------------------------------
// Default pending component — shown during SPA navigation while loader runs
// ---------------------------------------------------------------------------

export function CmsPagePendingFallback() {
  return createElement(
    "div",
    { className: "w-full min-h-[60vh] flex flex-col gap-6 py-8" },
    createElement("div", {
      className: "skeleton animate-pulse w-full rounded",
      style: { aspectRatio: "1440/400", minHeight: 200 },
    }),
    createElement(
      "div",
      { className: "px-4 lg:px-8 flex flex-col gap-4" },
      createElement("div", { className: "skeleton animate-pulse w-48 h-8 rounded" }),
      createElement(
        "div",
        { className: "grid grid-cols-2 lg:grid-cols-4 gap-4" },
        ...Array.from({ length: 4 }, (_, i) =>
          createElement("div", {
            key: i,
            className: "skeleton animate-pulse w-full h-48 lg:h-64 rounded",
          }),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Route configuration factory
// ---------------------------------------------------------------------------

export interface CmsRouteOptions {
  /** Site name used in page titles (e.g. "Espaço Smart"). */
  siteName: string;
  /** Default page title when CMS page has no name. */
  defaultTitle: string;
  /** Default description for pages without section-contributed SEO. */
  defaultDescription?: string;
  /**
   * Search params to exclude from loader deps.
   * These params won't trigger a server re-fetch when they change.
   * Defaults to `["skuId"]` — variant selection is client-side only.
   */
  ignoreSearchParams?: string[];
  /** Custom pending component shown during SPA navigation. */
  pendingComponent?: () => any;
}

type CmsPageLoaderData = {
  name?: string;
  cacheProfile?: CacheProfile;
  seo?: PageSeo;
  device?: Device;
} | null;

// ---------------------------------------------------------------------------
// Page SEO assembly — merges page.seo block with section-contributed SEO
// ---------------------------------------------------------------------------

/**
 * Process the resolved SEO section from page.seo, run its section loader
 * if registered, apply title/description templates, and merge with
 * section-contributed SEO.
 */
async function buildPageSeo(
  seoSection: ResolvedSection | null | undefined,
  enrichedSections: ResolvedSection[],
  request: Request,
): Promise<PageSeo> {
  // Secondary source: SEO sections embedded in the sections array
  const sectionSeo = extractSeoFromSections(enrichedSections);

  // Site-wide SEO config from the "Site" app block — mirrors ctx.seo in
  // the original deco-cx/deco framework. Provides fallback title,
  // description, and templates when page-level seo doesn't supply them.
  const siteSeo = getSiteSeo();

  if (!seoSection) {
    // No page.seo block — use site-wide SEO as primary, section-contributed as secondary
    const merged: PageSeo = { ...sectionSeo };
    if (siteSeo.title && !merged.title) merged.title = siteSeo.title;
    if (siteSeo.description && !merged.description) merged.description = siteSeo.description;
    if (siteSeo.image && !merged.image) merged.image = siteSeo.image;
    return merged;
  }

  // Run the section loader on the seo section if one is registered
  // (e.g., SEOPDP loader transforms {jsonLD: ProductDetailsPage} → {title, description, ...})
  let enrichedProps = seoSection.props;
  try {
    const enriched = await runSingleSectionLoader(seoSection, request);
    if (enriched) enrichedProps = enriched.props;
  } catch {
    // Section loader failed — use the raw resolved props
  }

  const pageSeo = extractSeoFromProps(enrichedProps);

  // Replicate original SeoV2 loader logic: `_title ?? appTitle`
  // When the page's seo block doesn't have a title/description,
  // fall back to the Site app's seo config.
  if (!pageSeo.title && siteSeo.title) pageSeo.title = siteSeo.title;
  if (!pageSeo.description && siteSeo.description) pageSeo.description = siteSeo.description;
  if (!pageSeo.image && siteSeo.image) pageSeo.image = siteSeo.image;

  // Apply title/description templates.
  // Priority: page-level template → site-level template → no-op.
  // This mirrors the original: `(titleTemplate ?? "").trim().length === 0 ? "%s" : titleTemplate`
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

  // Primary source (page.seo) overrides secondary (section-contributed).
  // Only truthy fields in pageSeo override — undefined keys don't clear sectionSeo.
  return { ...sectionSeo, ...pageSeo };
}

/** Returns a non-trivial template string, or undefined for "%s" / empty / blank. */
function effectiveTemplate(tmpl: string | undefined): string | undefined {
  if (!tmpl || tmpl.trim() === "" || tmpl.trim() === "%s") return undefined;
  return tmpl;
}

// ---------------------------------------------------------------------------
// Head metadata builder
// ---------------------------------------------------------------------------

/**
 * Build TanStack Router `head()` metadata from page-level and section-contributed SEO.
 * Emits: title, description, canonical, OG tags, Twitter Card, robots directive.
 */
function buildHead(
  loaderData: CmsPageLoaderData | undefined,
  siteName: string,
  defaultTitle: string,
  defaultDescription?: string,
) {
  const seo = loaderData?.seo;
  const title = seo?.title
    ? seo.title
    : loaderData?.name
      ? `${loaderData.name} | ${siteName}`
      : defaultTitle;
  const description = seo?.description || defaultDescription;
  const image = seo?.image;
  const canonical = seo?.canonical;
  const noIndex = seo?.noIndexing;

  const meta: Record<string, string>[] = [{ title }];

  if (description) {
    meta.push({ name: "description", content: description });
  }

  // Robots
  if (noIndex) {
    meta.push({ name: "robots", content: "noindex, nofollow" });
  }

  // Open Graph
  meta.push({ property: "og:title", content: title });
  if (description) meta.push({ property: "og:description", content: description });
  if (image) meta.push({ property: "og:image", content: image });
  meta.push({ property: "og:type", content: seo?.type || "website" });
  if (canonical) meta.push({ property: "og:url", content: canonical });

  // Twitter Card
  meta.push({ name: "twitter:card", content: image ? "summary_large_image" : "summary" });
  meta.push({ name: "twitter:title", content: title });
  if (description) meta.push({ name: "twitter:description", content: description });
  if (image) meta.push({ name: "twitter:image", content: image });

  const links: Record<string, string>[] = [];
  if (canonical) {
    links.push({ rel: "canonical", href: canonical });
  }

  // JSON-LD structured data — rendered as <script type="application/ld+json"> in <head>
  const scripts: Array<{ type: string; children: string }> = [];
  if (seo?.jsonLDs?.length) {
    for (const jsonLD of seo.jsonLDs) {
      scripts.push({
        type: "application/ld+json",
        children: JSON.stringify(jsonLD),
      });
    }
  }

  return { meta, links, scripts };
}

/**
 * Returns a TanStack Router route config object for a CMS catch-all route.
 * Spread the result into your `createFileRoute("/$")({...})` call.
 *
 * Includes: loaderDeps, loader, headers, head (with full SEO), staleTime/gcTime.
 * Does NOT include: component, notFoundComponent (site provides these).
 *
 * SEO metadata is extracted from sections registered via `registerSeoSections()`.
 * The `head()` function emits title, description, canonical, OG tags, and robots.
 */
export function cmsRouteConfig(options: CmsRouteOptions) {
  const {
    siteName,
    defaultTitle,
    defaultDescription,
    ignoreSearchParams = ["skuId"],
    pendingComponent,
  } = options;

  const ignoreSet = new Set(ignoreSearchParams);

  return {
    loaderDeps: ({ search }: { search: Record<string, string> }) => {
      const filtered = Object.fromEntries(
        Object.entries(search ?? {}).filter(([k]) => !ignoreSet.has(k)),
      );
      return {
        search: Object.keys(filtered).length ? filtered : undefined,
      };
    },

    loader: async ({
      params,
      deps,
    }: {
      params: { _splat?: string };
      deps: { search?: Record<string, string> };
    }) => {
      const basePath = "/" + (params._splat || "");
      const searchStr = deps.search
        ? "?" + new URLSearchParams(deps.search as Record<string, string>).toString()
        : "";
      const page = await loadCmsPage({ data: basePath + searchStr });

      if (!isServer && page?.resolvedSections) {
        const keys = page.resolvedSections.map((s: ResolvedSection) => s.component);
        await preloadSectionComponents(keys);
      }
      return page;
    },

    ...(pendingComponent ? { pendingComponent } : {}),

    ...routeCacheDefaults("product"),

    headers: ({ loaderData }: { loaderData?: CmsPageLoaderData }) => {
      const profile = loaderData?.cacheProfile ?? "listing";
      return cacheHeaders(profile);
    },

    head: ({ loaderData }: { loaderData?: CmsPageLoaderData }) =>
      buildHead(loaderData, siteName, defaultTitle, defaultDescription),
  };
}

/**
 * Returns a TanStack Router route config for the CMS homepage route.
 * Spread into `createFileRoute("/")({...})`.
 *
 * Like `cmsRouteConfig`, emits full SEO head metadata from section-contributed data.
 */
export function cmsHomeRouteConfig(options: {
  defaultTitle: string;
  defaultDescription?: string;
  /** Site name for OG title composition. Defaults to defaultTitle. */
  siteName?: string;
  pendingComponent?: () => any;
}) {
  const { defaultTitle, defaultDescription, siteName } = options;

  return {
    loader: async () => {
      const page = await loadCmsHomePage();
      if (!isServer && page?.resolvedSections) {
        const keys = page.resolvedSections.map((s: ResolvedSection) => s.component);
        await preloadSectionComponents(keys);
      }
      return page;
    },
    ...(options.pendingComponent ? { pendingComponent: options.pendingComponent } : {}),
    ...routeCacheDefaults("static"),
    headers: () => cacheHeaders("static"),
    head: ({ loaderData }: { loaderData?: CmsPageLoaderData }) =>
      buildHead(loaderData, siteName ?? defaultTitle, defaultTitle, defaultDescription),
  };
}
