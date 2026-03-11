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

/**
 * Loader module interface for modules that export cache configuration alongside
 * their default loader function. Mirrors deco-cx/apps pattern where loaders
 * can declare their own caching policy.
 *
 * @example
 * ```ts
 * // In a loader file:
 * export const cache = "stale-while-revalidate";
 * export const cacheKey = (props: any) => `myLoader:${props.slug}`;
 * export default async function myLoader(props: Props) { ... }
 * ```
 */
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

  const env = typeof globalThis.process !== "undefined" ? globalThis.process.env : undefined;
  const isDev = env?.DECO_CACHE_DISABLE === "true" || env?.NODE_ENV === "development";

  if (policy === "no-store") return loaderFn;

  return async (props: TProps): Promise<TResult> => {
    const cacheKey = `${name}::${keyFn(props)}`;

    // Single-flight dedup: if an identical request is already in-flight, reuse it
    const inflight = inflightRequests.get(cacheKey);
    if (inflight) return inflight as Promise<TResult>;

    // In dev mode, skip SWR cache but keep inflight dedup
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

/**
 * Create a cached loader from a module that exports `cache` and/or `cacheKey`.
 * Falls back to the provided defaults if the module doesn't declare them.
 *
 * @example
 * ```ts
 * import * as myLoaderModule from "./loaders/myLoader";
 * const cached = createCachedLoaderFromModule("myLoader", myLoaderModule, {
 *   policy: "stale-while-revalidate",
 *   maxAge: 60_000,
 * });
 * ```
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

  return createCachedLoader(name, mod.default, { policy, maxAge, keyFn });
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
