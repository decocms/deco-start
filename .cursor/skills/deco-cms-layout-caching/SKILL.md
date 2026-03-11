---
name: deco-cms-layout-caching
description: Cache layout sections (Header, Footer, Theme) in @decocms/start to avoid redundant CMS resolution and API calls on every navigation. Covers resolvedLayoutCache in resolve.ts, layoutInflight dedup in sectionLoaders.ts, pageInflight dedup in cmsRoute.ts, registerLayoutSections, staleTime in dev mode, and diagnosing repeated intelligent-search calls. Use when page loads trigger duplicate VTEX API calls for Header shelves, variant changes re-resolve the entire CMS page, or layout sections cause N+1 API patterns.
---

# CMS Layout Section Caching

Multi-layer caching strategy for layout sections (Header, Footer, Theme, etc.) in `@decocms/start`. These sections appear on every page but rarely change — caching them eliminates the biggest source of redundant API calls.

## When to Use This Skill

- Server logs show repeated `intelligent-search/product_search` calls for Header shelves on every navigation
- Variant changes trigger full CMS resolution including Header/Footer
- `[CMS]` logs show the same sections being resolved multiple times
- PDP load takes >2s and most time is spent on layout section loaders
- Setting up a new Deco site and want optimal caching from the start

---

## Architecture: 3 Caching Layers for Layout Sections

```
Request → loadCmsPage (pageInflight dedup)
  └→ resolveDecoPage
       ├→ Layout sections → resolvedLayoutCache (5min TTL) + resolvedLayoutInflight
       └→ Content sections → resolve normally
  └→ runSectionLoaders
       ├→ Layout sections → layoutCache (5min TTL) + layoutInflight
       └→ Content sections → run loader normally
```

| Layer | File | What it caches | TTL | Key |
|-------|------|----------------|-----|-----|
| **Page inflight** | `cmsRoute.ts` | Entire `loadCmsPage` result | In-flight only | `basePath` (no query) |
| **Layout resolution** | `resolve.ts` | Fully resolved CMS props for layout sections | 5 min | Block reference key |
| **Layout loaders** | `sectionLoaders.ts` | Section loader output for layout sections | 5 min | Component key |

---

## Layer 1: Page In-Flight Deduplication (`cmsRoute.ts`)

Prevents concurrent `loadCmsPage` calls for the same path (e.g., prefetch + click happening simultaneously).

```typescript
const pageInflight = new Map<string, Promise<unknown>>();

export const loadCmsPage = createServerFn({ method: "GET" }).handler(
  async (ctx) => {
    const fullPath = ctx.data as string;
    const [basePath] = fullPath.split("?");

    const existing = pageInflight.get(basePath);
    if (existing) return existing;

    const promise = loadCmsPageInternal(fullPath)
      .finally(() => pageInflight.delete(basePath));
    pageInflight.set(basePath, promise);
    return promise;
  },
);
```

### Why `basePath` (no query)?

The CMS page structure is the same regardless of `?skuId=X` or other query params. Using `basePath` ensures that `/product/p?skuId=1` and `/product/p?skuId=2` share the same inflight promise.

---

## Layer 2: Layout Resolution Cache (`resolve.ts`)

Caches the fully resolved CMS output for layout sections. This is the most impactful layer because layout sections often contain embedded commerce loaders (Header with product shelves) that make expensive API calls.

### Registration

In your site's `setup.ts`:

```typescript
import { registerLayoutSections } from "@decocms/start/cms";

registerLayoutSections([
  "site/sections/Header/Header.tsx",
  "site/sections/Footer/Footer.tsx",
  "site/sections/Theme/Theme.tsx",
  "site/sections/Miscellaneous/CookieConsent.tsx",
  "site/sections/Social/WhatsApp.tsx",
]);
```

### How It Works

In `resolveDecoPage`, before resolving each raw section:

1. Check if the raw block eventually resolves to a registered layout section (walks up to 5 levels of block references like `"Header - 01"` → `"Header"` → `site/sections/Header/Header.tsx`)
2. If layout: check `resolvedLayoutCache` → return cached result if fresh
3. If inflight: return existing promise (dedup concurrent resolutions)
4. Otherwise: resolve normally, cache result for 5 minutes

```typescript
const resolvedLayoutCache = new Map<string, { sections: ResolvedSection[]; ts: number }>();
const resolvedLayoutInflight = new Map<string, Promise<ResolvedSection[]>>();
const LAYOUT_CACHE_TTL = 5 * 60_000; // 5 minutes

// Inside resolveDecoPage:
const layoutKey = isRawSectionLayout(section);
if (layoutKey) {
  const cached = getCachedResolvedLayout(layoutKey);
  if (cached) return cached;

  const inflight = resolvedLayoutInflight.get(layoutKey);
  if (inflight) return inflight;

  const promise = resolveRawSection(section, rctx).then((results) => {
    setCachedResolvedLayout(layoutKey, results);
    return results;
  });
  resolvedLayoutInflight.set(layoutKey, promise);
  promise.finally(() => resolvedLayoutInflight.delete(layoutKey));
  return promise;
}
```

### `isRawSectionLayout` — Walking Block References

CMS blocks often reference other blocks:
- `"Header - 01"` → resolves to `"Header"` → resolves to `{ __resolveType: "site/sections/Header/Header.tsx" }`

```typescript
function isRawSectionLayout(section: RawSection): string | null {
  // Walk up to 5 levels of block indirection
  let current = section;
  for (let depth = 0; depth < 5; depth++) {
    const resolveType = current.__resolveType;
    if (isLayoutSection(resolveType)) return resolveType;
    const block = decofileData?.[resolveType];
    if (!block || typeof block !== "object") return null;
    current = block as RawSection;
  }
  return null;
}
```

---

## Layer 3: Layout Section Loader Cache (`sectionLoaders.ts`)

Caches the output of section loaders (the `export const loader` functions) for layout sections.

```typescript
const layoutSections = new Set<string>();
const layoutCache = new Map<string, { data: ResolvedSection; ts: number }>();
const layoutInflight = new Map<string, Promise<ResolvedSection>>();

export async function runSectionLoaders(
  sections: ResolvedSection[],
  request: Request,
): Promise<ResolvedSection[]> {
  return Promise.all(
    sections.map(async (section) => {
      const key = section.Component;
      const loaderFn = loaderRegistry.get(key);

      if (isLayoutSection(key)) {
        // Check cache
        const cached = layoutCache.get(key);
        if (cached && Date.now() - cached.ts < LAYOUT_CACHE_TTL) {
          return cached.data;
        }
        // Check inflight
        const inflight = layoutInflight.get(key);
        if (inflight) return inflight;

        const promise = runLoader(section, loaderFn, request).then((result) => {
          layoutCache.set(key, { data: result, ts: Date.now() });
          return result;
        });
        layoutInflight.set(key, promise);
        promise.finally(() => layoutInflight.delete(key));
        return promise;
      }

      return loaderFn ? runLoader(section, loaderFn, request) : section;
    }),
  );
}
```

---

## Diagnosing Layout Cache Issues

### Symptom: Repeated `intelligent-search` calls in logs

```
[VTEX] ProductList: query="", count=100, collection="152", sort="price:desc"
[VTEX] ProductList: query="", count=100, collection="200", sort="price:desc"
[VTEX] ProductList: query="", count=20, collection="", sort="price:desc"
```

These come from Header product shelves being re-resolved on every navigation.

### Fix Checklist

1. Ensure `registerLayoutSections` includes the Header section key
2. Verify the block reference chain resolves correctly (check `.deco/blocks/Header*.json`)
3. Confirm `isLayoutSection` returns `true` for the section key
4. Add logging to verify cache hits: `console.log("[CMS] Layout cache HIT:", layoutKey)`

### Symptom: `staleTime: 0` causes re-fetch despite `loaderDeps` filtering

In dev mode, if `routeCacheDefaults` returns `{ staleTime: 0, gcTime: 0 }`, TanStack Router always re-fetches even when `loaderDeps` returns the same deps.

**Fix**: Set minimum staleTime in dev:

```typescript
// In cacheHeaders.ts → routeCacheDefaults()
if (isDev) return { staleTime: 5_000, gcTime: 30_000 };
```

---

## Common Errors During Implementation

### Error: `isLayoutSection is not a function`

The `isLayoutSection` function must be exported from `@decocms/start/cms`:

```typescript
// cms/index.ts
export { isLayoutSection, registerLayoutSections } from "./sectionLoaders";
```

### Error: Layout sections cached but still showing stale content

The 5-minute TTL means layout sections won't reflect CMS changes for up to 5 minutes in dev. Restart the dev server to clear in-memory caches.

### Error: Block reference chain not found

If `isRawSectionLayout` returns `null` for a block like `"Header - 01"`, the block reference in `.deco/blocks/` may not resolve to the layout section. Check:

```bash
cat '.deco/blocks/Header - 01.json' | python3 -c "import sys,json; print(json.load(sys.stdin).get('__resolveType','?'))"
```

---

## Integration with `vtexCachedFetch` SWR

Layout caching prevents re-execution of section loaders and CMS resolution for 5 minutes. But the underlying VTEX API calls also benefit from the `vtexCachedFetch` SWR cache (3 min TTL):

```
Request → Layout cache (5 min TTL)
  └→ MISS → resolveDecoPage → section loaders
       └→ vtexCachedFetch → fetchWithCache (3 min TTL)
            └→ MISS → actual VTEX API call
```

This means even after the layout cache expires, the underlying API data may still be fresh in the fetch cache. The two caches work together:

| Layer | TTL | Scope |
|-------|-----|-------|
| Layout resolution cache | 5 min | Full section output (props + enrichment) |
| Layout section loader cache | 5 min | Section loader output only |
| `fetchWithCache` SWR | 3 min | Individual HTTP responses |
| `cachedLoader` SWR | 30-120s | Commerce loader results |

### Cart Cross-Selling on PLP — Not an Issue

Analysis confirmed that cart drawer cross-selling is **CMS-based** (products configured in admin), not API-based. The Header loader only runs `usePriceSimulationBatch` (a POST, which only runs when `userInfo` cookie exists with a CEP). On first visit without the cookie, no simulation runs at all.

---

## Performance Impact

Before layout caching (variant change on PDP):
- **~30 VTEX API calls** per navigation (Header shelves × 2 resolutions)
- **2-3 seconds** delay

After layout caching + `vtexCachedFetch` SWR:
- **~8 VTEX API calls** on first load (only product-specific: PDP loader, cross-selling, simulation)
- **~0-2 VTEX API calls** on subsequent navigations (everything served from SWR caches)
- **<1 second** for cached navigations

---

## Related Skills

| Skill | Purpose |
|-------|---------|
| `deco-vtex-fetch-cache` | SWR fetch cache for VTEX APIs (`fetchWithCache`, `vtexCachedFetch`) |
| `deco-variant-selection-perf` | Eliminate server calls for same-product variant selection |
| `deco-api-call-dedup` | In-flight deduplication + batching for VTEX API calls |
| `deco-edge-caching` | Cloudflare edge caching configuration |
| `deco-cms-route-config` | CMS route configuration in @decocms/start |
