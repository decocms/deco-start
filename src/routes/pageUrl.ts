/**
 * Derive the real page URL for a CMS page load.
 *
 * On client-side (SPA) navigation the CMS server function runs at a
 * `/_serverFn/<hash>?payload=...` URL — that's what `getRequestUrl()` returns,
 * and it is NOT the page the router is navigating to. In that case we rebuild
 * the URL from `fullPath` (the page's path + search). On a real page request
 * (SSR / full reload) the server URL's path equals the page path, and we prefer
 * it because it preserves duplicate query params (e.g.
 * `filter.category-1=a&filter.category-1=b`) that the TanStack Router search
 * object — a plain `Record<string,string>` — would collapse.
 *
 * Keeping the derived `__pageUrl` consistent with `__pagePath` is what makes
 * URL/slug-keyed loaders resolve identically on SSR and SPA navigation (#280).
 * The previous logic compared with `startsWith` and fell back to the serverFn
 * URL when `fullPath` had no query string, leaking `/_serverFn/...` into
 * `matcherCtx.url` on client nav.
 *
 * @param fullPath  page path + optional search, e.g. `/c/shoes?q=foo`
 * @param serverUrl URL returned by `getRequestUrl()` (real page URL on SSR,
 *                  `/_serverFn/...` on client nav)
 */
export function derivePageUrl(fullPath: string, serverUrl: URL): string {
  const [basePath] = fullPath.split("?");
  // Trust the server URL (to keep duplicate query params) only when its path
  // IS the page being loaded — i.e. a real page request. On client nav the
  // path is `/_serverFn/...`, so we rebuild from `fullPath` instead.
  return serverUrl.pathname === basePath && serverUrl.search
    ? serverUrl.toString()
    : new URL(fullPath, serverUrl.origin).toString();
}

/**
 * True when the page load came from a client-side (SPA) navigation via
 * TanStack `<Link>`: the CMS server function runs at `/_serverFn/<hash>`, so
 * `serverUrl.pathname` is NOT the page path. On a real document request (SSR /
 * full reload, including bots) `serverUrl.pathname === basePath`.
 *
 * Section deferral is a streaming-SSR optimization (shrinks the initial HTML /
 * TTFB). On a client navigation the server fn returns JSON in one shot — there
 * is no streaming benefit, so deferral only adds a round-trip and a skeleton.
 * Callers use this to resolve all sections eagerly on SPA navigation.
 *
 * Mirrors the `serverUrl.pathname === basePath` comparison `derivePageUrl`
 * already relies on, so the two stay consistent and we avoid hardcoding the
 * internal `/_serverFn` path.
 *
 * @param fullPath  page path + optional search, e.g. `/c/shoes?q=foo`
 * @param serverUrl URL returned by `getRequestUrl()`
 */
export function isClientNavigation(fullPath: string, serverUrl: URL): boolean {
  const [basePath] = fullPath.split("?");
  return serverUrl.pathname !== basePath;
}
