/**
 * Server-side loader caching with stale-while-revalidate semantics.
 *
 * This provides a lightweight in-memory cache layer for commerce loaders
 * that runs on the server during SSR, without requiring TanStack Query
 * (which is optional and operates at the client/route level).
 *
 * For client-side SWR, use TanStack Query's `staleTime` / `gcTime`.
 */

export type CachePolicy = "no-store" | "no-cache" | "stale-while-revalidate";

export interface CachedLoaderOptions {
  policy: CachePolicy;
  /** Max age in milliseconds before an entry is considered stale. Default: 60_000 (1 min). */
  maxAge?: number;
  /** Key function to generate a cache key from loader props. Default: JSON.stringify. */
  keyFn?: (props: unknown) => string;
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

/**
 * Wraps a loader function with server-side caching and single-flight dedup.
 *
 * @example
 * ```ts
 * const cachedProductList = createCachedLoader(
 *   "vtex/loaders/productList",
 *   vtexProductList,
 *   { policy: "stale-while-revalidate", maxAge: 30_000 }
 * );
 * ```
 */
export function createCachedLoader<TProps, TResult>(
  name: string,
  loaderFn: (props: TProps) => Promise<TResult>,
  options: CachedLoaderOptions,
): (props: TProps) => Promise<TResult> {
  const { policy, maxAge = DEFAULT_MAX_AGE, keyFn = JSON.stringify } = options;

  if (policy === "no-store") return loaderFn;

  return async (props: TProps): Promise<TResult> => {
    const cacheKey = `${name}::${keyFn(props)}`;

    // Single-flight dedup: if an identical request is already in-flight, reuse it
    const inflight = inflightRequests.get(cacheKey);
    if (inflight) return inflight as Promise<TResult>;

    const entry = cache.get(cacheKey) as CacheEntry<TResult> | undefined;
    const now = Date.now();
    const isStale = entry ? now - entry.createdAt > maxAge : true;

    if (policy === "no-cache") {
      if (entry && !isStale) return entry.value;
      // Stale or missing — fetch fresh
    }

    if (policy === "stale-while-revalidate") {
      if (entry && !isStale) return entry.value;

      if (entry && isStale && !entry.refreshing) {
        entry.refreshing = true;
        // Fire-and-forget background refresh
        loaderFn(props)
          .then((result) => {
            cache.set(cacheKey, {
              value: result,
              createdAt: Date.now(),
              refreshing: false,
            });
          })
          .catch(() => {
            entry.refreshing = false;
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
        throw err;
      });

    inflightRequests.set(cacheKey, promise);
    return promise;
  };
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
