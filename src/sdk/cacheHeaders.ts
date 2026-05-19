/**
 * Unified cache profile system for Deco storefronts.
 *
 * Each named profile (product, listing, search, static, etc.) defines cache
 * timing across ALL layers — edge, browser, loader, and client — in a single
 * object. This is the single source of truth for cache configuration.
 *
 * Sites override specific values via `setCacheProfile()` without touching
 * framework code. Derivation functions (`cacheHeaders`, `routeCacheDefaults`,
 * `loaderCacheOptions`, `edgeCacheConfig`) read from the profiles.
 *
 * @example
 * ```ts
 * // Site-level override (src/cache-config.ts):
 * import { setCacheProfile } from "@decocms/start/sdk/cacheHeaders";
 * setCacheProfile("product", { edge: { fresh: 600 } }); // 10min instead of 5min
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CacheProfileName =
  | "static"
  | "product"
  | "listing"
  | "search"
  | "cart"
  | "private"
  | "none";

/** Time windows for a single caching layer (in seconds). */
export interface CacheTimingWindow {
  /** How long content is considered fresh — served without origin contact. */
  fresh: number;
  /** After fresh expires, serve stale while refreshing in background. */
  swr: number;
  /** After fresh expires and origin is erroring, serve stale for this long. */
  sie: number;
}

/** Unified cache profile covering all layers. */
export interface CacheProfileConfig {
  /** Edge / CDN layer (Cloudflare Cache API). Times in seconds. */
  edge: CacheTimingWindow;
  /** Browser layer (Cache-Control header). Times in seconds. */
  browser: CacheTimingWindow;
  /** In-memory loader layer. Times in milliseconds. */
  loader: {
    fresh: number;
    sie: number;
  };
  /** Client-side TanStack Router. Times in milliseconds. */
  client: {
    staleTime: number;
    gcTime: number;
  };
  /** Whether CDN can cache this profile. False = private, never cached. */
  isPublic: boolean;
}

/**
 * Deep partial of CacheProfileConfig for site-level overrides.
 * Only the fields you specify are merged; everything else keeps its default.
 */
export type CacheProfileOverrides = {
  [K in keyof CacheProfileConfig]?: CacheProfileConfig[K] extends object
    ? Partial<CacheProfileConfig[K]>
    : CacheProfileConfig[K];
};

// ---------------------------------------------------------------------------
// Default profiles
// ---------------------------------------------------------------------------

const PROFILES: Record<CacheProfileName, CacheProfileConfig> = {
  static: {
    edge: { fresh: 900, swr: 7200, sie: 21600 },
    browser: { fresh: 120, swr: 1800, sie: 7200 },
    loader: { fresh: 300_000, sie: 1_800_000 },
    client: { staleTime: 300_000, gcTime: 1_800_000 },
    isPublic: true,
  },
  product: {
    edge: { fresh: 300, swr: 1800, sie: 7200 },
    browser: { fresh: 60, swr: 600, sie: 3600 },
    loader: { fresh: 30_000, sie: 600_000 },
    client: { staleTime: 60_000, gcTime: 300_000 },
    isPublic: true,
  },
  listing: {
    edge: { fresh: 120, swr: 900, sie: 3600 },
    browser: { fresh: 30, swr: 300, sie: 1800 },
    loader: { fresh: 60_000, sie: 300_000 },
    client: { staleTime: 60_000, gcTime: 300_000 },
    isPublic: true,
  },
  search: {
    edge: { fresh: 60, swr: 300, sie: 1800 },
    browser: { fresh: 0, swr: 120, sie: 600 },
    loader: { fresh: 60_000, sie: 180_000 },
    client: { staleTime: 30_000, gcTime: 120_000 },
    isPublic: true,
  },
  cart: {
    edge: { fresh: 0, swr: 0, sie: 0 },
    browser: { fresh: 0, swr: 0, sie: 0 },
    loader: { fresh: 0, sie: 0 },
    client: { staleTime: 0, gcTime: 0 },
    isPublic: false,
  },
  private: {
    edge: { fresh: 0, swr: 0, sie: 0 },
    browser: { fresh: 0, swr: 0, sie: 0 },
    loader: { fresh: 0, sie: 0 },
    client: { staleTime: 0, gcTime: 0 },
    isPublic: false,
  },
  none: {
    edge: { fresh: 0, swr: 0, sie: 0 },
    browser: { fresh: 0, swr: 0, sie: 0 },
    loader: { fresh: 0, sie: 0 },
    client: { staleTime: 0, gcTime: 0 },
    isPublic: false,
  },
};

// ---------------------------------------------------------------------------
// Profile accessors
// ---------------------------------------------------------------------------

export function getCacheProfile(profile: CacheProfileName): CacheProfileConfig {
  return PROFILES[profile];
}

/**
 * Override specific values of a cache profile. Only the fields you specify
 * are merged; everything else keeps its default.
 *
 * @example
 * ```ts
 * setCacheProfile("product", { edge: { fresh: 600 } });
 * setCacheProfile("static", { loader: { sie: 3_600_000 } });
 * ```
 */
export function setCacheProfile(
  profile: CacheProfileName,
  overrides: CacheProfileOverrides,
): void {
  const current = PROFILES[profile];
  PROFILES[profile] = {
    edge: { ...current.edge, ...overrides.edge },
    browser: { ...current.browser, ...overrides.browser },
    loader: { ...current.loader, ...overrides.loader },
    client: { ...current.client, ...overrides.client },
    isPublic: overrides.isPublic ?? current.isPublic,
  };
}

// ---------------------------------------------------------------------------
// Derivation: Cache-Control headers (browser layer)
// ---------------------------------------------------------------------------

/**
 * Generate a `Cache-Control` header from a named profile.
 * Returns a headers object ready to spread into route `headers()`.
 */
export function cacheHeaders(profile: CacheProfileName): Record<string, string> {
  const p = PROFILES[profile];

  if (!p.isPublic || (p.edge.fresh === 0 && p.browser.fresh === 0)) {
    return {
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
    };
  }

  const parts: string[] = ["public"];
  parts.push(p.browser.fresh > 0 ? `max-age=${p.browser.fresh}` : "max-age=0");
  if (p.edge.fresh > 0) parts.push(`s-maxage=${p.edge.fresh}`);
  if (p.browser.swr > 0) parts.push(`stale-while-revalidate=${p.browser.swr}`);
  if (p.browser.sie > 0) parts.push(`stale-if-error=${p.browser.sie}`);

  return {
    "Cache-Control": parts.join(", "),
    Vary: "Accept-Encoding",
  };
}

// ---------------------------------------------------------------------------
// Derivation: Edge cache config (for workerEntry SWR/SIE logic)
// ---------------------------------------------------------------------------

export interface EdgeCacheConfig {
  fresh: number;
  swr: number;
  sie: number;
  isPublic: boolean;
}

export function edgeCacheConfig(profile: CacheProfileName): EdgeCacheConfig {
  const p = PROFILES[profile];
  return { ...p.edge, isPublic: p.isPublic };
}

// ---------------------------------------------------------------------------
// Derivation: Client-side route cache defaults (TanStack Router)
// ---------------------------------------------------------------------------

/**
 * Returns `{ staleTime, gcTime }` for a cache profile, ready to spread
 * into a TanStack Router route definition.
 *
 * In dev mode, uses short staleTime (5s) to keep data fresh enough for
 * development while avoiding redundant re-fetches.
 */
export function routeCacheDefaults(profile: CacheProfileName): { staleTime: number; gcTime: number } {
  const env = typeof globalThis.process !== "undefined" ? globalThis.process.env : undefined;
  const isDev = env?.DECO_CACHE_DISABLE === "true" || env?.NODE_ENV === "development";
  if (isDev) return { staleTime: 5_000, gcTime: 30_000 };
  return { ...PROFILES[profile].client };
}

// ---------------------------------------------------------------------------
// Derivation: Loader cache options (for createCachedLoader)
// ---------------------------------------------------------------------------

export interface LoaderCacheOptions {
  policy: "stale-while-revalidate";
  maxAge: number;
  staleIfError: number;
}

/**
 * Get loader-layer cache options for a profile.
 * Pass directly to `createCachedLoader` as the options argument.
 */
export function loaderCacheOptions(profile: CacheProfileName): LoaderCacheOptions {
  const p = PROFILES[profile];
  return {
    policy: "stale-while-revalidate",
    maxAge: p.loader.fresh,
    staleIfError: p.loader.sie,
  };
}

// ---------------------------------------------------------------------------
// URL-based cache profile detection
// ---------------------------------------------------------------------------

interface CachePattern {
  test: (pathname: string, searchParams: URLSearchParams) => boolean;
  profile: CacheProfileName;
}

const builtinPatterns: CachePattern[] = [
  {
    test: (p) =>
      p.startsWith("/cart") ||
      p.startsWith("/checkout") ||
      p.startsWith("/account") ||
      p.startsWith("/login") ||
      p.startsWith("/my-account"),
    profile: "private",
  },
  {
    test: (p) =>
      p.startsWith("/api/") ||
      p.startsWith("/deco/") ||
      p.startsWith("/_build"),
    profile: "none",
  },
  {
    test: (p, sp) => p === "/s" || p.startsWith("/s/") || sp.has("q"),
    profile: "search",
  },
  {
    test: (p) => p.endsWith("/p") || /\/p[?#]/.test(p),
    profile: "product",
  },
  {
    test: (p) => p === "/" || p === "",
    profile: "static",
  },
];

const customPatterns: CachePattern[] = [];

/**
 * Register additional URL-to-profile patterns. Custom patterns are evaluated
 * before built-in ones, so they can override defaults.
 */
export function registerCachePattern(pattern: CachePattern): void {
  customPatterns.push(pattern);
}

/**
 * Detect the appropriate cache profile based on a URL.
 * Evaluates custom patterns first, then built-in patterns.
 * Falls back to "listing" for unmatched paths.
 */
export function detectCacheProfile(pathnameOrUrl: string | URL): CacheProfileName {
  let pathname: string;
  let searchParams: URLSearchParams;

  if (typeof pathnameOrUrl === "string" && !pathnameOrUrl.startsWith("http")) {
    const qIdx = pathnameOrUrl.indexOf("?");
    pathname = qIdx >= 0 ? pathnameOrUrl.slice(0, qIdx) : pathnameOrUrl;
    searchParams = new URLSearchParams(qIdx >= 0 ? pathnameOrUrl.slice(qIdx) : "");
  } else {
    const url = pathnameOrUrl instanceof URL ? pathnameOrUrl : new URL(pathnameOrUrl);
    pathname = url.pathname;
    searchParams = url.searchParams;
  }

  for (const pattern of customPatterns) {
    if (pattern.test(pathname, searchParams)) return pattern.profile;
  }
  for (const pattern of builtinPatterns) {
    if (pattern.test(pathname, searchParams)) return pattern.profile;
  }

  return "listing";
}
