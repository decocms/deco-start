# The CORS Problem — Root Cause Analysis

## Symptom

When clicking "Add to Cart" or "Compra Rápida" in a Deco TanStack Start storefront running on `localhost:5173`, the browser makes a direct request to `https://{account}.vtexcommercestable.com.br/api/checkout/pub/orderForm/...`, which fails with a CORS error because the VTEX API doesn't allow cross-origin requests from `localhost`.

## Expected Behavior

The `invoke.vtex.actions.addItemsToCart()` call should go through TanStack Start's server function mechanism:
1. Client calls the function
2. TanStack Start serializes the call and POSTs to `/_server` (same domain)
3. Server deserializes, runs the handler (which calls VTEX API server-to-server)
4. Server returns the result to the client

## Root Cause: Compiler Fast Path

TanStack Start uses a Vite plugin (`tanstack-start-core::server-fn`) that transforms `createServerFn().handler()` calls. On the **client bundle**, it replaces the handler body with a `createClientRpc()` stub that makes an HTTP call to `/_server`.

The compiler has two code paths:

### Fast Path (ServerFn only)
When a file only contains `ServerFn` kind (detected by `/\bcreateServerFn\b|\.\s*handler\s*\(/`), the compiler uses a fast path that **only scans top-level statements**:

```typescript
// compiler.ts — fast path
function areAllKindsTopLevelOnly(kinds: Set<LookupKind>): boolean {
  return kinds.size === 1 && kinds.has('ServerFn')
}

// Only visits top-level VariableDeclarators
// VariableDeclarator -> VariableDeclaration -> Program
```

### Normal Path
For files with multiple kinds (Middleware, IsomorphicFn, etc.), it does a full AST traversal.

## Why createInvokeFn Fails

The original `@decocms/start/sdk/createInvoke.ts`:

```typescript
import { createServerFn } from "@tanstack/react-start";

export function createInvokeFn(action, opts) {
  return createServerFn({ method: "POST" }).handler(async (ctx) => {
    const result = await action(ctx.data);
    // ...
  });
}
```

The file contains `createServerFn` → triggers `ServerFn` detection → **fast path activates** → only scans top-level → `.handler()` is inside `createInvokeFn` function body → **skipped**.

Result: the client bundle receives the raw code, `createServerFn` returns a function that calls `vtexFetch` directly in the browser.

## Verification

You can verify the transformation by fetching the module from Vite dev server:

```bash
# BROKEN — raw code, no transformation
curl "http://localhost:5173/@fs/.../createInvoke.ts"
# Shows: createServerFn({ method: "POST" }).handler(async (ctx) => { ... })

# FIXED — compiler transformed to RPC
curl "http://localhost:5174/src/server/invoke.gen.ts"  
# Shows: createServerFn({ method: "POST" }).handler(createClientRpc("eyJ..."))
```

The `createClientRpc("base64id")` is the RPC stub — it serializes the call and POSTs to `/_server`.

## The Fix

Each `createServerFn().handler()` must be a **top-level const declaration**:

```typescript
// WORKS — top-level const
const $addItemsToCart = createServerFn({ method: "POST" })
  .handler(async (ctx) => {
    return await addItemsToCart(ctx.data.orderFormId, ctx.data.orderItems);
  });

// DOES NOT WORK — inside a function
function createInvokeFn(action) {
  return createServerFn({ method: "POST" })
    .handler(async (ctx) => { ... });  // ← skipped by fast path
}
```

## Compiler Source Reference

The relevant code is in `@tanstack/start-plugin-core/src/start-compiler-plugin/`:

- `compiler.ts:88-95` — `KindDetectionPatterns.ServerFn = /\bcreateServerFn\b|\.\s*handler\s*\(/`
- `compiler.ts:226-228` — `areAllKindsTopLevelOnly` returns true for ServerFn-only files
- `compiler.ts:660-663` — `canUseFastPath` check
- `compiler.ts:715-717` — early exit when no top-level candidates found
- `plugin.ts:239-247` — transform filter: `id.include = /\.[cm]?[tj]sx?($|\?)/`, `code.include` from `KindDetectionPatterns`
