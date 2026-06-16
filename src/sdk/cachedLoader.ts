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

import {
  recordCacheMetric,
  recordLoaderError,
  recordLoaderMetric,
  withTracing,
} from "../middleware/observability";
import { type CacheProfileName, loaderCacheOptions } from "./cacheHeaders";
import { withInflightTimeout } from "./inflightTimeout";

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
  /** Estimated payload size in bytes (UTF-16 length of JSON.stringify). */
  estimatedBytes: number;
}

const DEFAULT_MAX_AGE = 60_000;

/**
 * Byte-cap for the in-memory loader cache. Default 32 MB — comfortably below
 * the Cloudflare Workers 128 MB isolate limit even when other caches (router,
 * VTEX fetch cache, V8 heap) are also resident.
 *
 * Override via env: `DECO_LOADER_CACHE_MAX_BYTES=67108864` (64 MB).
 *
 * Switched from entry-count to byte-based eviction because PLP payloads
 * (~0.5–2 MB each) blew past 128 MB at well under the previous 500-entry cap.
 */
const DEFAULT_MAX_CACHE_BYTES = 32 * 1024 * 1024;

function resolveMaxBytes(): number {
  const env = typeof globalThis.process !== "undefined"
    ? globalThis.process.env
    : undefined;
  const raw = env?.DECO_LOADER_CACHE_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_CACHE_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CACHE_BYTES;
}

const MAX_CACHE_BYTES = resolveMaxBytes();

const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;

function estimateBytes(value: unknown): number {
  try {
    // UTF-16 string length is an order-of-magnitude estimate of the bytes the
    // object retains in V8 (V8 keeps a structured representation, not JSON).
    // The absolute value is less important than the relative pressure signal.
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    // Circular refs / non-serializable values: fall back to a fixed budget so
    // the entry still counts against the cap.
    return 1024;
  }
}

function setCacheEntry<T>(key: string, entry: CacheEntry<T>) {
  const prev = cache.get(key);
  if (prev) cacheBytes -= prev.estimatedBytes;
  cacheBytes += entry.estimatedBytes;
  cache.set(key, entry);
}

function deleteCacheEntry(key: string) {
  const prev = cache.get(key);
  if (!prev) return;
  cacheBytes -= prev.estimatedBytes;
  cache.delete(key);
}

function evictIfNeeded() {
  if (cacheBytes <= MAX_CACHE_BYTES) return;
  const oldest = [...cache.entries()].sort(
    (a, b) => a[1].createdAt - b[1].createdAt,
  );
  for (const [key] of oldest) {
    deleteCacheEntry(key);
    if (cacheBytes <= MAX_CACHE_BYTES) break;
  }
}

const inflightRequests = new Map<string, Promise<unknown>>();

function resolveOptions(
  optionsOrProfile: CachedLoaderOptions | CacheProfileName,
): CachedLoaderOptions {
  if (typeof optionsOrProfile === "string") {
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
  const { policy, maxAge = DEFAULT_MAX_AGE, staleIfError = 0, keyFn = JSON.stringify } = resolved;

  const env = typeof globalThis.process !== "undefined" ? globalThis.process.env : undefined;
  const isDev = env?.DECO_CACHE_DISABLE === "true" || env?.NODE_ENV === "development";

  if (policy === "no-store") return loaderFn;

  return async (props: TProps): Promise<TResult> => {
    const cacheKey = `${name}::${keyFn(props)}`;

    const inflight = inflightRequests.get(cacheKey);
    if (inflight) {
      // Treat in-flight dedup as a cache hit — avoided the origin call.
      recordCacheMetric(true, name, undefined, "cachedLoader");
      const start = performance.now();
      return inflight.then((r) => {
        recordLoaderMetric(name, performance.now() - start, "HIT");
        return r as TResult;
      });
    }

    if (isDev) {
      // Dev mode: no caching, but still useful to count attempts.
      recordCacheMetric(false, name, undefined, "cachedLoader");
      const devStart = performance.now();
      const promise = withInflightTimeout(
        withTracing(
          "deco.cachedLoader",
          () => loaderFn(props),
          { "deco.loader": name, "deco.cache.policy": "no-cache-dev" },
        ),
        `cachedLoader:dev ${cacheKey}`,
      )
        .then((r) => {
          recordLoaderMetric(name, performance.now() - devStart, "BYPASS");
          return r;
        })
        .catch((err) => {
          recordLoaderMetric(name, performance.now() - devStart, "BYPASS");
          recordLoaderError(name);
          throw err;
        })
        .finally(() => inflightRequests.delete(cacheKey));
      inflightRequests.set(cacheKey, promise);
      return promise;
    }

    const entry = cache.get(cacheKey) as CacheEntry<TResult> | undefined;
    const now = Date.now();
    const isStale = entry ? now - entry.createdAt > maxAge : true;

    if (policy === "no-cache") {
      if (entry && !isStale) {
        recordCacheMetric(true, name, "HIT", "cachedLoader");
        recordLoaderMetric(name, 0, "HIT");
        return entry.value;
      }
    }

    if (policy === "stale-while-revalidate") {
      if (entry && !isStale) {
        recordCacheMetric(true, name, "HIT", "cachedLoader");
        recordLoaderMetric(name, 0, "HIT");
        return entry.value;
      }

      if (entry && isStale && !entry.refreshing) {
        // Stale-while-revalidate hit: serve stale, refresh in background.
        recordCacheMetric(true, name, "STALE-HIT", "cachedLoader");
        recordLoaderMetric(name, 0, "STALE-HIT");
        entry.refreshing = true;
        loaderFn(props)
          .then((result) => {
            setCacheEntry(cacheKey, {
              value: result,
              createdAt: Date.now(),
              refreshing: false,
              estimatedBytes: estimateBytes(result),
            });
            evictIfNeeded();
          })
          .catch(() => {
            // Background refresh failed — entry stays stale.
            // If past the SIE window, evict so we don't serve indefinitely stale data.
            entry.refreshing = false;
            if (staleIfError > 0 && now - entry.createdAt > maxAge + staleIfError) {
              deleteCacheEntry(cacheKey);
            }
          });
        return entry.value;
      }

      if (entry) {
        // Past SIE window — still serve the stale value once but mark
        // the decision as STALE-ERROR so dashboards can distinguish
        // this from healthy SWR.
        recordCacheMetric(true, name, "STALE-ERROR", "cachedLoader");
        recordLoaderMetric(name, 0, "STALE-ERROR");
        return entry.value;
      }
    }

    // Cache miss — emit metric, then run loader inside a span so individual
    // slow loaders are visible in traces.
    recordCacheMetric(false, name, "MISS", "cachedLoader");
    const loaderStart = performance.now();
    const promise = withInflightTimeout(
      withTracing("deco.cachedLoader", () => loaderFn(props), {
        "deco.loader": name,
        "deco.cache.policy": policy,
      }),
      `cachedLoader ${cacheKey}`,
    )
      .then((result) => {
        recordLoaderMetric(name, performance.now() - loaderStart, "MISS");
        setCacheEntry(cacheKey, {
          value: result,
          createdAt: Date.now(),
          refreshing: false,
          estimatedBytes: estimateBytes(result),
        });
        evictIfNeeded();
        return result;
      })
      .catch((err) => {
        // SIE fallback: if we have a stale entry within the error window, return it
        if (staleIfError > 0 && entry) {
          const age = now - entry.createdAt;
          if (age < maxAge + staleIfError) {
            console.warn(
              `[cachedLoader] ${name}: origin error, serving stale entry (age=${Math.round(age / 1000)}s, sie=${Math.round(staleIfError / 1000)}s)`,
            );
            recordLoaderMetric(name, performance.now() - loaderStart, "STALE-ERROR");
            return entry.value;
          }
        }
        recordLoaderMetric(name, performance.now() - loaderStart, "MISS");
        recordLoaderError(name);
        throw err;
      })
      .finally(() => inflightRequests.delete(cacheKey));

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
  cacheBytes = 0;
  inflightRequests.clear();
}

/** Get cache stats for diagnostics. */
export function getLoaderCacheStats() {
  return {
    entries: cache.size,
    inflight: inflightRequests.size,
    estimatedBytes: cacheBytes,
    maxBytes: MAX_CACHE_BYTES,
  };
}
