# Three-Layer Invoke Architecture

## Overview

Server actions in Deco storefronts follow a three-layer pattern where commerce functions are pure, the framework provides the transport bridge, and the site has a generated file that wires them together.

## Layer 1: Pure Functions (`@decocms/apps`)

Commerce actions are regular async functions with no framework dependencies:

```typescript
// @decocms/apps/vtex/actions/checkout.ts
export async function addItemsToCart(
  orderFormId: string,
  orderItems: Array<{ id: string; seller: string; quantity: number }>,
): Promise<VtexFetchResult<OrderForm>> {
  return vtexFetchWithCookies(
    `/api/checkout/pub/orderForm/${orderFormId}/items?...`,
    { method: "POST", body: JSON.stringify({ orderItems }) },
  );
}
```

These functions:
- Use `vtexFetch`/`vtexFetchWithCookies` which call the VTEX API with `appKey`/`appToken`
- Have no knowledge of how they'll be called (HTTP, RPC, direct)
- Can be tested independently
- Are the same for any framework (Fresh, TanStack, etc.)

The `invoke.ts` in `@decocms/apps/vtex/` serves as the **declaration file** — it lists which functions should be exposed as server actions, their input/output types, and whether to unwrap `VtexFetchResult`.

## Layer 2: Generator (`@decocms/start`)

The `generate-invoke.ts` script bridges Layer 1 to TanStack Start:

1. Parses `@decocms/apps/vtex/invoke.ts` with `ts-morph`
2. Extracts each action: name, imports, input type, return type, call body, unwrap flag
3. Generates `invoke.gen.ts` with top-level `createServerFn` declarations

The generator lives in `@decocms/start/scripts/generate-invoke.ts` and is framework-aware — it knows about `createServerFn` and TanStack Start's compiler constraints.

## Layer 3: Generated Bridge (Site)

The site has `src/server/invoke.gen.ts` — auto-generated, committed or gitignored:

```typescript
// Auto-generated — do not edit
import { createServerFn } from "@tanstack/react-start";
import { addItemsToCart } from "@decocms/apps/vtex/actions/checkout";

const $addItemsToCart = createServerFn({ method: "POST" })
  .handler(async (ctx) => {
    const result = await addItemsToCart(ctx.data.orderFormId, ctx.data.orderItems);
    return unwrapResult(result);
  });

export const invoke = {
  vtex: {
    actions: {
      addItemsToCart: $addItemsToCart,
      // ...
    },
  },
};
```

Components import from here:
```typescript
import { invoke } from "~/server/invoke.gen";
```

## Comparison: deco-cx/deco vs @decocms/start

### deco-cx/deco (Fresh/Deno — Production)

```
Client
  → invoke.vtex.actions.addItemsToCart(props)
  → Proxy builds key: "vtex/actions/addItemsToCart"
  → fetch("/live/invoke/vtex/actions/addItemsToCart", { body: props })
  → Hono route /live/invoke/* → resolves handler from manifest
  → addItemsToCart(props, ctx)
  → vtexFetch → VTEX API
```

Key characteristics:
- **Runtime resolution**: handler is found by key in the manifest at request time
- **HTTP transport**: `fetch()` to `/live/invoke/{key}` — explicit HTTP call
- **Proxy-based DX**: `proxy<Manifest>()` creates a JavaScript Proxy that builds the URL from property chain
- **No compiler magic**: works with any bundler, no Vite plugin needed

### @decocms/start (TanStack Start — New)

```
Client
  → invoke.vtex.actions.addItemsToCart({ data: props })
  → createClientRpc("base64id")
  → POST /_server with serialized function ID + data
  → TanStack Start deserializes, finds handler by ID
  → addItemsToCart(props)
  → vtexFetch → VTEX API
```

Key characteristics:
- **Build-time resolution**: compiler assigns each function a unique ID at build time
- **RPC transport**: `createClientRpc` handles serialization, TanStack Start routes to `/_server`
- **Direct function call DX**: the generated function is directly callable, fully typed
- **Compiler-dependent**: requires TanStack Start's Vite plugin to transform the code

### Side-by-Side

| Aspect | deco-cx/deco (Fresh) | @decocms/start (TanStack) |
|--------|---------------------|--------------------------|
| **Transport** | `fetch("/live/invoke/key")` | `createServerFn` → `/_server` RPC |
| **Registry** | `manifest.gen.ts` (runtime) | `invoke.gen.ts` (build-time) |
| **Client code** | `Proxy` object | Typed function stubs |
| **Resolution** | Runtime (key → resolver) | Build-time (compiler extracts handler) |
| **Config** | `runtime.ts` (3 lines) | `generate-invoke.ts` (build script) |
| **Framework dep** | None (plain fetch) | TanStack Start compiler |
| **Type safety** | Manifest types (generic) | Per-function types (specific) |

### What Stayed the Same

Both approaches share the core principle:
1. **Commerce functions are pure** — same `addItemsToCart()` in both stacks
2. **Client never calls VTEX directly** — always goes through the server
3. **Credentials stay server-side** — `appKey`/`appToken` never reach the browser
4. **Same invoke DX** — `invoke.vtex.actions.addItemsToCart({ data: {...} })`

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────┐
│                     BROWSER                              │
│                                                          │
│  useCart() → invoke.vtex.actions.addItemsToCart()        │
│                    │                                     │
│                    ▼                                     │
│  createClientRpc("id") → POST /_server                  │
│                    │         (same domain, no CORS)      │
└────────────────────┼─────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│                   SERVER (Vite SSR / Worker)             │
│                                                          │
│  TanStack Start deserializes → finds $addItemsToCart     │
│                    │                                     │
│                    ▼                                     │
│  addItemsToCart(orderFormId, orderItems)                 │
│  (from @decocms/apps/vtex/actions/checkout.ts)          │
│                    │                                     │
│                    ▼                                     │
│  vtexFetchWithCookies(                                  │
│    "/api/checkout/pub/orderForm/{id}/items",             │
│    { headers: { X-VTEX-API-AppKey, X-VTEX-API-AppToken }}│
│  )                                                       │
└────────────────────┼─────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│              VTEX API (server-to-server)                 │
│  vtexcommercestable.com.br                              │
│  ✓ Has credentials, ✓ No CORS, ✓ Full response          │
└─────────────────────────────────────────────────────────┘
```
