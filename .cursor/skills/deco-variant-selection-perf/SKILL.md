---
name: deco-variant-selection-perf
description: Optimize product variant selection in Deco TanStack storefronts. Eliminates server re-fetches when switching SKU variants of the same product using replaceState, adds loading states for cross-product variant navigation, and removes preload="intent" from variant links to prevent double-fetch. Use when variant changes are slow, HAR analysis shows duplicate loadCmsPage calls, or when implementing variant selectors in a PDP.
---

# Product Variant Selection Performance

Patterns for making variant selection instant in Deco storefronts on TanStack Start. Discovered while optimizing `espacosmart-storefront` where clicking a variant triggered 2 full `loadCmsPage` server calls (1300ms+ each).

## When to Use This Skill

- Variant changes on PDP are slow (>500ms)
- HAR analysis shows duplicate `loadCmsPage` calls with/without `?skuId`
- `preload="intent"` on variant `<Link>` causes double-fetch
- Need to add loading feedback for cross-product variant navigation
- Implementing a new variant selector component

---

## Key Insight: Two Types of "Variant" Navigation

| Type | Example | Data needed | Approach |
|------|---------|-------------|----------|
| **Same product, different SKU** | Size 90x0.8 → 90x0.95 | Already loaded in `isVariantOf.hasVariant` | `replaceState` — zero fetch |
| **Different product** | Product A → Product B (visual variation) | New product data | `navigate()` — single fetch |

The CMS block "PDP Loader" does NOT pass `skuId` to the server loader. All SKU data comes in the first load via `isVariantOf.hasVariant`. The `?skuId` in the URL is purely for bookmarking/sharing.

---

## Problem: Double-Fetch on Variant Click

### Root Cause

When using `<Link to="/slug/p?skuId=160" preload="intent">`:

1. **Hover** → TanStack Router fires a prefetch. The `loaderDeps` filters `skuId`, so it sends `loadCmsPage({ data: "/slug/p" })`.
2. **Click** → Router fires the real navigation. Depending on timing and staleTime, it may fire `loadCmsPage({ data: "/slug/p?skuId=160" })`.

Result: **2 server calls** for one variant click, each taking 1-2 seconds (full CMS resolution + section loaders + VTEX API calls).

### How to Diagnose

Export a HAR from Chrome DevTools (Network tab → Export HAR). Analyze:

```python
# Find all loadCmsPage calls
import json, urllib.parse, base64
with open('localhost.har') as f:
    har = json.load(f)
for e in har['log']['entries']:
    url = e['request']['url']
    if '/_serverFn/' not in url:
        continue
    qs = url.split('?')[1] if '?' in url else ''
    params = urllib.parse.parse_qs(qs)
    if 'payload' in params:
        payload = json.loads(urllib.parse.unquote(params['payload'][0]))
        # Extract the "data" (path) from TanStack's serialized payload
        print(f"{e.get('time',0):.0f}ms  skuId={'skuId' in str(payload)}")
```

If you see two calls for the same slug (one with `skuId`, one without), this is the double-fetch.

---

## Fix 1: Same-Product Variants — `replaceState` (Zero Fetch)

Replace `<Link>` with `<a>` + `window.history.replaceState`. This changes the URL for bookmarking without triggering any TanStack Router navigation or loader.

### Before (slow)

```typescript
import { Link } from "@tanstack/react-router";

function VariantSelector({ product }: { product: Product }) {
  const possibilities = useVariantPossibilities(hasVariant, product);
  return (
    // ...
    <Link to={relativeLink} preload="intent">
      <Avatar variant={relativeLink === relative(url) ? "active" : "default"} />
    </Link>
  );
}
```

### After (instant)

```typescript
import { useState, useCallback } from "react";

function VariantSelector({ product }: { product: Product }) {
  const possibilities = useVariantPossibilities(hasVariant, product);
  const [currentUrl, setCurrentUrl] = useState(() => relative(product.url));

  const handleVariantClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>, link: string) => {
      e.preventDefault();
      setCurrentUrl(link);
      window.history.replaceState(null, "", link);
    },
    [],
  );

  return (
    // ...
    <a
      href={relativeLink ?? "#"}
      onClick={(e) => relativeLink && handleVariantClick(e, relativeLink)}
    >
      <Avatar
        variant={relativeLink === currentUrl ? "active" : relativeLink ? "default" : "disabled"}
      />
    </a>
  );
}
```

### Why This Works

1. `replaceState` changes browser URL without notifying TanStack Router → **zero loader execution**
2. `useState(currentUrl)` tracks the active variant for UI highlighting → **instant re-render**
3. `<a href>` preserves accessibility (right-click, ctrl+click open in new tab)
4. The CMS PDP Loader does NOT use `skuId` from the URL — all variant data is in `isVariantOf.hasVariant`

### When NOT to Use replaceState

- The variant changes the **product** (different `productGroupID`) — use `navigate()` instead
- The server loader actually reads `skuId` from the request URL to fetch different data
- SEO requires each variant to be a separate indexable page with unique server-rendered content

---

## Fix 2: Cross-Product Variants — `navigate()` with Loading

For `SkuVariation` (different products shown as visual variations), use `navigate()` but WITHOUT `preload="intent"` and WITH a loading state.

```typescript
import { useNavigate } from "@tanstack/react-router";
import { useState, useCallback, useEffect, useRef } from "react";

export default function SkuVariation({ products }: { products: Product[] | null }) {
  const [loadingIdx, setLoadingIdx] = useState<number | null>(null);
  const navigate = useNavigate();
  const prevProducts = useRef(products);

  // Reset loading when products change (navigation completed, component reused)
  useEffect(() => {
    if (prevProducts.current !== products) {
      setLoadingIdx(null);
      prevProducts.current = products;
    }
  }, [products]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>, link: string, idx: number) => {
      e.preventDefault();
      setLoadingIdx(idx);
      navigate({ to: link });
    },
    [navigate],
  );

  if (!products?.length) return null;

  return (
    <ul>
      {products.map((product, index) => {
        const link = relative(product.url) ?? "#";
        const isLoading = loadingIdx === index;
        return (
          <li key={index}>
            <a href={link} onClick={(e) => handleClick(e, link, index)} className="relative">
              <div className={`transition-opacity ${isLoading ? "opacity-30" : ""}`}>
                <img src={product.image?.[0]?.url} width={35} height={35} />
              </div>
              {isLoading && (
                <span className="loading loading-spinner loading-xs absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
              )}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
```

### Key Details

| Aspect | Why |
|--------|-----|
| `preload={false}` / no preload | Prevents duplicate fetch (hover + click) |
| `useRef(prevProducts)` + `useEffect` | Resets loading when component reuses with new props |
| No `await navigate()` | `navigate` resolves when route renders — component may already be unmounted |
| `<a href>` not `<Link>` | Avoids TanStack Router's built-in prefetch behavior |

---

## Fix 3: Remove `preload="intent"` from All Variant Links

Any `<Link>` with `preload="intent"` in variant selectors causes prefetch on hover, leading to:
- Extra server calls
- Race conditions with the click navigation
- Wasted bandwidth

Replace with `preload={false}` or use `<a>` elements:

```bash
# Find all variant links with preload="intent"
rg 'preload="intent"' src/components/product/ --glob '*.tsx' -l
```

Files to check:
- `ProductVariantSelector.tsx`
- `SkuVariation.tsx`
- `ProductCardCategory.tsx` (variant selector in PLP cards)

---

## Verification

After applying fixes, export a new HAR and verify:

1. **Same-product variant click**: Zero `loadCmsPage` calls (only image requests)
2. **Cross-product variant click**: Exactly 1 `loadCmsPage` call per product
3. **No duplicate calls**: Each unique slug appears at most once

```python
# Quick HAR verification
server_calls = [e for e in har['log']['entries'] if '/_serverFn/' in e['request']['url']]
print(f"Server calls: {len(server_calls)}")
# Should be 0 for same-product variants, N for N different products
```

---

## Related Configuration

### `ignoreSearchParams` in Route Config

The CMS catch-all route should filter `skuId` from `loaderDeps`:

```typescript
const config = cmsRouteConfig({
  siteName: "My Store",
  defaultTitle: "My Store",
  ignoreSearchParams: ["skuId"],
});
```

This prevents `skuId` changes from being treated as dependency changes by TanStack Router.

### `staleTime` in Dev Mode

With `staleTime: 0` (default in dev), even identical `loaderDeps` trigger re-fetch. Set a minimum staleTime in dev:

```typescript
// In routeCacheDefaults()
if (isDev) return { staleTime: 5_000, gcTime: 30_000 };
```

---

## Related Skills

| Skill | Purpose |
|-------|---------|
| `deco-cms-layout-caching` | Cache layout sections (Header/Footer) to avoid redundant API calls |
| `deco-api-call-dedup` | In-flight deduplication for VTEX API calls |
| `deco-cms-route-config` | CMS route configuration in `@decocms/start` |
| `deco-tanstack-storefront-patterns` | General patterns for deco-start storefronts |
