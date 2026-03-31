# Commerce & Widget Types Migration

## Commerce Types

Commerce types live in `@decocms/apps/commerce/types`. Import directly:

```typescript
import type { Product, AnalyticsItem, BreadcrumbList } from "@decocms/apps/commerce/types";
```

Key types available: `Product`, `ProductGroup`, `ProductListingPage`, `ProductDetailsPage`, `Offer`, `AggregateOffer`, `UnitPriceSpecification`, `ImageObject`, `PropertyValue`, `BreadcrumbList`, `SiteNavigationElement`, `Brand`, `Review`, `AggregateRating`, `Filter`, `FilterToggle`, `FilterRange`, `SortOption`, `PageInfo`, `Suggestion`, `Search`, `AnalyticsItem`, `AddToCartParams`.

Replace old imports:
```bash
sed -i '' 's|from "apps/commerce/types.ts"|from "@decocms/apps/commerce/types"|g'
sed -i '' 's|from "~/types/commerce"|from "@decocms/apps/commerce/types"|g'
```

## Commerce Utilities

Also from `@decocms/apps`:

```typescript
import { mapProductToAnalyticsItem } from "@decocms/apps/commerce/utils/productToAnalyticsItem";
import { parseRange, formatRange } from "@decocms/apps/commerce/utils/filters";
```

Replace old imports:
```bash
sed -i '' 's|from "apps/commerce/utils/productToAnalyticsItem.ts"|from "@decocms/apps/commerce/utils/productToAnalyticsItem"|g'
sed -i '' 's|from "apps/commerce/utils/filters.ts"|from "@decocms/apps/commerce/utils/filters"|g'
```

## Widget Types

CMS widget types are site-local since they're just string aliases. Create `~/types/widgets.ts`:

```typescript
export type ImageWidget = string;
export type HTMLWidget = string;
export type VideoWidget = string;
export type TextWidget = string;
export type RichText = string;
export type Secret = string;
export type Color = string;
export type ButtonWidget = string;
```

Replace:
```bash
sed -i '' 's|from "apps/admin/widgets.ts"|from "~/types/widgets"|g'
```

## UI Components (Site-Local)

Image, Picture, Seo, Theme etc. are **site-local components** -- they do NOT belong in `@decocms/apps`.

Create these in `~/components/ui/`:
- `Image.tsx` - thin `<img>` wrapper (accepts `preload`, `fit` props for API compat)
- `Picture.tsx` - `<picture>` + `<Source>` wrapper
- `Seo.tsx` - head meta tags (stub or real implementation)
- `Theme.tsx` - CSS variable injection (stub or real)
- `PoweredByDeco.tsx` - footer badge
- `Video.tsx` - `<video>` wrapper
- `SeoPreview.tsx` - admin SEO preview (stub)

Replace:
```bash
sed -i '' 's|from "apps/website/components/Image.tsx"|from "~/components/ui/Image"|g'
sed -i '' 's|from "apps/website/components/Picture.tsx"|from "~/components/ui/Picture"|g'
```

## Verification

```bash
grep -r 'from "apps/' src/ --include='*.ts' --include='*.tsx'
# Should return ZERO matches
```
