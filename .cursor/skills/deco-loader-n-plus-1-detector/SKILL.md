---
name: deco-loader-n-plus-1-detector
description: Detect and fix N+1 API call patterns in Deco storefront section loaders. Finds loops calling individual VTEX/Shopify APIs per product instead of batching or using already-available data. Use when investigating slow page loads, high API latency, rate limiting (429s), or when optimizing SSR performance on Deco sites (Fresh or TanStack Start).
---

# Deco Loader N+1 Detector

Finds N+1 API call anti-patterns in Deco storefront section loaders — the #1 cause of slow SSR on e-commerce sites.

## When to Use

- Page loads are slow (SSR > 3s)
- Terminal logs show many sequential/parallel API calls for the same endpoint
- VTEX returns 429 (Too Many Requests) errors
- User reports "a troca de pagina ta demorando"
- After migrating loaders or adding new shelf/search sections

## What It Finds

| Pattern | Severity | Example |
|---------|----------|---------|
| **API call inside `.map()`** | Critical | `products.map(p => getSpec(p.id))` |
| **Missing batch alternative** | High | Individual calls where batch API exists |
| **Redundant data fetch** | High | Fetching data already in the Product object |
| **Sequential awaits in loop** | Medium | `for (p of products) { await fetch(p) }` |
| **Unbounded parallel calls** | Medium | `Promise.all(100items.map(fetch))` |

## Workflow

```
1. Scan loaders → Find .map() + await + API call patterns
2. Identify the API → Catalog, IS, simulation, masterdata
3. Check if data is already available → Product.additionalProperty, offers, etc.
4. If redundant → Remove the call, read from existing data
5. If needed → Create batch endpoint or add caching
6. Verify → Check terminal logs for eliminated calls
```

## Step 1: Scan for N+1 Patterns

Search for the telltale pattern: an API call inside a `.map()` or `forEach()` within a loader.

### Search Commands

```bash
# Find all loaders that call external APIs inside map/forEach
grep -rn "\.map(.*async" src/components/ src/sections/ --include="*.tsx" --include="*.ts" | grep -i "loader\|export const loader"

# Find getProductSpecification calls (most common N+1)
grep -rn "getProductSpecification" src/

# Find any VTEX API call inside a map
grep -rn "vtexFetch\|vtex.*fetch\|catalog_system\|intelligent-search" src/ --include="*.tsx" --include="*.ts"

# Find simulation calls per product
grep -rn "cartSimulation\|usePriceSimulation" src/ --include="*.tsx" --include="*.ts"
```

### Red Flag Patterns

```typescript
// RED FLAG: API call per product in a map
export const loader = async (props: Props, _req: Request) => {
  const results = props.products?.map(async (product) => {
    const extra = await someApiCall(product.id);  // N+1!
    return { ...product, extra };
  });
  return { ...props, results: await Promise.all(results) };
};
```

## Step 2: Classify the API Call

| API Endpoint | What It Returns | Already in Product? |
|--------------|-----------------|---------------------|
| `/api/catalog_system/pvt/products/{id}/Specification` | Product specs by numeric ID | Yes — `product.isVariantOf.additionalProperty` |
| `/api/catalog_system/pub/products/crossselling/{id}/*` | Related products | No — but should be 1 call per page, not per product |
| `/api/checkout/pub/orderForms/simulation` | Price simulation | No — needs CEP, legitimate per-product call |
| `/api/catalog_system/pub/products/variations/{id}` | SKU variations | Yes — `product.isVariantOf.hasVariant` |
| `/api/dataentities/{entity}/search` | MasterData docs | No — check if can be batched with `_where=id=1 OR id=2` |

## Step 3: Check If Data Already Exists

### Product Specifications (Most Common N+1)

The VTEX Intelligent Search API returns `specificationGroups` which the `@decocms/apps` transform converts to `product.isVariantOf.additionalProperty`.

**Catalog API format** (what `getProductSpecification` returns):
```json
[{ "Id": 208, "Name": "Rendimento", "Value": ["4.5"] }]
```

**Schema.org format** (already in `product.isVariantOf.additionalProperty`):
```json
[{ "name": "Rendimento", "value": "4.5", "propertyID": "groupName", "valueReference": "PROPERTY" }]
```

To use the existing data, create a bridge helper:

```typescript
// src/sdk/productSpecs.ts
import type { Product } from "@decocms/apps/commerce/types";

const SPEC_NAME_TO_ID: Record<string, number> = {
  // Map exact IS spec names → legacy numeric IDs used by components
  // IMPORTANT: verify exact names via IS API, some have double spaces
};

export function getSpecsFromProduct(product: Product) {
  const props = product.isVariantOf?.additionalProperty ?? [];
  const specs: Array<{ Id: number; Value: string[] }> = [];
  for (const p of props) {
    if (p.valueReference !== "PROPERTY") continue;
    const id = SPEC_NAME_TO_ID[p.name];
    if (id == null) continue;
    const existing = specs.find((s) => s.Id === id);
    if (existing) existing.Value.push(p.value);
    else specs.push({ Id: id, Value: [p.value] });
  }
  return specs;
}
```

### How to Discover Spec Names

```bash
# Hit the IS API directly and inspect specificationGroups
curl -s "https://{account}.vtexcommercestable.com.br/api/io/_v/api/intelligent-search/product_search/?count=3&query={product-type}&sc=1" \
  | python3 -c "
import json, sys
for p in json.load(sys.stdin).get('products', []):
    print(p['productId'], '-', p['productName'][:60])
    for g in p.get('specificationGroups', []):
        if g['name'] == 'allSpecifications':
            for s in g['specifications']:
                print(f'  \"{s[\"name\"]}\": {[v[:40] for v in s[\"values\"]]}')
    print('---')
"
```

### SKU Variations

If calling `/api/catalog_system/pub/products/variations/{id}`:
- Already available in `product.isVariantOf.hasVariant`
- Each variant has `additionalProperty` with variation attributes

### Product Reviews/Ratings

If calling an external review API per product in shelves:
- Consider lazy-loading reviews only on PDP
- Or batch the API if it supports multiple product IDs

## Step 4: Fix Strategies

### Strategy A: Use Existing Data (Best)

Replace the API call with a synchronous read from the Product object.

**Before** (N HTTP calls):
```typescript
const productAdditional = await getProductSpecification(element.inProductGroupWithID);
```

**After** (0 HTTP calls):
```typescript
const productAdditional = getSpecsFromProduct(element);
```

### Strategy B: Create Batch Endpoint

When the data genuinely doesn't exist in the Product:

```typescript
// apps-start/vtex/loaders/catalog.ts
export async function getProductSpecifications(productIds: string[]) {
  return Promise.all(
    productIds.map(id => vtexFetch(`/api/catalog_system/pvt/products/${id}/Specification`))
  );
}
```

Even `Promise.all` with N calls is better than sequential awaits, but a true batch API is ideal.

### Strategy C: Cache + Deduplicate

For data that changes infrequently:

```typescript
const specCache = new Map<string, any>();

export async function getCachedSpec(productId: string) {
  if (specCache.has(productId)) return specCache.get(productId)!;
  const result = await getProductSpecification(productId);
  specCache.set(productId, result);
  return result;
}
```

### Strategy D: Lazy Load on Client

Move enrichment to client-side for non-critical data:

```typescript
// Component fetches specs only when visible
const [specs, setSpecs] = useState(null);
useEffect(() => {
  if (inView) fetchSpecs(productId).then(setSpecs);
}, [inView]);
```

## Step 5: Verify the Fix

### Check Terminal Logs

After fixing, the terminal should show **zero** calls to the eliminated endpoint:

```bash
# Before: dozens of these per page load
[vtex] GET .../api/catalog_system/pvt/products/123/Specification
[vtex] GET .../api/catalog_system/pvt/products/456/Specification
# ... 20+ more

# After: none of these, only intelligent-search calls
[vtex] GET .../api/io/_v/api/intelligent-search/product_search/...
```

### Measure Response Time

```bash
# Cold start
curl -s -o /dev/null -w "%{http_code} %{time_total}s" http://localhost:5173/

# Warm request
curl -s -o /dev/null -w "%{http_code} %{time_total}s" http://localhost:5173/
```

Expected improvement: 2-15 seconds faster on pages with multiple shelves.

## Common N+1 Locations in Deco Sites

| Component | File Pattern | Typical N+1 |
|-----------|-------------|-------------|
| ProductShelf | `components/product/ProductShelf.tsx` | `getProductSpecification` per product |
| SearchResult | `components/search/SearchResult.tsx` | `getProductSpecification` per product |
| ProductTabbedShelf | `components/product/ProductTabbedShelf/` | Specs per product per tab |
| BuyTogether | `components/product/BuyTogether/` | Cross-selling + specs per suggestion |
| HouseCatalog | `components/search/HouseCatalog/` | Specs + simulation per product |
| ProductShelfDinamica | `components/product/ProductShelfDinamica.tsx` | Specs per product in dynamic shelf |

## Quick Audit Checklist

- [ ] Search for `getProductSpecification` — replace with `getSpecsFromProduct` in shelf loaders
- [ ] Search for `.map(async` inside `export const loader` — each is a potential N+1
- [ ] Check for `usePriceSimulation` in loops — legitimate but verify it's parallelized
- [ ] Check for `getCrossSelling` in loops — should only be on PDP, not shelves
- [ ] Verify `Promise.all` wraps parallel calls — not sequential `await` in `for` loop
- [ ] Check terminal logs for repeated API patterns during page load
- [ ] Measure SSR time before and after changes

## Impact Reference

| Products on Page | N+1 Calls | Latency per Call | Total Added Latency |
|------------------|-----------|------------------|---------------------|
| 12 (1 shelf) | 12 | ~370ms | ~4.4s |
| 24 (PLP) | 24 | ~370ms | ~8.9s |
| 48 (PLP + 2 shelves) | 48 | ~370ms | ~17.8s |
| 100 (homepage) | 100 | ~370ms | ~37s |

Even with parallelism, VTEX rate limits kick in after ~20 concurrent calls, serializing the rest.

## Related Skills

- [deco-performance-audit](../deco-performance-audit/SKILL.md) — CDN-level metrics and cache analysis
- [deco-full-analysis](../deco-full-analysis/SKILL.md) — Full site architecture analysis
- [deco-edge-caching](../deco-edge-caching/SKILL.md) — Cache headers and edge configuration
