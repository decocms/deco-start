/**
 * Server-side loader caching with stale-while-revalidate + stale-if-error.
 *
 * Provides an in-memory cache layer for commerce loaders during SSR.
 * Supports:
 * - Single-flight dedup (identical concurrent requests share one fetch)
 * - SWR: serve stale immediately, refresh in background
 * - SIE: on origin error, fall back to stale entry within a configurable window
 *
 * Can be configured with explicit options or by passing a cache profile name
 * (e.g. "product") which derives timing from the unified profile system.
 */

import type { CacheProfileName } from "./cacheHeaders";

export type CachePolicy = "no-store" | "no-cache" | "stale-while-revalidate";

export interface CachedLoaderOptions {
  policy: CachePolicy;
  /** Max age in milliseconds before an entry is considered stale. Default: 60_000 (1 min). */
  maxAge?: number;
  /** How long to serve stale on origin error, in ms. Default: 0 (no error fallback). */
  staleIfError?: number;
  /** Key function to generate a cache key from loader props. Default: JSON.stringify. */
  keyFn?: (props: unknown) => string;
}

export interface LoaderModule<TProps = any, TResult = any> {
  default: (props: TProps) => Promise<TResult>;
  cache?: CachePolicy | { maxAge: number };
  cacheKey?: (props: TProps) => string | null;
}

interface CacheEntry<T = unknown> {
  value: T;
  createdAt: number;
  refreshing: boolean;
}

const DEFAULT_MAX_AGE = 60_000;
const MAX_CACHE_ENTRIES = 500;

const cache = new Map<string, CacheEntry>();

function evictIfNeeded() {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const oldest = [...cache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  const toDelete = oldest.slice(0, cache.size - MAX_CACHE_ENTRIES);
  for (const [key] of toDelete) cache.delete(key);
}

const inflightRequests = new Map<string, Promise<unknown>>();

function resolveOptions(
  optionsOrProfile: CachedLoaderOptions | CacheProfileName,
): CachedLoaderOptions {
  if (typeof optionsOrProfile === "string") {
    // Lazy import to avoid circular dependency at module load time.
    // loaderCacheOptions() reads from the PROFILES map in cacheHeaders.ts.
    const { loaderCacheOptions } = require("./cacheHeaders") as typeof import("./cacheHeaders");
    return loaderCacheOptions(optionsOrProfile);
  }
  return optionsOrProfile;
}

/**
 * Wraps a loader function with server-side caching, single-flight dedup,
 * and stale-if-error resilience.
 *
 * Accepts either explicit options or a cache profile name:
 *
 * @example
 * ```ts
 * // Profile-driven (recommended):
 * const cachedPDP = createCachedLoader("vtex/productDetailsPage", pdpLoader, "product");
 *
 * // Explicit options (when loader needs different timing than its profile):
 * const cachedSuggestions = createCachedLoader("vtex/suggestions", suggestionsLoader, {
 *   policy: "stale-while-revalidate",
 *   maxAge: 120_000,
 *   staleIfError: 300_000,
 * });
 * ```
 */
export function createCachedLoader<TProps, TResult>(
  name: string,
  loaderFn: (props: TProps) => Promise<TResult>,
  optionsOrProfile: CachedLoaderOptions | CacheProfileName,
): (props: TProps) => Promise<TResult> {
  const resolved = resolveOptions(optionsOrProfile);
  const {
    policy,
    maxAge = DEFAULT_MAX_AGE,
    staleIfError = 0,
    keyFn = JSON.stringify,
  } = resolved;

  const env = typeof globalThis.process !== "undefined" ? globalThis.process.env : undefined;
  const isDev = env?.DECO_CACHE_DISABLE === "true" || env?.NODE_ENV === "development";

  if (policy === "no-store") return loaderFn;

  return async (props: TProps): Promise<TResult> => {
    const cacheKey = `${name}::${keyFn(props)}`;

    const inflight = inflightRequests.get(cacheKey);
    if (inflight) return inflight as Promise<TResult>;

    if (isDev) {
      const promise = loaderFn(props).finally(() => inflightRequests.delete(cacheKey));
      inflightRequests.set(cacheKey, promise);
      return promise;
    }

    const entry = cache.get(cacheKey) as CacheEntry<TResult> | undefined;
    const now = Date.now();
    const isStale = entry ? now - entry.createdAt > maxAge : true;

    if (policy === "no-cache") {
      if (entry && !isStale) return entry.value;
    }

    if (policy === "stale-while-revalidate") {
      if (entry && !isStale) return entry.value;

      if (entry && isStale && !entry.refreshing) {
        entry.refreshing = true;
        loaderFn(props)
          .then((result) => {
            cache.set(cacheKey, {
              value: result,
              createdAt: Date.now(),
              refreshing: false,
            });
          })
          .catch(() => {
            // Background refresh failed — entry stays stale.
            // If past the SIE window, evict so we don't serve indefinitely stale data.
            entry.refreshing = false;
            if (staleIfError > 0 && now - entry.createdAt > maxAge + staleIfError) {
              cache.delete(cacheKey);
            }
          });
        return entry.value;
      }

      if (entry) return entry.value;
    }

    const promise = loaderFn(props)
      .then((result) => {
        cache.set(cacheKey, {
          value: result,
          createdAt: Date.now(),
          refreshing: false,
        });
        evictIfNeeded();
        inflightRequests.delete(cacheKey);
        return result;
      })
      .catch((err) => {
        inflightRequests.delete(cacheKey);
        // SIE fallback: if we have a stale entry within the error window, return it
        if (staleIfError > 0 && entry) {
          const age = now - entry.createdAt;
          if (age < maxAge + staleIfError) {
            console.warn(
              `[cachedLoader] ${name}: origin error, serving stale entry (age=${Math.round(age / 1000)}s, sie=${Math.round(staleIfError / 1000)}s)`,
            );
            return entry.value;
          }
        }
        throw err;
      });

    inflightRequests.set(cacheKey, promise);
    return promise;
  };
}

/**
 * Create a cached loader from a module that exports `cache` and/or `cacheKey`.
 * Falls back to the provided defaults if the module doesn't declare them.
 */
export function createCachedLoaderFromModule<TProps, TResult>(
  name: string,
  mod: LoaderModule<TProps, TResult>,
  defaults?: Partial<CachedLoaderOptions>,
): (props: TProps) => Promise<TResult> {
  const moduleCache = mod.cache;
  let policy: CachePolicy;
  let maxAge: number | undefined;

  if (typeof moduleCache === "string") {
    policy = moduleCache;
  } else if (moduleCache && typeof moduleCache === "object") {
    policy = "stale-while-revalidate";
    maxAge = moduleCache.maxAge;
  } else {
    policy = defaults?.policy ?? "stale-while-revalidate";
  }

  maxAge = maxAge ?? defaults?.maxAge;

  const keyFn = mod.cacheKey
    ? (props: unknown) => {
        const key = mod.cacheKey!(props as TProps);
        return key ?? JSON.stringify(props);
      }
    : defaults?.keyFn;

  return createCachedLoader(name, mod.default, {
    policy,
    maxAge,
    staleIfError: defaults?.staleIfError,
    keyFn,
  });
}

/** Clear all cached entries. Useful for decofile hot-reload. */
export function clearLoaderCache() {
  cache.clear();
  inflightRequests.clear();
}

/** Get cache stats for diagnostics. */
export function getLoaderCacheStats() {
  return {
    entries: cache.size,
    inflight: inflightRequests.size,
  };
}
