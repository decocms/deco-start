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
