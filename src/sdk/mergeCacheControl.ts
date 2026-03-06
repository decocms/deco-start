/**
 * Cache-Control merge utility.
 *
 * When a page makes multiple backend calls with different cache lifetimes,
 * the final page response must use the most restrictive (shortest) cache
 * values. This utility merges multiple Cache-Control headers following
 * the "most restrictive wins" strategy.
 *
 * @example
 * ```ts
 * import { mergeCacheControl } from "@decocms/start/sdk/mergeCacheControl";
 *
 * // Product loader returns 60s, mega menu returns 3600s
 * const merged = mergeCacheControl([
 *   "public, s-maxage=60, stale-while-revalidate=300",
 *   "public, s-maxage=3600, stale-while-revalidate=86400",
 * ]);
 * // => "public, s-maxage=60, stale-while-revalidate=300"
 * ```
 */

interface ParsedCacheControl {
  isPublic: boolean;
  isPrivate: boolean;
  noCache: boolean;
  noStore: boolean;
  maxAge?: number;
  sMaxAge?: number;
  staleWhileRevalidate?: number;
  staleIfError?: number;
  mustRevalidate: boolean;
}

function safeParseInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parse(header: string): ParsedCacheControl {
  const directives = header
    .split(",")
    .map((d) => d.trim().toLowerCase());

  const result: ParsedCacheControl = {
    isPublic: false,
    isPrivate: false,
    noCache: false,
    noStore: false,
    mustRevalidate: false,
  };

  for (const directive of directives) {
    if (directive === "public") result.isPublic = true;
    else if (directive === "private") result.isPrivate = true;
    else if (directive === "no-cache") result.noCache = true;
    else if (directive === "no-store") result.noStore = true;
    else if (directive === "must-revalidate") result.mustRevalidate = true;
    else if (directive.startsWith("max-age=")) {
      result.maxAge = safeParseInt(directive.split("=")[1]);
    } else if (directive.startsWith("s-maxage=")) {
      result.sMaxAge = safeParseInt(directive.split("=")[1]);
    } else if (directive.startsWith("stale-while-revalidate=")) {
      result.staleWhileRevalidate = safeParseInt(directive.split("=")[1]);
    } else if (directive.startsWith("stale-if-error=")) {
      result.staleIfError = safeParseInt(directive.split("=")[1]);
    }
  }

  return result;
}

function minDefined(...values: (number | undefined)[]): number | undefined {
  const defined = values.filter((v): v is number => v != null);
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

/**
 * Merge multiple Cache-Control headers using "most restrictive wins".
 *
 * - If any header is `private`, the result is `private`
 * - If any header has `no-store`, the result has `no-store`
 * - Numeric values (max-age, s-maxage, swr) use the minimum
 */
export function mergeCacheControl(headers: string[]): string {
  if (headers.length === 0) return "public, s-maxage=0";
  if (headers.length === 1) return headers[0];

  const parsed = headers.map(parse);

  const anyPrivate = parsed.some((p) => p.isPrivate);
  const anyNoStore = parsed.some((p) => p.noStore);
  const anyNoCache = parsed.some((p) => p.noCache);
  const anyMustRevalidate = parsed.some((p) => p.mustRevalidate);

  if (anyNoStore) {
    return "private, no-cache, no-store, must-revalidate";
  }

  if (anyPrivate) {
    const maxAge = minDefined(...parsed.map((p) => p.maxAge));
    const parts = ["private"];
    if (anyNoCache) parts.push("no-cache");
    if (maxAge != null) parts.push(`max-age=${maxAge}`);
    if (anyMustRevalidate) parts.push("must-revalidate");
    return parts.join(", ");
  }

  const maxAge = minDefined(...parsed.map((p) => p.maxAge));
  const sMaxAge = minDefined(...parsed.map((p) => p.sMaxAge));
  const swr = minDefined(...parsed.map((p) => p.staleWhileRevalidate));
  const sie = minDefined(...parsed.map((p) => p.staleIfError));

  const parts: string[] = ["public"];
  if (maxAge != null) parts.push(`max-age=${maxAge}`);
  if (sMaxAge != null) parts.push(`s-maxage=${sMaxAge}`);
  if (swr != null) parts.push(`stale-while-revalidate=${swr}`);
  if (sie != null) parts.push(`stale-if-error=${sie}`);
  if (anyMustRevalidate) parts.push("must-revalidate");

  return parts.join(", ");
}

/**
 * Accumulator for collecting cache control headers across loaders.
 *
 * Use in middleware to collect headers from each loader call and
 * compute the final merged header at the end.
 *
 * @example
 * ```ts
 * const collector = createCacheControlCollector();
 * collector.add("public, s-maxage=60");
 * collector.add("public, s-maxage=3600");
 * response.headers.set("Cache-Control", collector.result());
 * // => "public, s-maxage=60"
 * ```
 */
export function createCacheControlCollector() {
  const headers: string[] = [];
  return {
    add(header: string) {
      headers.push(header);
    },
    result(): string {
      return mergeCacheControl(headers);
    },
    get count() {
      return headers.length;
    },
  };
}
