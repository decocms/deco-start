# Platform Hooks Migration

Platform hooks (useCart, useUser, useWishlist) are the most complex migration target because they have real business logic.

## Strategy

All hooks are **site-local**. No Vite alias tricks. No compat layers.

- Active platform hooks (VTEX for this store) -> `~/hooks/useCart.ts` with real implementation
- Inactive platform hooks (Wake, Shopify, etc.) -> `~/hooks/platform/{name}.ts` with no-op stubs
- Auth hooks -> `~/hooks/useUser.ts`, `~/hooks/useWishlist.ts`

## VTEX useCart (Real Implementation)

### Server Functions (~/lib/vtex-cart-server.ts)

```typescript
import { createServerFn } from "@tanstack/react-start";

export const getOrCreateCart = createServerFn({ method: "GET" })
  .validator((orderFormId: string) => orderFormId)
  .handler(async ({ data: orderFormId }) => {
    const url = orderFormId
      ? `https://{account}.vtexcommercestable.com.br/api/checkout/pub/orderForm/${orderFormId}`
      : `https://{account}.vtexcommercestable.com.br/api/checkout/pub/orderForm`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VTEX-API-AppKey": process.env.VTEX_APP_KEY!,
        "X-VTEX-API-AppToken": process.env.VTEX_APP_TOKEN!,
      },
      body: JSON.stringify({ expectedOrderFormSections: ["items", "totalizers", "shippingData", "clientPreferencesData", "storePreferencesData", "marketingData"] }),
    });
    return res.json();
  });
```

### Hook (~/hooks/useCart.ts)

Key design decisions:
- **Module-level singleton state** shared across all component instances
- **Pub/sub pattern** (`_listeners` Set) for notifying React components
- **Cookie-based session**: reads/writes `checkout.vtex.com__orderFormId`
- Returns `cart` and `loading` with `.value` getter/setter for backward compat
- Exports `itemToAnalyticsItem` for cart-specific analytics mapping

### VTEX Types (~/types/vtex.ts)

Site-local types for VTEX-specific structures:
- `OrderFormItem`, `SimulationOrderForm`, `Sla`, `SKU`, `VtexProduct`

## Inactive Platform Stubs

For non-VTEX platforms, create minimal no-op files:

```typescript
// ~/hooks/platform/wake.ts
export function useCart() {
  return {
    cart: { value: null },
    loading: { value: false },
    addItem: async (_params: any) => {},
    updateItems: async (_params: any) => {},
    removeItem: async (_index: any) => {},
  };
}

export function useUser() {
  return {
    user: { value: null as { email?: string; name?: string } | null },
    loading: { value: false },
  };
}

export function useWishlist() {
  return {
    loading: { value: false },
    addItem: async (_props: any) => {},
    removeItem: async (_props: any) => {},
    getItem: (_props: any) => undefined as any,
  };
}
```

Create similar stubs for: `shopify.ts`, `linx.ts`, `vnda.ts`, `nuvemshop.ts`.

Match the return shape to what each platform's AddToCartButton expects (some use `addItem`, others `addItems`).

## Import Rewrites

```bash
sed -i '' 's|from "apps/vtex/hooks/useCart.ts"|from "~/hooks/useCart"|g'
sed -i '' 's|from "apps/vtex/hooks/useUser.ts"|from "~/hooks/useUser"|g'
sed -i '' 's|from "apps/vtex/hooks/useWishlist.ts"|from "~/hooks/useWishlist"|g'
sed -i '' 's|from "apps/vtex/utils/types.ts"|from "~/types/vtex"|g'
sed -i '' 's|from "apps/shopify/hooks/useCart.ts"|from "~/hooks/platform/shopify"|g'
sed -i '' 's|from "apps/wake/hooks/useCart.ts"|from "~/hooks/platform/wake"|g'
# etc. for all platforms
```

## Verification

```bash
grep -r 'from "apps/' src/ --include='*.ts' --include='*.tsx'
# Should return ZERO matches
```
