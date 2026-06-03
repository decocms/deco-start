/**
 * Loader utilities — small helpers for reading request-derived data inside
 * `@decocms/apps` loaders that receive only `(props)` (no `Request`).
 *
 * The framework injects `__pageUrl` and `__pagePath` into every loader's
 * props (see `src/cms/resolve.ts` commerce-loader branch and
 * `src/cms/sectionLoaders.ts` `injectPageContext`). Loaders that need URL
 * search params (skuId, q, page, sort, filters) read them from `__pageUrl`
 * via the helpers here.
 *
 * Design constraint: we intentionally do NOT auto-merge URL search params
 * into the top-level props object. The section/loader cache layer
 * (`cacheableSections` in `sectionLoaders.ts`) hashes the props to derive
 * a cache key, so injecting query params into props would fragment cache
 * entries per query-param value — breaking URL-agnostic cache reuse
 * across pages.
 */

/**
 * Read a single query-string value from a loader's props by parsing the
 * `__pageUrl` the framework injects.
 *
 * Returns `null` when the param is absent, when `__pageUrl` is undefined,
 * or when the URL fails to parse — never throws.
 *
 * @example
 *   const skuId = props.skuId ?? getSearchParam(props, "skuId");
 */
export function getSearchParam(
  props: { __pageUrl?: string } & Record<string, unknown>,
  key: string,
): string | null {
  if (!props.__pageUrl) return null;
  try {
    return new URL(props.__pageUrl).searchParams.get(key);
  } catch {
    return null;
  }
}

/**
 * Read every query-string value as a plain object. Useful for loaders that
 * want to forward a curated subset of params to a downstream API call.
 *
 * Returns an empty object when `__pageUrl` is missing or unparseable.
 * Repeated keys collapse to the last value (matches `Object.fromEntries`
 * on `URLSearchParams.entries()`). For duplicate-aware reads, prefer
 * parsing `props.__pageUrl` directly.
 */
export function getSearchParams(
  props: { __pageUrl?: string } & Record<string, unknown>,
): Record<string, string> {
  if (!props.__pageUrl) return {};
  try {
    return Object.fromEntries(new URL(props.__pageUrl).searchParams.entries());
  } catch {
    return {};
  }
}
