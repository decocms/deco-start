/**
 * URL utility functions.
 *
 * Handles UTM parameter stripping for cache-friendly URLs,
 * canonical URL generation, and other URL manipulation.
 */

const UTM_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utmi_campaign",
  "utmi_page",
  "utmi_part",
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "twclid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "ttclid",
  "srsltid",
]);

/**
 * Strip UTM and tracking parameters from a URL.
 *
 * Used to normalize URLs for caching -- two requests that differ
 * only in UTM params should hit the same cache entry.
 *
 * @example
 * ```ts
 * stripTrackingParams("https://example.com/shoes?color=red&utm_source=google")
 * // => "https://example.com/shoes?color=red"
 * ```
 */
export function stripTrackingParams(urlString: string): string {
  try {
    const url = new URL(urlString);
    let changed = false;

    for (const param of [...url.searchParams.keys()]) {
      if (UTM_PARAMS.has(param.toLowerCase())) {
        url.searchParams.delete(param);
        changed = true;
      }
    }

    return changed ? url.toString() : urlString;
  } catch {
    return urlString;
  }
}

/**
 * Strip tracking params from a URL and return just the pathname + non-UTM search.
 * Useful for cache key generation.
 */
export function cleanPathForCacheKey(urlString: string): string {
  try {
    const url = new URL(urlString);

    for (const param of [...url.searchParams.keys()]) {
      if (UTM_PARAMS.has(param.toLowerCase())) {
        url.searchParams.delete(param);
      }
    }

    const search = url.searchParams.toString();
    return search ? `${url.pathname}?${search}` : url.pathname;
  } catch {
    return urlString;
  }
}

/**
 * Build a canonical URL from a request, stripping tracking params
 * and normalizing the protocol/host.
 *
 * @param request - The incoming request
 * @param baseUrl - Override origin (useful when behind a proxy)
 */
export function canonicalUrl(request: Request, baseUrl?: string): string {
  const url = new URL(request.url);
  const origin = baseUrl ?? url.origin;

  for (const param of [...url.searchParams.keys()]) {
    if (UTM_PARAMS.has(param.toLowerCase())) {
      url.searchParams.delete(param);
    }
  }

  const search = url.searchParams.toString();
  const path = search ? `${url.pathname}?${search}` : url.pathname;

  return `${origin}${path}`;
}

/**
 * Check if a URL has any tracking/UTM parameters.
 */
export function hasTrackingParams(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    for (const param of url.searchParams.keys()) {
      if (UTM_PARAMS.has(param.toLowerCase())) return true;
    }
    return false;
  } catch {
    return false;
  }
}
