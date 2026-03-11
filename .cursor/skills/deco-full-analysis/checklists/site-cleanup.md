# Site Cleanup Checklist

Patterns for cleaning up Deco sites, removing dead code, and simplifying architecture. Based on real migration work from casaevideo.

## Platform File Cleanup

Most Deco sites start from the storefront template which includes files for **all** supported platforms (VTEX, Shopify, Wake, Linx, VNDA, Nuvemshop). If your site only uses one platform, the other files are dead weight causing:

- **TypeScript errors** when imports break
- **Larger bundle analysis** (unused code is still parsed)
- **Confusion** for developers
- **Stale code** that accumulates over time

### 1. Identify Unused Platform Files

**Check**: Which platform does the site actually use?

```bash
# Check apps configuration
grep -r "__resolveType.*apps/vtex\|apps/shopify\|apps/wake\|apps/linx\|apps/vnda\|apps/nuvemshop" .deco/blocks/

# Check deno.json for platform imports
grep -E "vtex|shopify|wake|linx|vnda|nuvemshop" deno.json
```

**Common locations of platform-specific files:**

| Directory | Pattern | Purpose |
|-----------|---------|---------|
| `components/header/Buttons/Cart/` | `{platform}.tsx` | Cart button per platform |
| `components/minicart/` | `{platform}/Cart.tsx` | Minicart implementation |
| `components/product/AddToCartButton/` | `{platform}.tsx` | Add to cart button |
| `islands/AddToCartButton/` | `{platform}.tsx` | Interactive cart buttons |
| `islands/Header/Cart/` | `{platform}.tsx` | Header cart islands |

### 2. Delete Unused Platform Files

For a VTEX-only site, remove these files:

```bash
# Cart buttons (header)
rm components/header/Buttons/Cart/{linx,shopify,vnda,wake,nuvemshop}.tsx

# Minicart implementations
rm -rf components/minicart/{linx,shopify,vnda,wake,nuvemshop}/

# Add to cart buttons
rm components/product/AddToCartButton/{linx,shopify,vnda,wake,nuvemshop}.tsx

# Islands
rm islands/AddToCartButton/{linx,shopify,vnda,wake,nuvemshop}.tsx
rm islands/Header/Cart/{linx,shopify,vnda,wake,nuvemshop}.tsx
```

**For Shopify-only sites**, delete vtex, wake, linx, vnda, nuvemshop. And so on.

### 3. Simplify Platform Switching Logic

After removing files, simplify components that had platform conditionals:

**Before (multi-platform):**
```typescript
// components/minicart/Cart.tsx
import { lazy } from "preact/compat";
import type { usePlatform } from "$store/sdk/usePlatform.tsx";

const CartVTEX = lazy(() => import("./vtex/Cart.tsx"));
const CartVNDA = lazy(() => import("./vnda/Cart.tsx"));
const CartWake = lazy(() => import("./wake/Cart.tsx"));
const CartLinx = lazy(() => import("./linx/Cart.tsx"));
const CartShopify = lazy(() => import("./shopify/Cart.tsx"));
const CartNuvemshop = lazy(() => import("./nuvemshop/Cart.tsx"));

export interface Props {
  platform: ReturnType<typeof usePlatform>;
  minicartProps: MinicartProps;
}

function Cart({ platform, minicartProps }: Props) {
  if (platform === "vtex") return <CartVTEX minicartProps={minicartProps} />;
  if (platform === "vnda") return <CartVNDA />;
  if (platform === "wake") return <CartWake />;
  // ... etc
  return null;
}
```

**After (VTEX-only):**
```typescript
// components/minicart/Cart.tsx
import { lazy } from "preact/compat";
import type { MinicartProps } from "$store/components/header/Drawers.tsx";

const CartVTEX = lazy(() => import("./vtex/Cart.tsx"));

export interface Props {
  minicartProps: MinicartProps;
}

function Cart({ minicartProps }: Props) {
  return <CartVTEX minicartProps={minicartProps} />;
}

export default Cart;
```

### 4. Clean Up apps/site.ts

Remove unused platform imports and simplify the Platform type:

**Before:**
```typescript
import { color as shopify } from "apps/shopify/mod.ts";
import { color as vnda } from "apps/vnda/mod.ts";
import type vtex from "apps/vtex/mod.ts";
import { color as vtexColor } from "apps/vtex/mod.ts";
import { color as wake } from "apps/wake/mod.ts";
import { color as linx } from "apps/linx/mod.ts";
import { color as nuvemshop } from "apps/nuvemshop/mod.ts";

export type Platform = "vtex" | "vnda" | "shopify" | "wake" | "linx" | "nuvemshop" | "custom";
```

**After:**
```typescript
import vtex, { color as vtexColor } from "apps/vtex/mod.ts";

export type Platform = "vtex" | "custom";
```

### 5. Clean Up runtime.ts

Remove unused manifest imports:

```diff
- import vnda from "apps/vnda/manifest.gen.ts";

  import manifest from "./manifest.gen.ts";

  export const invoke = Deco.init({
    manifest,
-   importMap: { "apps/vnda/": vnda },
  });
```

## Component Props Cleanup

### 6. Remove Unused `platform` Props

After platform simplification, many components pass a `platform` prop that's no longer needed:

```typescript
// Before: Header passes platform to children
interface Props {
  platform: Platform;
  // ...
}

// After: Remove platform prop entirely
interface Props {
  // ...
}
```

Search for components still passing platform:
```bash
grep -rn "platform={platform}" components/
grep -rn "usePlatform()" components/
```

## Runtime Type Fixes

### 7. Custom Types for GraphQL Responses

When VTEX GraphQL responses don't match official types, create custom interfaces:

```typescript
// loaders/getOrderingOrders.ts
// The official Order type from apps/vtex/utils/types.ts 
// is for REST API, not GraphQL queries

export interface VtexOrderData {
  orderId: string;
  status: string;
  creationDate: string;
  totals: Array<{
    id: string;
    name: string;
    value: number;
  }>;
  // ... only the fields actually returned by your query
}

// Then use this type instead of importing from vtex/utils/types.ts
export default async function loader(): Promise<VtexOrderData[]> {
  // ...
}
```

### 8. Third-Party SDK Types

When integrating third-party SDKs (Emarsys, Google Analytics, etc.), add proper types to `global.d.ts`:

```typescript
// types/global.d.ts
interface RecommendOptions {
  logic?: string;
  containerId?: string;
  limit?: number;
  filters?: Record<string, unknown>;
}

interface ScarabQueue {
  push: (args: [string, ...unknown[]]) => void;
  recommend?: (options: RecommendOptions) => void;
}

declare global {
  interface Window {
    ScarabQueue?: ScarabQueue;
    // Other third-party globals
  }
}

export {};
```

### 9. Export Props from Section Wrappers

When a section re-exports from an island, also export the Props type:

```typescript
// sections/Live.tsx
// Bad: Missing Props export causes TypeScript errors
export { default } from "$store/islands/Live.tsx";

// Good: Export both default and Props
export { default, type Props } from "$store/islands/Live.tsx";

export const LoadingFallback = () => {
  return <div></div>;
};
```

## Quick Audit Commands

```bash
# Find all platform files
find . -name "*.tsx" | xargs grep -l "platform.*vtex\|platform.*shopify" | head -20

# Find unused platform imports
grep -rn "from.*apps/shopify\|from.*apps/wake\|from.*apps/linx\|from.*apps/vnda\|from.*apps/nuvemshop" --include="*.ts" --include="*.tsx"

# Find usePlatform calls (candidates for removal)
grep -rn "usePlatform()" components/ sections/ islands/

# Find platform conditionals
grep -rn 'platform === "shopify"\|platform === "wake"' components/ sections/

# Count platform-specific files
for platform in vtex shopify wake linx vnda nuvemshop; do
  echo "$platform: $(find . -name "*$platform*" -type f | wc -l) files"
done
```

## Cleanup Impact

For casaevideo (VTEX-only site), this cleanup removed:

| Metric | Before | After | Reduction |
|--------|--------|-------|-----------|
| Platform files | 25 | 0 | -25 files |
| Lines of code | ~564 | 0 | -564 LOC |
| TypeScript errors | 15+ | 0 | Fixed |
| Component complexity | Multi-platform conditionals | Single path | Simpler |

## When NOT to Clean Up

- **Multi-tenant setups**: If the same codebase serves multiple platforms
- **Migration in progress**: If you're moving from one platform to another
- **Shared components**: If you maintain a template for multiple stores
