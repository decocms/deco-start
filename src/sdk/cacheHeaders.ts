/**
 * Cache-Control header generation for different page types.
 *
 * Produces spec-compliant `Cache-Control` values suitable for CDNs
 * (Cloudflare, Vercel, Fastly) with `s-maxage` and `stale-while-revalidate`.
 *
 * @example
 * ```ts
 * // In a TanStack Start route:
 * import { cacheHeaders } from "@decocms/start/sdk/cacheHeaders";
 *
 * export const Route = createFileRoute('/products/$slug')({
 *   headers: () => cacheHeaders("product"),
 * });
 * ```
 */

export type CacheProfile =
  | "static"
  | "product"
  | "listing"
  | "search"
  | "cart"
  | "private"
  | "none";

export interface CacheHeadersConfig {
  /** Browser max-age in seconds. */
  maxAge: number;
  /** CDN/edge max-age in seconds. */
  sMaxAge: number;
  /** Stale-while-revalidate window in seconds. */
  staleWhileRevalidate: number;
  /** Whether the response is public (cacheable by CDN). */
  isPublic: boolean;
}

const PROFILES: Record<CacheProfile, CacheHeadersConfig> = {
  static: {
    maxAge: 3600,
    sMaxAge: 86400,
    staleWhileRevalidate: 86400,
    isPublic: true,
  },
  product: {
    maxAge: 60,
    sMaxAge: 300,
    staleWhileRevalidate: 3600,
    isPublic: true,
  },
  listing: {
    maxAge: 30,
    sMaxAge: 120,
    staleWhileRevalidate: 600,
    isPublic: true,
  },
  search: {
    maxAge: 0,
    sMaxAge: 60,
    staleWhileRevalidate: 300,
    isPublic: true,
  },
  cart: {
    maxAge: 0,
    sMaxAge: 0,
    staleWhileRevalidate: 0,
    isPublic: false,
  },
  private: {
    maxAge: 0,
    sMaxAge: 0,
    staleWhileRevalidate: 0,
    isPublic: false,
  },
  none: {
    maxAge: 0,
    sMaxAge: 0,
    staleWhileRevalidate: 0,
    isPublic: false,
  },
};

/**
 * Generate a `Cache-Control` header value from a named profile or custom config.
 * Returns a headers object ready to spread into route `headers()`.
 */
export function cacheHeaders(
  profileOrConfig: CacheProfile | CacheHeadersConfig,
): Record<string, string> {
  const config =
    typeof profileOrConfig === "string"
      ? PROFILES[profileOrConfig]
      : profileOrConfig;

  if (!config.isPublic || (config.sMaxAge === 0 && config.maxAge === 0)) {
    return {
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
    };
  }

  const parts: string[] = ["public"];

  if (config.maxAge > 0) {
    parts.push(`max-age=${config.maxAge}`);
  } else {
    parts.push("max-age=0");
  }

  if (config.sMaxAge > 0) {
    parts.push(`s-maxage=${config.sMaxAge}`);
  }

  if (config.staleWhileRevalidate > 0) {
    parts.push(`stale-while-revalidate=${config.staleWhileRevalidate}`);
  }

  return { "Cache-Control": parts.join(", ") };
}

/**
 * Detect the appropriate cache profile based on a URL pathname.
 * Sites can override this with their own logic.
 */
export function detectCacheProfile(pathname: string): CacheProfile {
  if (pathname.startsWith("/api/") || pathname.startsWith("/deco/")) return "none";
  if (pathname.includes("/cart") || pathname.includes("/checkout")) return "cart";
  if (pathname.includes("/search") || pathname.includes("/s?")) return "search";
  return "static";
}
