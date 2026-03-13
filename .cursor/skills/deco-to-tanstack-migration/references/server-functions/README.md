# Server Functions (`createServerFn`)

All VTEX API calls that need credentials (cart, MasterData, session, newsletter, shipping simulation) must run on the Worker — not on the client — to avoid CORS errors and keep secrets server-side.

## Pattern: `src/server/invoke.ts`

Create a single file that wraps `@decocms/apps` invoke functions in `createServerFn`. This keeps VTEX credentials inside the Worker and gives type-safe RPC from the browser.

```typescript
import { createServerFn } from "@tanstack/react-start";
import {
  getOrCreateCart,
  addItemsToCart,
  updateCartItems,
  addCouponToCart,
  updateOrderFormAttachment,
  simulateCart,
} from "@decocms/apps/vtex/actions/checkout";

// CRITICAL: always chain .inputValidator() before .handler()
// Without it, ctx.data is typed as `undefined` and every access fails.
const _getOrCreateCart = createServerFn({ method: "POST" })
  .inputValidator((data: { orderFormId?: string }) => data)
  .handler(async ({ data }): Promise<any> => {
    // Promise<any> bypasses ValidateSerializable on OrderForm.storeId: unknown
    const result = await getOrCreateCart(data.orderFormId);
    return (result as any).data;
  });

const _addItemsToCart = createServerFn({ method: "POST" })
  .inputValidator((data: {
    orderFormId: string;
    orderItems: Array<{ id: string; seller: string; quantity: number }>;
  }) => data)
  .handler(async ({ data }): Promise<any> => {
    const result = await addItemsToCart(data.orderFormId, data.orderItems);
    return (result as any).data;
  });

// ... repeat for updateCartItems, addCouponToCart, simulateCart, etc.

export const invoke = {
  vtex: {
    actions: {
      getOrCreateCart: _getOrCreateCart,
      addItemsToCart: _addItemsToCart,
      // ...
    },
  },
} as const;
```

## Required: `.inputValidator()`

Without `.inputValidator()`, TanStack Start types `ctx.data` as `undefined`:

```typescript
// BROKEN — ctx.data is typed as undefined
createServerFn({ method: "POST" })
  .handler(async (ctx) => {
    ctx.data.orderFormId; // TS Error: ctx.data is undefined
  });

// CORRECT
createServerFn({ method: "POST" })
  .inputValidator((data: { orderFormId: string }) => data)
  .handler(async ({ data }) => {
    data.orderFormId; // typed correctly
  });
```

## Required: `Promise<any>` Return Type

TanStack Start validates that return types are serializable via `ValidateSerializable`. Types with `unknown` fields (e.g. `OrderForm.storeId: unknown`) fail this check at compile time:

```
Type 'OrderForm' does not satisfy the constraint 'Serializable'.
  Types of property 'storeId' are incompatible.
    Type 'unknown' is not assignable to type 'Serializable'
```

**Fix**: Annotate the handler return as `Promise<any>`:

```typescript
.handler(async ({ data }): Promise<any> => {
  return await doSomething(data);
});
```

## Stripping Non-Serializable Properties

Loader results that include function properties must have those functions removed before being returned — Seroval (TanStack's hydration serializer) cannot serialize functions.

```typescript
.handler(async ({ data }): Promise<any> => {
  const result = await productReviewsLoader(data);
  // Strip functions before serialization
  const { getProductReview: _r, reviewLikeAction: _l, ...serializable } = result as any;
  return serializable;
});
```

## Invoke from `useCart`

```typescript
// ~/hooks/useCart.ts
import { invoke } from "~/server/invoke";

const updated = await invoke.vtex.actions.addItemsToCart({
  data: { orderFormId, orderItems },
});
```

## Verification

```bash
# No direct VTEX API calls from client components
rg 'vtexcommercestable\.com\.br' src/ --include='*.tsx'
# Should return ZERO (all calls go through invoke)
```
