---
name: deco-api-call-dedup
description: Detect and fix duplicate/N+1 API calls in Deco TanStack storefronts. Covers vtexCachedFetch SWR cache for all VTEX GET calls, slugCache via fetchWithCache, cross-selling SWR cache, usePriceSimulationBatch for batching simulation POSTs, PLP path filtering to avoid spurious pagetype calls, pageType dedup, site loader registration, cachedLoader inflight dedup in dev mode, and HAR analysis techniques. Use when server logs show repeated VTEX API calls, PDP/PLP loads trigger excessive calls, simulation calls happen one-by-one, or "Unhandled resolver" warnings appear.
---

# API Call Deduplication & Batching

Patterns for eliminating redundant VTEX API calls in Deco storefronts on TanStack Start. These patterns reduced PDP API calls from 40+ to ~8 and PLP spurious calls from 15+ to near-zero on `espacosmart-storefront`. All VTEX GET calls now go through `vtexCachedFetch` with SWR (3 min TTL) and in-flight deduplication.

## When to Use This Skill

- Server logs show duplicate `search/{slug}/p` calls for the same product
- Cross-selling endpoints (`similars`, `suggestions`, `showtogether`) called multiple times with the same ID
- `simulation` POST called once per product instead of batched
- PDP page load triggers 20+ VTEX API calls
- HAR analysis shows waterfall of sequential API calls

---

## Pattern 1: Slug Search Deduplication (`slugCache`) via `vtexCachedFetch`

### Problem

Multiple section loaders call `search/{slug}/p` for the same product:
- `productDetailsPage.ts` (main PDP loader)
- `relatedProducts.ts` (needs `productId` from slug)
- Any section that resolves a product by slug

### Solution (Current)

`slugCache.ts` now delegates to `vtexCachedFetch`, which provides both in-flight deduplication AND SWR caching (3 min TTL for 200 responses). No manual inflight Map needed:

```typescript
// vtex/utils/slugCache.ts
import { vtexCachedFetch, getVtexConfig } from "../client";
import type { LegacyProduct } from "./types";

export function searchBySlug(linkText: string): Promise<LegacyProduct[] | null> {
  const config = getVtexConfig();
  const sc = config.salesChannel;
  const scParam = sc ? `?sc=${sc}` : "";

  return vtexCachedFetch<LegacyProduct[]>(
    `/api/catalog_system/pub/products/search/${linkText}/p${scParam}`,
  ).catch((err) => {
    console.error(`[VTEX] searchBySlug error for "${linkText}":`, err);
    return null;
  });
}

export async function resolveProductIdBySlug(slug: string): Promise<string | null> {
  const products = await searchBySlug(slug);
  return products?.length ? products[0].productId : null;
}
```

### Key Change from Previous Version

Before: manual `inflight` Map with `setTimeout(() => inflight.delete(...), 5_000)`
After: `vtexCachedFetch` handles dedup + SWR automatically via `fetchWithCache` (see `deco-vtex-fetch-cache` skill)

### Usage

```typescript
// In productDetailsPage.ts
import { searchBySlug } from "../utils/slugCache";
const products = await searchBySlug(linkText);

// In relatedProducts.ts
import { resolveProductIdBySlug } from "../utils/slugCache";
const productId = await resolveProductIdBySlug(slug);
```

### Impact

Before: 3-4 calls to `search/{slug}/p` per PDP load
After: 1 call, cached for 3 min across all loaders and subsequent page loads

---

## Pattern 2: Cross-Selling via `vtexCachedFetch`

### Problem

Multiple loaders request cross-selling data for the same product:

```
GET /crossselling/similars/58
GET /crossselling/suggestions/58
GET /crossselling/whoboughtalsobought/58
GET /crossselling/showtogether/58
```

When `relatedProducts.ts` runs multiple times (e.g., for "similars" shelf AND "suggestions" shelf), the same productId+type gets fetched twice.

### Solution (Current)

`relatedProducts.ts` now uses `vtexCachedFetch` instead of a manual `crossSellingInflight` Map. The SWR cache handles both dedup and 3-min TTL:

```typescript
import { vtexCachedFetch, getVtexConfig } from "../client";

function fetchCrossSelling(
  type: CrossSellingType,
  productId: string,
): Promise<LegacyProduct[]> {
  return vtexCachedFetch<LegacyProduct[]>(
    `/api/catalog_system/pub/products/crossselling/${type}/${productId}`,
  ).catch((err) => {
    console.error(`[VTEX] crossselling/${type}/${productId} error:`, err);
    return [] as LegacyProduct[];
  });
}
```

### Key Change from Previous Version

Before: manual `crossSellingInflight` Map with `setTimeout` cleanup
After: `vtexCachedFetch` provides dedup + SWR. Subsequent calls within 3 min return cached data instantly.

### Always `.catch(() => [])` on Cross-Selling

VTEX returns 404 for products without cross-selling data. An unhandled 404 crashes the entire section loader:

```typescript
// BAD — 404 kills the PDP
const related = await vtexFetch(`/crossselling/showtogether/${id}`);

// GOOD — graceful fallback
const related = await fetchCrossSelling("showtogether", id);
// vtexCachedFetch throws for non-ok responses, .catch returns []
```

---

## Pattern 3: Price Simulation Batching

### Problem

Product shelves call `simulation` POST once per product (N+1):

```
POST /orderForms/simulation  (item: sku-1)
POST /orderForms/simulation  (item: sku-2)
POST /orderForms/simulation  (item: sku-3)
...
```

### Solution

Create a batch simulation function that sends all SKUs in one call:

```typescript
// hooks/usePriceSimulationBatch.ts
import { simulateCart } from "@decocms/apps/vtex/actions/checkout";

interface SimulationResult {
  priceSimulation: number;
  noInterestInstallmentValue: string | null;
  installmentsObject: { value: number; numberOfInstallments: number } | null;
}

export async function usePriceSimulationBatch(
  skuIds: (string | undefined)[],
  request: Request,
): Promise<SimulationResult[]> {
  const validIds = skuIds.filter(Boolean) as string[];
  if (!validIds.length) return skuIds.map(() => defaultResult());

  const items = validIds.map((id) => ({
    id: Number(id),
    quantity: 1,
    seller: "1",
  }));

  const cookieHeader = request.headers.get("cookie") ?? undefined;
  const simulation = await simulateCart(items, "", "BRA", 0, cookieHeader);

  const resultMap = new Map<string, SimulationResult>();
  for (const item of simulation.items ?? []) {
    resultMap.set(String(item.id), extractPriceData(item));
  }

  return skuIds.map((id) => resultMap.get(id ?? "") ?? defaultResult());
}
```

### Usage

```typescript
// In section loaders — batch all IDs
const allIds = [mainProductId, ...relatedProductIds];
const allSimulations = await usePriceSimulationBatch(allIds, request);
const mainSim = allSimulations[0];
const relatedSims = allSimulations.slice(1);
```

### Impact

Before: N `simulation` POST calls (one per product in shelf)
After: 1 `simulation` POST call with all items batched

---

## Pattern 4: `cachedLoader` In-Flight Dedup in Dev Mode

### Problem

`createCachedLoader` completely disables caching in dev mode. This means even concurrent calls for the same key hit the API independently.

### Solution

Keep SWR cache disabled in dev, but enable in-flight deduplication:

```typescript
// In cachedLoader.ts
export function createCachedLoader<T>(name: string, loaderFn: LoaderFn<T>, opts: CacheOptions) {
  const inflight = new Map<string, Promise<T>>();

  return async (props: any): Promise<T> => {
    const key = `${name}:${JSON.stringify(props)}`;

    if (isDev) {
      // Dev: skip SWR cache but deduplicate concurrent calls
      const existing = inflight.get(key);
      if (existing) return existing;

      const promise = loaderFn(props).finally(() => inflight.delete(key));
      inflight.set(key, promise);
      return promise;
    }

    // Production: full SWR cache
    return swr(key, () => loaderFn(props), opts);
  };
}
```

### Why In-Flight Dedup Matters in Dev

During SSR, multiple sections resolve concurrently. Without dedup, the PDP loader runs 2-3 times for the same slug:
1. ProductMain section → `cachedPDP({ slug })`
2. Related Products section → `cachedPDP({ slug })` (to get productId)
3. Breadcrumb → `cachedPDP({ slug })`

With inflight dedup, only 1 actual API call, other callers await the same Promise.

---

## Pattern 5: PLP Path Filtering — Avoid Spurious `pageType` Calls

### Problem

The PLP loader's `pageTypesFromPath(__pagePath)` receives invalid paths like `/image/checked.png`, `/.well-known/appspecific/...`, `/assets/sprite.svg`. Each path segment triggers a VTEX `pagetype` API call, wasting 5+ calls on non-page URLs.

### Solution

Filter invalid paths before calling `pageTypesFromPath`:

```typescript
// In productListingPage.ts
const INVALID_PLP_PREFIXES = [
  "/image/", "/.well-known/", "/assets/", "/favicon",
  "/_serverFn/", "/_build/", "/node_modules/",
];

function isValidPLPPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (INVALID_PLP_PREFIXES.some((p) => lower.startsWith(p))) return false;
  const ext = lower.split("/").pop()?.split(".")?.pop();
  if (ext && ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "css", "js", "woff", "woff2", "ttf"].includes(ext)) {
    return false;
  }
  return true;
}

// Usage:
if (facets.length === 0 && __pagePath && __pagePath !== "/" && __pagePath !== "/*" && isValidPLPPath(__pagePath)) {
  const allPageTypes = await pageTypesFromPath(__pagePath);
  // ...
}
```

### Impact

Eliminates 5+ spurious VTEX API calls on PLP pages that have asset URLs in the path resolution pipeline.

---

## Pattern 6: `pageTypesFromPath` Dedup via `vtexCachedFetch`

### Problem

`pageTypesFromPath` calls VTEX's `pagetype` API for each path segment (cumulative). When multiple PLP sections resolve the same path, each segment gets fetched multiple times.

### Solution

Each individual `pagetype` call now goes through `vtexCachedFetch` with SWR:

```typescript
function cachedPageType(term: string): Promise<PageType> {
  return vtexCachedFetch<PageType>(`/api/catalog_system/pub/portal/pagetype/${term}`);
}

export async function pageTypesFromPath(pagePath: string): Promise<PageType[]> {
  const segments = pagePath.split("/").filter(Boolean);
  return Promise.all(
    segments.map((_, index) => {
      const term = segments.slice(0, index + 1).join("/");
      return cachedPageType(term);
    }),
  );
}
```

### Impact

Page type results are cached for 3 min. Concurrent and subsequent calls for the same segment share the same cached response.

---

## Pattern 7: Register All Site Loaders

### Problem

Custom site loaders like `site/loaders/Layouts/ProductCard.tsx` and `site/loaders/Search/colors.ts` appear in CMS blocks but aren't registered in `setup.ts`. This causes `[CMS] Unhandled resolver: site/loaders/...` warnings and missing data.

### Solution

Register passthrough loaders in `COMMERCE_LOADERS` in `setup.ts`:

```typescript
const COMMERCE_LOADERS: Record<string, (props: any) => Promise<any>> = {
  // ... existing commerce loaders ...
  "site/loaders/Layouts/ProductCard.tsx": async (props: any) => props.layout ?? props,
  "site/loaders/Search/colors.ts": async (props: any) => ({ colors: props.colors ?? [] }),
};
```

### How to Find Missing Loaders

Search server logs for "Unhandled resolver":
```bash
rg "Unhandled resolver" # in terminal output
```

Then check if the referenced loader exists in `src/loaders/` and add a corresponding entry in `setup.ts`.

---

## Diagnosing API Call Issues

### Server Logs

Add prefixed logging to VTEX fetch:

```typescript
console.log(`[vtex] GET ${url}`);
const result = await fetch(url);
console.log(`[vtex] ${result.status} GET ${url} ${Date.now() - start}ms`);
```

### HAR Analysis

```python
import json
with open('localhost.har') as f:
    har = json.load(f)

# Count VTEX API calls by endpoint
from collections import Counter
vtex_calls = Counter()
for e in har['log']['entries']:
    url = e['request']['url']
    if 'vtexcommercestable' not in url:
        continue
    # Extract endpoint pattern
    path = url.split('.com.br')[1].split('?')[0] if '.com.br' in url else url
    vtex_calls[path] += 1

for path, count in vtex_calls.most_common(20):
    print(f"  {count}x  {path}")
```

### Common N+1 Patterns to Watch For

| Pattern | Symptom | Fix |
|---------|---------|-----|
| `search/{slug}/p` called N times | Multiple section loaders resolve same product | `vtexCachedFetch` via `slugCache` |
| `crossselling/{type}/{id}` duplicated | Same product ID across multiple related-products sections | `vtexCachedFetch` in `relatedProducts.ts` |
| `simulation` called per product | Product shelves simulate one-by-one | `usePriceSimulationBatch` |
| `intelligent-search` for Header shelves | Header re-resolved on every navigation | Layout caching + `fetchWithCache` for IS |
| `orderForm` called multiple times | Multiple components check cart state | `useCart` singleton |
| `pagetype` for asset URLs | PLP loader resolving `/image/...` paths | `isValidPLPPath` filter |
| `pagetype` called N times for same segment | Multiple PLP sections resolve same path | `vtexCachedFetch` in `cachedPageType` |
| `Unhandled resolver: site/loaders/...` | Custom site loaders not registered | Register in `setup.ts` COMMERCE_LOADERS |

---

## Common Errors

### `ERR_MODULE_NOT_FOUND` for slugCache

**Note**: This error has been resolved. Imports within `@decocms/apps` now use extensionless paths (standard for Node/Vite). If you see this error, ensure the import doesn't have `.ts` extension:

```typescript
// GOOD (current)
import { searchBySlug } from "../utils/slugCache";
import { vtexCachedFetch } from "../client";
import { fetchWithCache } from "./utils/fetchCache";
```

### `crossselling//showtogether` (empty productId)

The productId was `undefined`. Always guard:

```typescript
if (!mainProduct) return { ...props };
const productGroupId = mainProduct.inProductGroupWithID ?? mainProduct.productID ?? "";
if (!productGroupId) return { ...props };
```

### `config is not defined` in productDetailsPage

If `getVtexConfig()` is removed during refactoring, the `salesChannel` query param is lost:

```typescript
const config = getVtexConfig();
const sc = config.salesChannel;
// Use sc in API URLs: `?sc=${sc}`
```

---

## Related Skills

| Skill | Purpose |
|-------|---------|
| `deco-vtex-fetch-cache` | SWR fetch cache for VTEX APIs (`fetchWithCache`, `vtexCachedFetch`) |
| `deco-variant-selection-perf` | Eliminate server calls for variant selection |
| `deco-cms-layout-caching` | Cache layout sections to prevent Header API calls |
| `deco-loader-n-plus-1-detector` | Automated N+1 detection in Deco loaders |
| `deco-tanstack-storefront-patterns` | General runtime patterns + loader `cache`/`cacheKey` exports |
