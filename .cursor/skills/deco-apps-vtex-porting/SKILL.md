---
name: deco-apps-vtex-porting
description: Port the VTEX commerce app from deco-cx/apps (Fresh/Deno) to @decocms/apps-start (TanStack Start/Node). The goal is to mirror the original production code that runs on thousands of stores, adapting only what is necessary for TanStack/Node. Covers full structural mapping (141 files → apps-start equivalent), adaptation patterns (Deno→Node, signals→react-query, manifest→exports, ctx.bag→configureVtex), schema.org compliance, and a file-by-file gap analysis. Use when porting VTEX code, fixing bugs in apps-start, or ensuring parity with the original.
globs:
  - "**/apps-start/vtex/**"
  - "**/apps-start/commerce/**"
  - "**/apps-start/shopify/**"
---

# Porting deco-cx/apps to @decocms/apps-start

## Philosophy

**The original `deco-cx/apps` is the source of truth.** It runs on thousands of stores in production. The goal of `apps-start` is NOT to reinvent — it's to mirror the same logic, adapted only where the platform forces a change (Deno→Node, Fresh→TanStack, Preact signals→React/TanStack Query).

When in doubt about how something should work, look at the original first.

## Sub-documents

| Document | Topic |
|----------|-------|
| [structure-map.md](./structure-map.md) | File-by-file mapping: original → apps-start (what exists, what's missing, what's wrong) |
| [adaptation-patterns.md](./adaptation-patterns.md) | How to convert each Deno/Fresh/Deco pattern to TanStack/Node |
| [commerce-porting.md](./commerce-porting.md) | Porting the commerce/ module (types, utils, SDK, components) |
| [website-porting.md](./website-porting.md) | Where website/ code goes (framework, storefront, worker entry) |
| [transform-mapping.md](./transform-mapping.md) | Field-by-field VTEX → schema.org mapping in transform.ts |
| [cookie-auth-patterns.md](./cookie-auth-patterns.md) | Cookie propagation, auth headers, session handling |

## Architecture Comparison

```
deco-cx/apps (Original)              @decocms/apps-start (Port)
═══════════════════════              ═════════════════════════
Deno + Fresh + Preact                Node + TanStack Start + React
@deco/deco framework                 No framework (pure functions)
mod.ts (app factory)                 configureVtex() / index.ts
manifest.gen.ts (auto-gen)           package.json exports (manual)
runtime.ts (invoke proxy)            Direct imports
ctx (AppContext + bag)               getVtexConfig() singleton
signals (@preact/signals)            @tanstack/react-query mutations
middleware.ts (ctx.bag)              middleware.ts (request-local)
OpenAPI codegen (*.gen.ts)           Manual vtexFetch calls
proxySetCookie (Deno std)            vtexFetchWithCookies (manual)
```

## What Changes, What Stays

### STAYS THE SAME (copy/adapt minimally)
- `utils/transform.ts` — the entire VTEX→schema.org mapping
- `utils/types.ts` — all 1320 lines of VTEX API types
- `utils/segment.ts` — segment parsing/serialization logic
- `utils/intelligentSearch.ts` — IS param building
- `utils/cookies.ts` — cookie stringify, constants
- `utils/vtexId.ts` — auth cookie parsing
- `utils/orderForm.ts` — OrderForm cookie parsing
- `utils/similars.ts` — similar products enrichment
- `utils/batch.ts` — batch API calls
- `utils/slugify.ts` — URL slug generation
- Business logic in actions (the VTEX API calls)
- Business logic in loaders (the data fetching + transform)

### MUST CHANGE (platform differences)
| Original Pattern | apps-start Pattern | Why |
|-----------------|-------------------|-----|
| `export default function(props, req, ctx)` | `export async function myLoader(props)` | No Deco framework, no AppContext |
| `ctx.account`, `ctx.salesChannel` | `getVtexConfig().account` | No ctx.bag |
| `ctx.vcsDeprecated["POST /path"]({}, opts)` | `vtexFetch<T>("/path", opts)` | No OpenAPI typed client |
| `createHttpClient<VCS>()` | `vtexFetch()` / `vtexFetchWithCookies()` | No Deno-style Proxy client |
| `ctx.io.query<D,V>({query, variables})` | `vtexIOGraphQL<T>({query, variables})` | No createGraphqlClient |
| `proxySetCookie(res.headers, ctx.response.headers)` | Return `{ data, setCookies }` from vtexFetchWithCookies | No ctx.response |
| `getSegmentFromBag(ctx)` | Read from middleware context or config | No ctx.bag |
| `signal<OrderForm\|null>(null)` | `useQuery` / `useMutation` from @tanstack/react-query | No @preact/signals |
| `invoke({ cart: { key, props } })` | Direct fetch to API routes or useMutation | No Deco invoke proxy |
| `import { getCookies } from "std/http/mod.ts"` | Parse cookies manually or use a cookie lib | No Deno std |

## Key Concepts for Porters

### 1. The Typed Client Is Gone

Original uses `createHttpClient<VTEXCommerceStable>()` which creates a Proxy object where property access like `client["POST /api/checkout/pub/orderForm"]({sc: "1"}, {body: ...})` is fully typed.

In apps-start, this is replaced by `vtexFetch<T>(path, init)` — a simpler wrapper:

```typescript
// Original (apps)
const response = await ctx.vcsDeprecated["POST /api/checkout/pub/orderForm/:orderFormId/items"](
  { orderFormId, sc, allowedOutdatedData: ["paymentData"] },
  { body: { orderItems }, headers: { cookie } },
);
const orderForm = await response.json();

// Port (apps-start)
const orderForm = await vtexFetch<OrderForm>(
  `/api/checkout/pub/orderForm/${orderFormId}/items?sc=${sc}&allowedOutdatedData=paymentData`,
  { method: "POST", body: JSON.stringify({ orderItems }), headers: { cookie, "Content-Type": "application/json" } },
);
```

### 2. One Loader Per File → Consolidated Loaders

Original has one file per loader (e.g., `loaders/intelligentSearch/productDetailsPage.ts`). Apps-start consolidates:
- `loaders/intelligentSearch/*.ts` (6 files) → `loaders/search.ts` + `inline-loaders/productDetailsPage.ts` etc.
- `loaders/legacy/*.ts` (7 files) → `loaders/legacy.ts` + `loaders/catalog.ts`

This is fine but makes it harder to compare. Always check the ORIGINAL file to understand intended behavior.

### 3. Actions Are Consolidated Too

Original: `actions/cart/addItems.ts`, `actions/cart/updateItems.ts`, etc. (16 files)
Apps-start: `actions/checkout.ts` (all cart actions in one file)

### 4. Hooks Use React Query Instead of Signals

Original hooks use a serial queue pattern with `@preact/signals`:
```typescript
const cart = signal<OrderForm | null>(null);
const enqueue = (key) => (props) => storeState.enqueue((signal) => invoke({ cart: { key, props } }));
```

Apps-start hooks use `@tanstack/react-query`:
```typescript
const { data: cart } = useQuery({ queryKey: ["cart"], queryFn: fetchCart });
const addItems = useMutation({ mutationFn: addItemsToCart, onSuccess: () => queryClient.invalidateQueries(["cart"]) });
```

### 5. Middleware Has No ctx.bag

Original middleware sets state in `ctx.bag` (per-request storage):
```typescript
setSegmentBag(cookies, req, ctx);    // ctx.bag.set(SEGMENT, data)
setISCookiesBag(cookies, ctx);       // ctx.bag.set(IS_COOKIES, data)
```

Apps-start uses `configureVtex()` singleton + request-level context:
```typescript
const config = getVtexConfig(); // Global config
// Per-request: pass cookies/segment through function params
```

## The sellerId vs sellerName Pitfall

The #1 bug when porting. VTEX `Offer.seller` MUST be `sellerId` (e.g., `"1"`), NOT `sellerName`. If you see `ORD027: Item não encontrado ou indisponível`, this is almost certainly the cause.

The original `transform.ts` `buildOffer()` handles this correctly. **Never** create manual Offer mappings in loaders — always use `toProduct()` / `toProductPage()`.

## salesChannel (sc) Injection

Missing `sc` = wrong prices, ORD027, or invisible products.

| Endpoint Type | How to inject |
|--------------|---------------|
| Checkout API (`/api/checkout/pub/orderForm/*`) | `?sc={salesChannel}` query param |
| Legacy Catalog (`/api/catalog_system/pub/products/search/*`) | `?sc={salesChannel}` query param |
| Buscaautocomplete (`/buscaautocomplete`) | `&sc={salesChannel}` query param |
| Intelligent Search | Handled automatically by `intelligentSearch()` in client.ts |
| Client-side hooks | Read `VTEXSC` cookie via `document.cookie` |

## Quick Reference: transform.ts Functions

| Function | Input | Output |
|----------|-------|--------|
| `toProduct(product, sku, level, opts)` | VTEX Product/LegacyProduct | schema.org Product |
| `toProductPage(product, sku, breadcrumbs, opts)` | VTEX Product + SKU | ProductDetailsPage |
| `pickSku(product, skuId?)` | Product with items[] | Best SKU item |
| `aggregateOffers(offers)` | Offer[] | AggregateOffer |
| `buildOffer(seller, opts)` | VTEX Seller | schema.org Offer (with seller=sellerId) |
| `forceHttpsOnAssets(orderForm)` | OrderForm | OrderForm with https URLs |

## Debugging Checklist

1. **ORD027** → Check `seller` value (must be sellerId, not sellerName)
2. **Wrong prices** → Check `sc` parameter on API calls
3. **Empty cart** → Check `expectedOrderFormSections` in POST body
4. **Auth fails** → Check `buildAuthCookieHeader` produces both cookie variants
5. **IS returns nothing** → Check `vtex_is_session` / `vtex_is_anonymous` cookies
6. **User always logged out** → Check `useUser` uses server-side session check, not client cookie
7. **Missing product data** → Check transform.ts is being used (not manual mapping)

## Local Development

```json
// storefront package.json
"@decocms/apps": "file:../apps-start"
```

After changes to apps-start:
```bash
rm -rf node_modules/.vite && npm run dev
```
