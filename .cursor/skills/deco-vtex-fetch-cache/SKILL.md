---
name: deco-vtex-fetch-cache
description: SWR in-memory fetch cache for VTEX API responses in @decocms/apps. Ported from deco-cx/deco runtime/fetch/fetchCache.ts. Provides in-flight deduplication + stale-while-revalidate for all VTEX GET requests. Covers fetchWithCache utility, vtexCachedFetch client function, LRU eviction, TTL by HTTP status, integration with intelligentSearch and cross-selling calls. Use when adding caching to VTEX API calls, debugging stale responses, or understanding how the fetch cache layer works.
---

# VTEX Fetch Cache (SWR In-Memory)

Server-side SWR cache for all VTEX GET API responses. Ported from `deco-cx/deco` `runtime/fetch/fetchCache.ts` and adapted for `@decocms/apps` on TanStack Start.

## When to Use This Skill

- Adding SWR caching to new VTEX API calls
- Understanding why a VTEX response is served stale
- Debugging cache hit/miss behavior
- Tuning TTL for specific endpoints
- Understanding the relationship between `fetchWithCache`, `vtexCachedFetch`, and `createCachedLoader`

---

## Architecture

```
Site Setup
  └→ createCachedLoader (loader-level SWR, 30-120s TTL)
       └→ vtexCachedFetch (HTTP-level SWR, 3min TTL)
            └→ fetchWithCache (core cache engine)
                 └→ _fetch (instrumented fetch)
```

| Layer | File | Scope | TTL |
|-------|------|-------|-----|
| `createCachedLoader` | `deco-start/src/sdk/cachedLoader.ts` | Loader result (parsed + transformed) | 30-120s per loader |
| `vtexCachedFetch` | `apps-start/vtex/client.ts` | Raw HTTP JSON response | 3 min (200), 10s (404) |
| `fetchWithCache` | `apps-start/vtex/utils/fetchCache.ts` | Core SWR + dedup engine | Status-based |

---

## Core: `fetchWithCache` (`vtex/utils/fetchCache.ts`)

### Features

- **LRU eviction**: Max 500 entries, oldest evicted first
- **TTL by HTTP status**: 200-299 → 3 min, 404 → 10s, 500+ → never cached
- **In-flight deduplication**: Concurrent calls for the same URL share one Promise
- **Stale-while-revalidate**: Stale entries served immediately, refreshed in background
- **Custom TTL**: Override per-call via `opts.ttl`

### API

```typescript
import { fetchWithCache, FetchCacheOptions } from "@decocms/apps/vtex/utils/fetchCache";

// Basic usage
const data = await fetchWithCache<ProductType>(
  fullUrl,                    // Cache key (typically the full URL)
  () => fetch(fullUrl, init), // Fetch callback (returns Response)
  { ttl: 60_000 },           // Optional: override TTL (1 min)
);
```

### How SWR Works

```
Call fetchWithCache(key, doFetch)
  ├→ Entry exists & fresh? → return cached body
  ├→ Entry exists & stale? → return stale, fire background refresh
  ├→ Entry missing, inflight exists? → await inflight Promise
  └→ Entry missing, no inflight → execute doFetch(), cache result
```

### TTL Configuration

```typescript
const TTL_BY_STATUS: Record<string, number> = {
  "2xx": 180_000,  // 3 min — success responses
  "404": 10_000,   // 10s — not found (may become available)
  "5xx": 0,        // never cache server errors
};
```

### Error Handling

Non-ok responses (status >= 400) throw an error. They are NOT cached. The error propagates to the caller, who should `.catch()` gracefully:

```typescript
const data = await fetchWithCache<T>(url, doFetch).catch(() => fallback);
```

---

## Client Integration: `vtexCachedFetch` (`vtex/client.ts`)

Convenience wrapper that routes GET requests through `fetchWithCache`:

```typescript
import { vtexCachedFetch } from "@decocms/apps/vtex";

// Automatically uses SWR cache for GET
const products = await vtexCachedFetch<Product[]>(
  `/api/catalog_system/pub/products/search/${slug}/p`,
);

// Non-GET falls through to regular vtexFetch
const result = await vtexCachedFetch<OrderForm>(
  `/api/checkout/pub/orderForms/simulation`,
  { method: "POST", body: JSON.stringify(items) },
);
```

### Custom TTL per call

```typescript
const pageType = await vtexCachedFetch<PageType>(
  `/api/catalog_system/pub/portal/pagetype/${term}`,
  undefined,
  { cacheTTL: 300_000 }, // 5 min for page types
);
```

---

## What Uses `vtexCachedFetch` (Current)

| Module | Endpoint | Before | After |
|--------|----------|--------|-------|
| `slugCache.ts` | `search/{slug}/p` | Manual inflight Map + 5s timeout | `vtexCachedFetch` SWR 3min |
| `relatedProducts.ts` | `crossselling/{type}/{id}` | Manual `crossSellingInflight` Map | `vtexCachedFetch` SWR 3min |
| `productDetailsPage.ts` | Kit items search | Plain `vtexFetch` | `vtexCachedFetch` SWR 3min |
| `client.ts` `cachedPageType` | `pagetype/{term}` | Manual inflight Map | `vtexCachedFetch` SWR 3min |

## What Uses `fetchWithCache` Directly

| Module | Endpoint | Notes |
|--------|----------|-------|
| `client.ts` `intelligentSearch` | IS `product_search`, `facets` | Wrapped inline, uses default TTL |

---

## Comparison with `deco-cx/deco` `fetchCache.ts`

| Feature | deco-cx/deco | @decocms/apps |
|---------|-------------|---------------|
| Storage | `CacheStorage` (Web Cache API) | In-memory `Map` (LRU) |
| Persistence | Disk-backed (Deno CacheStorage) | Process-lifetime only |
| Max entries | Unlimited (disk) | 500 (memory) |
| TTL source | HTTP `Cache-Control` headers | Status-based defaults |
| SWR | `stale-while-revalidate` header parsing | Manual background refresh |
| Dedup | Separate `singleFlight` wrapper | Built into `fetchWithCache` |
| Redis/FS tiers | Yes (`tiered.ts`: LRU → FS → Redis) | No — single in-memory tier |

### Why In-Memory Only?

Cloudflare Workers don't have persistent storage APIs accessible during SSR. The Cache API (`caches.default`) is for edge HTTP responses, not arbitrary data. In-memory with LRU is the practical choice for Workers.

---

## Diagnostics

### Check Cache Stats

```typescript
import { getFetchCacheStats, clearFetchCache } from "@decocms/apps/vtex/utils/fetchCache";

console.log(getFetchCacheStats());
// { entries: 42, inflight: 0 }
```

### Clear Cache

```typescript
clearFetchCache(); // Useful after decofile hot-reload
```

### Verify Cache Hits in Logs

With instrumented fetch (`createInstrumentedFetch("vtex")`), look for timing:
- **Cache HIT**: No `[vtex] GET ...` log appears (response served from cache)
- **Cache MISS**: `[vtex] GET ...` followed by `[vtex] 200 GET ... Xms`
- **SWR refresh**: `[vtex] GET ...` appears AFTER the response was already served

### Common Issues

**Stale data after CMS update**: Wait 3 min for TTL to expire, or restart the dev server to clear in-memory cache.

**Cache not working in dev**: `fetchWithCache` works in both dev and prod. Unlike `createCachedLoader` which skips SWR in dev (only dedup), `fetchWithCache` always caches.

**POST requests not cached**: By design — `vtexCachedFetch` only caches GET. Use `usePriceSimulationBatch` for simulation POST optimization.

---

## Adding Cache to a New VTEX Endpoint

```typescript
// Before — no cache
const data = await vtexFetch<MyType>(`/api/my-endpoint/${id}`);

// After — with SWR cache
const data = await vtexCachedFetch<MyType>(`/api/my-endpoint/${id}`);

// With custom TTL
const data = await vtexCachedFetch<MyType>(
  `/api/my-endpoint/${id}`,
  undefined,
  { cacheTTL: 60_000 }, // 1 min
);
```

For non-VTEX APIs, use `fetchWithCache` directly:

```typescript
import { fetchWithCache } from "@decocms/apps/vtex/utils/fetchCache";

const data = await fetchWithCache<MyType>(url, () => fetch(url, init));
```

---

## Related Skills

| Skill | Purpose |
|-------|---------|
| `deco-api-call-dedup` | Higher-level dedup patterns (slugCache, batching, PLP filtering) |
| `deco-cms-layout-caching` | Layout section caching (works on top of fetch cache) |
| `deco-edge-caching` | Cloudflare edge caching (HTTP level, outside the Worker) |
| `deco-tanstack-storefront-patterns` | General storefront patterns + `createCachedLoader` |
