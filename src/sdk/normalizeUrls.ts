/**
 * URL normalization for CMS-resolved props.
 *
 * Strips registered production origins from absolute URLs, converting them to
 * relative paths. This allows staging/preview deployments to work without
 * every CMS-authored link sending users to the production domain.
 *
 * Only affects strings that START with a registered origin + "/" — image CDN
 * URLs, API endpoints on different domains, and non-URL strings are untouched.
 *
 * @example
 * ```ts
 * // In site's setup.ts:
 * import { registerProductionOrigins } from "@decocms/start/sdk/normalizeUrls";
 * registerProductionOrigins([
 *   "https://www.casaevideo.com.br",
 *   "https://casaevideo.com.br",
 * ]);
 * ```
 */

let origins: string[] = [];

/**
 * Register production origins that should be stripped from CMS-resolved URLs.
 * Call once in your site's setup.ts before any page loads.
 */
export function registerProductionOrigins(productionOrigins: string[]) {
  origins = productionOrigins.map((o) => o.replace(/\/+$/, ""));
}

export function getProductionOrigins(): readonly string[] {
  return origins;
}

function normalizeString(str: string): string {
  for (const origin of origins) {
    if (str.startsWith(origin + "/")) {
      return str.slice(origin.length);
    }
    if (str === origin) {
      return "/";
    }
  }
  return str;
}

/**
 * Deep-walk an object tree and rewrite any string value that starts with a
 * registered production origin to a relative path. Returns the same reference
 * if nothing was changed (structural sharing).
 */
export function normalizeUrlsInObject<T>(obj: T): T {
  if (!origins.length) return obj;
  return deepNormalize(obj) as T;
}

function deepNormalize(val: unknown): unknown {
  if (val == null) return val;

  if (typeof val === "string") {
    return normalizeString(val);
  }

  if (Array.isArray(val)) {
    let changed = false;
    const result = val.map((item) => {
      const normalized = deepNormalize(item);
      if (normalized !== item) changed = true;
      return normalized;
    });
    return changed ? result : val;
  }

  if (typeof val === "object") {
    // Skip React elements, Dates, RegExps, and other non-plain objects
    const proto = Object.getPrototypeOf(val);
    if (proto !== Object.prototype && proto !== null) return val;

    let changed = false;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(val as Record<string, unknown>)) {
      const normalized = deepNormalize(value);
      result[key] = normalized;
      if (normalized !== value) changed = true;
    }
    return changed ? result : val;
  }

  return val;
}
