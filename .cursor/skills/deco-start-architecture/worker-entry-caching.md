# Worker Entry and Edge Caching

## createDecoWorkerEntry (`sdk/workerEntry.ts`)

The outermost wrapper for Cloudflare Workers. Handles admin routes, caching, and proxying to TanStack Start.

```typescript
interface DecoWorkerEntryOptions {
  cacheProfile?: (url: URL) => CacheProfile;
  buildSegment?: (request: Request) => SegmentKey;
  bypassPaths?: string[];
  adminHandlers?: AdminHandlers;
}

function createDecoWorkerEntry(
  serverEntry: { fetch: (req: Request) => Promise<Response> },
  options?: DecoWorkerEntryOptions,
): ExportedHandler
```

### Request Flow

```
Request
  |
  |-- 1. tryAdminRoute()
  |     /live/_meta       -> handleMeta
  |     /.decofile        -> handleDecofileRead / handleDecofileReload
  |     /live/previews/*  -> handleRender
  |     /deco/invoke      -> handleInvoke
  |     /deco/_liveness   -> handleLiveness
  |
  |-- 2. Cache purge check
  |     ?__deco_purge_cache -> purge + return 200
  |
  |-- 3. Static asset bypass
  |     /assets/*, favicon.ico, sprites.svg -> direct fetch
  |
  |-- 4. Edge cache lookup
  |     Build cache key (URL + segment hash)
  |     Check Cloudflare Cache API
  |     HIT -> return cached response
  |
  |-- 5. Origin (serverEntry.fetch)
  |     TanStack Start processes the request
  |     Response stored in cache if cacheable
  |
  |-- Return response
```

## Edge Caching (`sdk/cacheHeaders.ts`)

### Cache Profiles

URL patterns are matched to cache profiles with default TTLs:

| URL Pattern | Profile | s-maxage | stale-while-revalidate |
|-------------|---------|----------|----------------------|
| `/` (homepage) | `static` | 86400 (1 day) | 86400 |
| `*/p` (product) | `product` | 300 (5 min) | 300 |
| `/s`, `?q=` (search) | `search` | 60 (1 min) | 60 |
| `/cart`, `/checkout` | `private` | 0 | 0 |
| Everything else | `listing` | 120 (2 min) | 120 |

### Key Functions

```typescript
detectCacheProfile(url: URL): CacheProfile
cacheHeaders(profile: CacheProfile): Record<string, string>
routeCacheDefaults(profile: CacheProfile): { staleTime: number; gcTime: number }
registerCachePattern(pattern: RegExp, profile: CacheProfile): void
getCacheProfileConfig(profile: CacheProfile): CacheConfig
```

### Custom Profiles

Sites can register custom patterns:

```typescript
registerCachePattern(/\/brand\/.*/, "listing");
registerCachePattern(/\/lp\/.*/, "static");
```

## Segment Keys

Differentiate cache entries for personalized content:

```typescript
interface SegmentKey {
  device: "mobile" | "desktop";
  loggedIn: boolean;
  salesChannel?: string;
  flags: string[];  // sorted active flag names
}
```

The segment hash is appended to the cache key URL:

```typescript
function buildCacheKey(request: Request, segment: SegmentKey): Request {
  const url = new URL(request.url);
  url.searchParams.set("__seg", hashSegment(segment));
  return new Request(url.toString(), { method: "GET" });
}
```

### Important: Cloudflare Cache API Workaround

Cache API ignores `s-maxage`. The worker stores with `max-age` equal to `sMaxAge` as a workaround.

## Cached Loader (`sdk/cachedLoader.ts`)

In-memory SWR cache for server-side loaders:

```typescript
function createCachedLoader<T>(
  loader: () => Promise<T>,
  options?: { ttl?: number; key?: string },
): () => Promise<T>

function clearLoaderCache(key?: string): void
function getLoaderCacheStats(): { hits: number; misses: number; size: number }
```

## Cache-Control Merge (`sdk/mergeCacheControl.ts`)

Merges multiple Cache-Control headers (most restrictive wins):

```typescript
function mergeCacheControl(a: string, b: string): string
function createCacheControlCollector(): CacheControlCollector
```

## URL Utils for Caching (`sdk/urlUtils.ts`)

Strip tracking parameters for cache key stability:

```typescript
function stripTrackingParams(url: URL): URL
function cleanPathForCacheKey(url: URL): string
function hasTrackingParams(url: URL): boolean
function canonicalUrl(url: URL): string
```

Stripped params: `fbclid`, `gclid`, `gclsrc`, `dclid`, `gbraid`, `wbraid`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `mc_cid`, `mc_eid`, `_hsenc`, `_hsmi`, `hsCtaTracking`, `__hsfp`, `__hssc`, `__hstc`, `msclkid`, `yclid`, `igshid`, `twclid`, `ttclid`.

## CSP for Admin (`sdk/csp.ts`)

Allows admin to embed storefront in iframe:

```typescript
function setCSPHeaders(response: Response, adminOrigin?: string): void
function buildCSPHeaderValue(adminOrigin?: string): string
```
