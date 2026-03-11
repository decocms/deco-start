---
name: deco-apps-vtex-review
description: Audit and fix the VTEX integration in @decocms/apps-start (TanStack Start). Covers cookie propagation (vtexFetchWithCookies, buildAuthCookieHeader), expectedOrderFormSections, salesChannel injection, HttpOnly cookie handling, Intelligent Search cookie generation, useCart/useUser/useWishlist hooks, and TypeScript validation. Use when reviewing vtex/ code quality, fixing authentication issues, debugging missing cart sections, or ensuring full parity with deco-cx/apps.
---

# VTEX apps-start Review & Fix

Comprehensive audit checklist for the VTEX integration in `@decocms/apps-start`. Use after porting or when debugging issues.

## File Structure

```
apps-start/vtex/
├── client.ts              # vtexFetch, vtexFetchWithCookies, intelligentSearch, vtexIOGraphQL
├── middleware.ts           # extractVtexContext, propagateISCookies
├── actions/
│   ├── checkout.ts         # Cart mutations (addItems, updateItems, etc.)
│   ├── auth.ts             # classicSignIn, logout, sendEmailVerification
│   ├── session.ts          # createSession, editSession, deleteSession
│   ├── address.ts          # GraphQL address mutations
│   ├── misc.ts             # notifyMe, sendEvent, submitReview, deletePaymentToken
│   ├── newsletter.ts       # subscribe, updateNewsletterOptIn
│   ├── orders.ts           # cancelOrder
│   ├── profile.ts          # updateProfile, updateAddress
│   ├── wishlist.ts         # addItem, removeItem
│   └── trigger.ts          # Analytics trigger
├── loaders/
│   ├── cart.ts             # getCart (OrderForm)
│   ├── catalog.ts          # searchProducts, getCrossSelling, getCategoryTree
│   ├── legacy.ts           # legacyProductDetailsPage, legacyProductList, legacyPLP, legacySuggestions
│   ├── workflow.ts         # workflowProduct, workflowProducts
│   ├── search.ts           # getTopSearches, getProductIdByTerm
│   └── (14 more)
├── inline-loaders/         # TanStack-compatible loaders for sections
├── hooks/                  # Client-side React hooks (useCart, useUser, useWishlist)
└── utils/
    ├── transform.ts        # Canonical VTEX→schema.org mapping
    ├── types.ts            # VTEX API types
    ├── vtexId.ts           # VTEX_AUTH_COOKIE, buildAuthCookieHeader
    ├── segment.ts          # buildSegmentFromCookies, isAnonymous
    ├── intelligentSearch.ts # withDefaultParams, withDefaultFacets
    ├── similars.ts         # withIsSimilarTo
    └── enrichment.ts       # withSimulation
```

## Audit Checklist

### 1. Cookie Propagation

VTEX APIs return `Set-Cookie` headers that must reach the browser. Standard `vtexFetch` discards them.

**Pattern**: Use `vtexFetchWithCookies` for any action that creates/modifies server state:

```typescript
import { vtexFetchWithCookies } from "../client";
import type { VtexFetchResult } from "../client";

// Returns { data: T, setCookies: string[] }
const result = await vtexFetchWithCookies<OrderForm>(url, opts);
```

**Where required**: `checkout.ts` (all cart mutations), `session.ts` (create/edit), `auth.ts` (signIn, logout).

**Where NOT needed**: Read-only loaders, GraphQL queries.

### 2. Auth Cookie Headers

All authenticated VTEX IO GraphQL calls need both cookie variants:

```
VtexIdclientAutCookie={token}; VtexIdclientAutCookie_{account}={token}
```

**Use the centralized helper**:

```typescript
import { buildAuthCookieHeader, VTEX_AUTH_COOKIE } from "../utils/vtexId";
import { getVtexConfig } from "../client";

const { account } = getVtexConfig();
const cookieHeader = buildAuthCookieHeader(authCookie, account);
// Pass as: { cookie: cookieHeader } or { Cookie: cookieHeader }
```

**Audit**: grep for hardcoded `VtexIdclientAutCookie` strings. Only `vtexId.ts` should define it.

```bash
rg "VtexIdclientAutCookie" vtex/ --glob '!vtex/utils/vtexId.ts'
```

Any match outside `vtexId.ts` (except JSDoc comments) is a bug.

### 3. expectedOrderFormSections

VTEX Checkout API returns incomplete OrderForm without explicit sections. Every POST to `/api/checkout/pub/orderForm` must include:

```typescript
import { DEFAULT_EXPECTED_SECTIONS } from "../actions/checkout";

body: JSON.stringify({ expectedOrderFormSections: DEFAULT_EXPECTED_SECTIONS })
```

**Audit**: Check `loaders/cart.ts` and `hooks/useCart.ts` — both must send this body.

### 4. salesChannel (sc) Parameter

Missing `sc` causes wrong prices, ORD027, or invisible products.

**Where required**:
- All `/api/checkout/pub/orderForm/*` endpoints → `?sc={sc}`
- `/api/catalog_system/pub/products/search/*` → `?sc={sc}`
- `/buscaautocomplete` → `&sc={sc}`
- Intelligent Search: handled by `client.ts` `intelligentSearch()` automatically

**Audit**:

```bash
rg "catalog_system/pub/products/search|buscaautocomplete|orderForm" vtex/ | rg -v "sc="
```

### 5. Intelligent Search Cookies

VTEX IS requires `vtex_is_session` and `vtex_is_anonymous` cookies (UUIDs).

**Pattern in middleware.ts**:

```typescript
// Generate if missing
if (!cookieHeader.includes("vtex_is_session")) {
  const sessionId = crypto.randomUUID();
  // Set on response
}
```

### 6. HttpOnly Cookies

`VtexIdclientAutCookie` is HttpOnly — **cannot** be read via `document.cookie`.

**Wrong**: Client-side hooks checking `document.cookie` for auth status.
**Correct**: `useUser` calls `/api/sessions?items=profile.email` server-side.

### 7. Hooks Completeness

Compare with original `deco-cx/apps` hooks:

| Hook | Must Have |
|------|-----------|
| `useCart` | `addItems`, `updateQuantity`, `removeItem`, `addCoupons`, `fetchCart` |
| `useUser` | Server-side session check via `/api/sessions` |
| `useWishlist` | `add`, `remove`, `toggle`, `isInWishlist` |

### 8. transform.ts Parity

All exported functions must match the original:

```
toProduct, toProductPage, pickSku, aggregateOffers, forceHttpsOnAssets,
sortProducts, filtersFromURL, mergeFacets, legacyFacetToFilter,
toFilter, categoryTreeToNavbar, toBrand, toReview, toInventories,
toPlace, toPostalAddress, parsePageType, normalizeFacet
```

Critical: `seller: sellerId` (not `sellerName`) in `buildOffer`.

### 9. Page Structure (schema.org)

| Page | Required Structure |
|------|--------------------|
| PDP | `ProductDetailsPage` with `breadcrumbList` + `product` (via `toProductPage`) + `seo` |
| PLP | `ProductListingPage` with `BreadcrumbList` + `filters` + `products` + `pageInfo` + `sortOptions` + `seo` |

### 10. No Debug Logs in Production

```bash
rg "console\.log" vtex/ --glob '*.ts'
```

Only acceptable: 1x startup log in `client.ts`. All others should be `console.error` or `console.warn` in catch blocks.

## Common Fixes

### Fix: Header uses string instead of constant

```typescript
// Before
headers: { VtexidClientAutCookie: authCookie }
// After
import { VTEX_AUTH_COOKIE } from "../utils/vtexId";
headers: { [VTEX_AUTH_COOKIE]: authCookie }
```

### Fix: Missing expectedOrderFormSections

```typescript
// Before
await vtexFetch<OrderForm>(`/api/checkout/pub/orderForm`, { method: "POST", headers });
// After
import { DEFAULT_EXPECTED_SECTIONS } from "../actions/checkout";
await vtexFetch<OrderForm>(`/api/checkout/pub/orderForm`, {
  method: "POST", headers,
  body: JSON.stringify({ expectedOrderFormSections: DEFAULT_EXPECTED_SECTIONS }),
});
```

### Fix: Missing salesChannel in catalog

```typescript
// Before
return vtexFetch<T[]>(`/api/catalog_system/pub/products/search/?${params}`);
// After
const { salesChannel } = getVtexConfig();
if (salesChannel) params.set("sc", salesChannel);
return vtexFetch<T[]>(`/api/catalog_system/pub/products/search/?${params}`);
```

## Validation

After all fixes, run:

```bash
# TypeScript
npx -p typescript tsc --noEmit

# No hardcoded cookie strings
rg "VtexIdclientAutCookie" vtex/ --glob '!vtex/utils/vtexId.ts' --glob '!*.md'

# No debug logs
rg "console\.log" vtex/ --glob '*.ts' --glob '!client.ts'

# No trailing whitespace
rg "\s+$" vtex/ --glob '*.ts'
```

All must return 0 results (except TypeScript which exits 0).
