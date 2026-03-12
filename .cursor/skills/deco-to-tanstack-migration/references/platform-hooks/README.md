# Platform Hooks Migration

Platform hooks (useCart, useUser, useWishlist) are the most complex migration target because they have real business logic.

## Strategy

All hooks are **site-local**. No Vite alias tricks. No compat layers.

- Active platform hooks (VTEX for this store) -> `~/hooks/useCart.ts` with real implementation
- Inactive platform hooks (Wake, Shopify, etc.) -> `~/hooks/platform/{name}.ts` with no-op stubs
- Auth hooks -> `~/hooks/useUser.ts`, `~/hooks/useWishlist.ts`

## VTEX useCart (Real Implementation)

### Why Server Functions Are Required

The storefront domain (e.g., `my-store.deco.site`) differs from the VTEX checkout domain (`account.vtexcommercestable.com.br`). Direct browser `fetch()` calls are blocked by CORS. Additionally, VTEX API credentials (`AppKey`/`AppToken`) must stay server-side.

Use TanStack Start `createServerFn` to create server-side proxy functions that the client hook calls transparently.

> See `references/server-functions/README.md` for the full pattern and all TypeScript pitfalls.

### Server Functions (`src/server/invoke.ts`)

Wrap `@decocms/apps` VTEX actions in `createServerFn`. Always use `.inputValidator()` (not `.validator()`) and return `Promise<any>` to bypass `ValidateSerializable`:

```typescript
import { createServerFn } from "@tanstack/react-start";
import { getOrCreateCart } from "@decocms/apps/vtex/actions/checkout";

// Preferred: wrap @decocms/apps actions (handles auth + API details internally)
const _getOrCreateCart = createServerFn({ method: "POST" })
  .inputValidator((data: { orderFormId?: string }) => data)
  .handler(async ({ data }): Promise<any> => {
    const result = await getOrCreateCart(data.orderFormId);
    return (result as any).data;
  });

export const invoke = {
  vtex: { actions: { getOrCreateCart: _getOrCreateCart } },
} as const;
```

### Hook (~/hooks/useCart.ts)

Key design decisions:
- **Module-level singleton state** shared across all component instances
- **Pub/sub pattern** (`_listeners` Set) for notifying React components of changes
- **Cookie-based session**: reads/writes `checkout.vtex.com__orderFormId` on the **client** side (not VTEX's domain cookie)
- Returns `cart` and `loading` with `.value` getter/setter for backward compat with Preact-era components
- Lazy initialization: cart is fetched on first component mount, not on module load
- Exports `itemToAnalyticsItem` for cart-specific analytics mapping

### Cross-Domain Checkout

The minicart's "Finalizar Compra" button must link to the VTEX checkout domain with the `orderFormId` as a query parameter — the VTEX domain can't read the storefront's cookies:

```typescript
const checkoutUrl = `https://secure.${STORE_DOMAIN}/checkout/?orderFormId=${orderFormId}`;
```

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
