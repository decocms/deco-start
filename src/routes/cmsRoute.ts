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
import type { DeferredSection, MatcherContext, ResolvedSection } from "../cms/resolve";
import { resolveDecoPage, resolveDeferredSection } from "../cms/resolve";
import { runSectionLoaders, runSingleSectionLoader } from "../cms/sectionLoaders";
import {
  type CacheProfile,
  cacheHeaders,
  detectCacheProfile,
  routeCacheDefaults,
} from "../sdk/cacheHeaders";
import { normalizeUrlsInObject } from "../sdk/normalizeUrls";

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

  const matcherCtx: MatcherContext = {
    userAgent: getRequestHeader("user-agent") ?? "",
    url: urlWithSearch,
    path: basePath,
    cookies: getCookies(),
  };
  const page = await resolveDecoPage(basePath, matcherCtx);
  if (!page) return null;

  const request = new Request(urlWithSearch, {
    headers: getRequest().headers,
  });
  const enrichedSections = await runSectionLoaders(page.resolvedSections, request);

  // Pre-import eager section modules so their default exports are cached
  // in resolvedComponents. This ensures SSR renders with direct component
  // refs, and the client hydration can skip React.lazy/Suspense.
  const eagerKeys = enrichedSections.map((s) => s.component);
  await preloadSectionComponents(eagerKeys);

  const cacheProfile = detectCacheProfile(basePath);
  return {
    ...page,
    resolvedSections: normalizeUrlsInObject(enrichedSections),
    deferredSections: normalizeUrlsInObject(page.deferredSections),
    cacheProfile,
    pageUrl: urlWithSearch,
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
  const matcherCtx: MatcherContext = {
    userAgent: getRequestHeader("user-agent") ?? "",
    url: getRequestUrl().toString(),
    path: "/",
    cookies: getCookies(),
  };
  const page = await resolveDecoPage("/", matcherCtx);
  if (!page) return null;

  const request = getRequest();
  const enrichedSections = await runSectionLoaders(page.resolvedSections, request);

  const eagerKeys = enrichedSections.map((s) => s.component);
  await preloadSectionComponents(eagerKeys);

  return {
    ...page,
    resolvedSections: normalizeUrlsInObject(enrichedSections),
    deferredSections: normalizeUrlsInObject(page.deferredSections),
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

    const serverUrl = getRequestUrl().toString();
    const matcherCtx: MatcherContext = {
      userAgent: getRequestHeader("user-agent") ?? "",
      url: pageUrl || serverUrl,
      path: pagePath,
      cookies: getCookies(),
    };

    const section = await resolveDeferredSection(component, rawProps, pagePath, matcherCtx);
    if (!section) return null;

    const request = new Request(pageUrl || serverUrl, {
      headers: getRequest().headers,
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
  /**
   * Search params to exclude from loader deps.
   * These params won't trigger a server re-fetch when they change.
   * Defaults to `["skuId"]` — variant selection is client-side only.
   */
  ignoreSearchParams?: string[];
  /** Custom pending component shown during SPA navigation. */
  pendingComponent?: () => any;
}

/**
 * Returns a TanStack Router route config object for a CMS catch-all route.
 * Spread the result into your `createFileRoute("/$")({...})` call.
 *
 * Includes: loaderDeps, loader, headers, head, staleTime/gcTime.
 * Does NOT include: component, notFoundComponent (site provides these).
 */
export function cmsRouteConfig(options: CmsRouteOptions) {
  const { siteName, defaultTitle, ignoreSearchParams = ["skuId"], pendingComponent } = options;

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

      // On the client (SPA navigation or initial hydration), pre-import
      // eager section modules BEFORE React renders. This ensures
      // getResolvedComponent() returns a value and we skip React.lazy.
      if (!isServer && page?.resolvedSections) {
        const keys = page.resolvedSections.map((s: ResolvedSection) => s.component);
        await preloadSectionComponents(keys);
      }
      return page;
    },

    ...(pendingComponent ? { pendingComponent } : {}),

    ...routeCacheDefaults("product"),

    headers: ({ loaderData }: { loaderData?: { cacheProfile?: CacheProfile } }) => {
      const profile = loaderData?.cacheProfile ?? "listing";
      return cacheHeaders(profile);
    },

    head: ({ loaderData }: { loaderData?: { name?: string } }) => ({
      meta: [
        {
          title: loaderData?.name ? `${loaderData.name} | ${siteName}` : defaultTitle,
        },
      ],
    }),
  };
}

/**
 * Returns a TanStack Router route config for the CMS homepage route.
 * Spread into `createFileRoute("/")({...})`.
 */
export function cmsHomeRouteConfig(options: {
  defaultTitle: string;
  pendingComponent?: () => any;
}) {
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
    head: () => ({
      meta: [{ title: options.defaultTitle }],
    }),
  };
}
