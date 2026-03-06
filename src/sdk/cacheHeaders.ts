/**
 * Cache-Control header generation for different page types.
 *
 * Produces spec-compliant `Cache-Control` values suitable for CDNs
 * (Cloudflare, Vercel, Fastly) with `s-maxage` and `stale-while-revalidate`.
 *
 * @example
 * ```ts
 * // In a TanStack Start route:
 * import { cacheHeaders, routeCacheDefaults } from "@decocms/start/sdk/cacheHeaders";
 *
 * export const Route = createFileRoute('/products/$slug')({
 *   ...routeCacheDefaults("product"),
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
    maxAge: 120,
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
 *
 * Always includes `Vary: Accept-Encoding` for public responses.
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

  return {
    "Cache-Control": parts.join(", "),
    "Vary": "Accept-Encoding",
  };
}

/**
 * Get the raw config for a named cache profile.
 * Useful when you need the numeric values (e.g. for custom logic).
 */
export function getCacheProfileConfig(profile: CacheProfile): CacheHeadersConfig {
  return PROFILES[profile];
}

// ---------------------------------------------------------------------------
// Client-side route cache defaults (TanStack Router staleTime / gcTime)
// ---------------------------------------------------------------------------

interface RouteCacheDefaults {
  /** How long route data is considered fresh on the client (ms). */
  staleTime: number;
  /** How long stale data is kept in memory before garbage collection (ms). */
  gcTime: number;
}

const ROUTE_CACHE: Record<CacheProfile, RouteCacheDefaults> = {
  static:  { staleTime: 5 * 60_000,  gcTime: 30 * 60_000 },
  product: { staleTime: 60_000,       gcTime: 5 * 60_000  },
  listing: { staleTime: 60_000,       gcTime: 5 * 60_000  },
  search:  { staleTime: 30_000,       gcTime: 2 * 60_000  },
  cart:    { staleTime: 0,            gcTime: 0            },
  private: { staleTime: 0,            gcTime: 0            },
  none:    { staleTime: 0,            gcTime: 0            },
};

/**
 * Returns `{ staleTime, gcTime }` for a cache profile, ready to spread
 * into a TanStack Router route definition.
 *
 * @example
 * ```ts
 * export const Route = createFileRoute("/$")({
 *   ...routeCacheDefaults("listing"),
 *   loader: ...,
 *   headers: () => cacheHeaders("listing"),
 * });
 * ```
 */
export function routeCacheDefaults(
  profile: CacheProfile,
): RouteCacheDefaults {
  return ROUTE_CACHE[profile];
}

// ---------------------------------------------------------------------------
// URL-based cache profile detection
// ---------------------------------------------------------------------------

interface CachePattern {
  test: (pathname: string, searchParams: URLSearchParams) => boolean;
  profile: CacheProfile;
}

const builtinPatterns: CachePattern[] = [
  // Private routes — must be first (highest priority)
  {
    test: (p) =>
      p.startsWith("/cart") ||
      p.startsWith("/checkout") ||
      p.startsWith("/account") ||
      p.startsWith("/login") ||
      p.startsWith("/my-account"),
    profile: "private",
  },
  // Internal / API routes
  {
    test: (p) =>
      p.startsWith("/api/") ||
      p.startsWith("/deco/") ||
      p.startsWith("/_server") ||
      p.startsWith("/_build"),
    profile: "none",
  },
  // Search pages
  {
    test: (p, sp) => p === "/s" || p.startsWith("/s/") || sp.has("q"),
    profile: "search",
  },
  // PDP — VTEX convention: URL ends with /p
  {
    test: (p) => p.endsWith("/p") || /\/p[?#]/.test(p),
    profile: "product",
  },
  // Home page
  {
    test: (p) => p === "/" || p === "",
    profile: "static",
  },
];

const customPatterns: CachePattern[] = [];

/**
 * Register additional URL-to-profile patterns. Custom patterns are evaluated
 * before built-in ones, so they can override defaults.
 *
 * @example
 * ```ts
 * registerCachePattern({
 *   test: (p) => p.startsWith("/institucional"),
 *   profile: "static",
 * });
 * ```
 */
export function registerCachePattern(pattern: CachePattern): void {
  customPatterns.push(pattern);
}

/**
 * Detect the appropriate cache profile based on a URL.
 * Evaluates custom patterns first, then built-in patterns.
 * Falls back to "listing" (conservative public cache) for unmatched paths.
 */
export function detectCacheProfile(
  pathnameOrUrl: string | URL,
): CacheProfile {
  let pathname: string;
  let searchParams: URLSearchParams;

  if (typeof pathnameOrUrl === "string" && !pathnameOrUrl.startsWith("http")) {
    const qIdx = pathnameOrUrl.indexOf("?");
    pathname = qIdx >= 0 ? pathnameOrUrl.slice(0, qIdx) : pathnameOrUrl;
    searchParams = new URLSearchParams(
      qIdx >= 0 ? pathnameOrUrl.slice(qIdx) : "",
    );
  } else {
    const url =
      pathnameOrUrl instanceof URL
        ? pathnameOrUrl
        : new URL(pathnameOrUrl);
    pathname = url.pathname;
    searchParams = url.searchParams;
  }

  for (const pattern of customPatterns) {
    if (pattern.test(pathname, searchParams)) return pattern.profile;
  }
  for (const pattern of builtinPatterns) {
    if (pattern.test(pathname, searchParams)) return pattern.profile;
  }

  // Default: listing (conservative, short edge TTL)
  return "listing";
}
