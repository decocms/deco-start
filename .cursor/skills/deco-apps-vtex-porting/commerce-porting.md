# Commerce Module Porting

How the shared `commerce/` module from `deco-cx/apps` maps to `apps-start/commerce/`.

## Structure Comparison

```
Original (apps/commerce/)           apps-start (commerce/)
═══════════════════════            ════════════════════════
types.ts (786 lines)          →    types/commerce.ts (same types)
mod.ts (app factory)          →    Not needed
manifest.gen.ts               →    Not needed

utils/canonical.ts            →    utils/canonical.ts ✅
utils/constants.ts            →    utils/constants.ts ✅
utils/filters.ts              →    utils/filters.ts ✅
utils/productToAnalyticsItem  →    utils/productToAnalyticsItem.ts ✅
utils/stateByZip.ts           →    utils/stateByZip.ts ✅

loaders/navbar.ts             →    Part of vtex/loaders/navbar.ts (platform-specific)
loaders/extensions/*          →    Not needed (Deco block system)
loaders/product/*             →    Not needed (Deco block system)

sections/Seo/*                →    Storefront handles SEO locally

N/A (was in site sdk/)        →    sdk/useOffer.ts ✅ (NEW)
N/A                           →    sdk/useVariantPossibilities.ts ✅ (NEW)
N/A                           →    sdk/formatPrice.ts ✅ (NEW)
N/A                           →    sdk/url.ts ✅ (NEW)
N/A                           →    sdk/analytics.ts ✅ (NEW)
N/A                           →    components/Image.tsx ✅ (NEW)
N/A                           →    components/JsonLd.tsx ✅ (NEW)
```

## Key Improvement: SDK in Library

In the original architecture, utilities like `useOffer`, `formatPrice`, `useVariantPossibilities` lived in each site's `sdk/` folder. This meant every store had its own copy that could drift.

In apps-start, these are centralized in `commerce/sdk/` and imported as:

```typescript
import { useOffer } from "@decocms/apps/commerce/sdk/useOffer";
import { formatPrice } from "@decocms/apps/commerce/sdk/formatPrice";
import { useVariantPossibilities } from "@decocms/apps/commerce/sdk/useVariantPossibilities";
import { relative } from "@decocms/apps/commerce/sdk/url";
import { sendEvent } from "@decocms/apps/commerce/sdk/analytics";
```

## Types Mapping

The `commerce/types/commerce.ts` in apps-start should be a direct port of `commerce/types.ts` from the original. All schema.org types must match exactly.

### Verification

```bash
# Compare type names between original and port
rg "export (interface|type|enum)" apps/commerce/types.ts | sort
rg "export (interface|type|enum)" apps-start/commerce/types/commerce.ts | sort
```

## Utils Porting

### canonical.ts — Direct Copy
```typescript
export const canonicalFromBreadcrumblist = (b?: BreadcrumbList) => {
  const items = b?.itemListElement ?? [];
  if (!Array.isArray(items) || items.length === 0) return undefined;
  return items.reduce((acc, curr) => acc.position < curr.position ? curr : acc).item;
};
```

### constants.ts — Direct Copy
```typescript
export const DEFAULT_IMAGE: ImageObject = {
  "@type": "ImageObject",
  encodingFormat: "image",
  alternateName: "Default Image Placeholder",
  url: "https://ozksgdmyrqcxcwhnbepg.supabase.co/storage/v1/object/public/assets/1818/ff6bb37e-...",
};
```

### filters.ts — Direct Copy
```typescript
export const parseRange = (price: string) => { /* ... */ };
export const formatRange = (from: number, to: number) => `${from}:${to}`;
```

### productToAnalyticsItem.ts — Adapt Imports Only
Change `from "../types.ts"` to `from "../types/commerce"`.

### stateByZip.ts — Direct Copy
No dependencies.

## SDK Utilities

These are new to apps-start — they came from individual site repos:

### useOffer.ts
Extracts price/installment/seller from AggregateOffer:
```typescript
export function useOffer(aggregateOffer?: AggregateOffer) {
  const offer = aggregateOffer?.offers?.[0]; // Best offer
  return {
    price: offer?.price,
    listPrice: /* ... */,
    seller: offer?.seller,  // MUST be sellerId
    installment: /* find best installment */,
    availability: offer?.availability,
  };
}
```

### useVariantPossibilities.ts
Groups product variants by property name:
```typescript
export function useVariantPossibilities(product: ProductGroup) {
  // Returns Map<propertyName, Map<propertyValue, ProductLeaf>>
}
```

### formatPrice.ts
Formats currency values:
```typescript
export function formatPrice(price?: number, currency = "BRL", locale = "pt-BR") {
  return price?.toLocaleString(locale, { style: "currency", currency });
}
```

## Components

### Image.tsx
Thin wrapper around `<img>` with optimization hints:
```typescript
export function Image(props: ImageProps) {
  // Handles: width/height, loading="lazy", fetchPriority, src transformation
  return <img {...adaptedProps} />;
}
```

### JsonLd.tsx
Structured data renderer:
```typescript
export function JsonLd<T>(props: { data: T }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(props.data) }} />;
}
```

## What the Storefront Provides Locally

These are NOT in apps-start — each site creates its own:

- `components/Picture.tsx` — `<picture>` with `<source>` for responsive images
- `components/Seo.tsx` — Head meta tags (title, description, og:*, etc.)
- `components/Theme.tsx` — CSS variable injection
- `types/widgets.ts` — CMS widget type aliases (ImageWidget = string, etc.)
