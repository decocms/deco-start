# VTEX App — Deep Structure Reference

The VTEX app is the largest integration in deco-cx/apps (141 files). This document maps every subdirectory and key file.

## `mod.ts` — App Factory

Creates 7 typed HTTP/GraphQL clients:

| Client | Base URL | Purpose |
|--------|----------|---------|
| `sp` | `https://sp.vtex.com` | Spark (analytics events) |
| `my` | `https://{account}.myvtex.com` | My Account APIs |
| `vcsDeprecated` | `{publicUrl}` | VTEXCommerceStable (checkout, catalog, auth) |
| `io` | `{publicUrl}/api/io/_v/private/graphql/v1` | IO GraphQL (wishlist, reviews) |
| `vcs` | `{publicUrl}` | VCS OpenAPI (typed) |
| `api` | `https://api.vtex.com/{account}` | VTEX API |
| `vpay` | `https://{account}.vtexpayments.com.br` | Payments |
| `sub` | `https://{account}.vtexcommercestable.com.br` | Subscriptions |

### Props
```typescript
interface Props {
  account: string;          // VTEX account name
  publicUrl: string;        // Public store URL (e.g., secure.mystore.com.br)
  appKey?: Secret;          // For admin API operations
  appToken?: Secret;
  salesChannel?: string;    // Default: "1"
  defaultSegment?: SegmentCulture;
  setRefreshToken?: boolean;
  usePortalSitemap?: boolean;
  platform: "vtex";
  advancedConfigs?: { doNotFetchVariantsForRelatedProducts?: boolean };
  cachedSearchTerms?: { terms?: Suggestion; extraTerms?: string[] };
}
```

## Actions (43 files, 11 subdirectories)

### `actions/cart/` (16 files)
| File | Endpoint | Method |
|------|----------|--------|
| `addItems.ts` | `/api/checkout/pub/orderForm/:id/items` | POST |
| `updateItems.ts` | `/api/checkout/pub/orderForm/:id/items/update` | POST |
| `removeItems.ts` | `/api/checkout/pub/orderForm/:id/items/removeAll` | POST |
| `updateCoupons.ts` | `/api/checkout/pub/orderForm/:id/coupons` | POST |
| `updateAttachment.ts` | `/api/checkout/pub/orderForm/:id/attachments/:att` | POST |
| `updateItemAttachment.ts` | `/api/checkout/pub/orderForm/:id/items/:idx/attachments/:att` | POST |
| `removeItemAttachment.ts` | `/api/checkout/pub/orderForm/:id/items/:idx/attachments/:att` | DELETE |
| `updateItemPrice.ts` | `/api/checkout/pub/orderForm/:id/items/:idx/price` | PUT |
| `updateProfile.ts` | `/api/checkout/pub/orderForm/:id/profile` | PATCH |
| `updateUser.ts` | `/api/checkout/changeToAnonymousUser/:id` | GET |
| `addOfferings.ts` | `/api/checkout/pub/orderForm/:id/items/:idx/offerings` | POST |
| `removeOffering.ts` | `/api/checkout/pub/orderForm/:id/items/:idx/offerings/:off/remove` | POST |
| `getInstallment.ts` | `/api/checkout/pub/orderForm/:id/installments` | GET |
| `updateGifts.ts` | `/api/checkout/pub/orderForm/:id/selectable-gifts/:giftId` | POST |
| `clearOrderformMessages.ts` | `/api/checkout/pub/orderForm/:id/messages/clear` | POST |
| `simulation.ts` | `/api/checkout/pub/orderForms/simulation` | POST |

All cart actions:
- Receive `orderFormId` from cookie parsing
- Pass `sc` (salesChannel) from segment
- Use `expectedOrderFormSections` in body
- Proxy `Set-Cookie` headers back
- Return `OrderForm`

### `actions/authentication/` (8 files)
| File | Purpose |
|------|---------|
| `startAuthentication.ts` | Get auth token from VTEX ID |
| `classicSignIn.ts` | Email + password login |
| `accessKeySignIn.ts` | Magic link validation |
| `sendEmailVerification.ts` | Send magic link email |
| `recoveryPassword.ts` | Request password reset |
| `resetPassword.ts` | Set new password |
| `refreshToken.ts` | Refresh auth cookie |
| `logout.ts` | Clear auth cookies |

### `actions/session/` (3 files)
| File | Endpoint |
|------|----------|
| `createSession.ts` | IO GraphQL — `newSession` mutation |
| `editSession.ts` | IO GraphQL — `updateSession` mutation |
| `deleteSession.ts` | IO GraphQL — `deleteSession` mutation |

### Other Actions
| Directory | Files | Purpose |
|-----------|-------|---------|
| `address/` | 3 | CRUD user addresses (IO GraphQL) |
| `newsletter/` | 2 | Subscribe + update opt-in |
| `wishlist/` | 2 | Add/remove items (IO GraphQL) |
| `masterdata/` | 2 | Create/update documents |
| `orders/` | 1 | Cancel order |
| `payment/` | 1 | Delete payment token |
| `profile/` | 1 | Update user profile |
| `review/` | 1 | Submit product review |
| `analytics/` | 1 | Send SP event |
| `notifyme.ts` | 1 | Notify me when available |
| `trigger.ts` | 1 | Workflow trigger |

## Loaders (50+ files, 15 subdirectories)

### `loaders/intelligentSearch/` (6 files) — Primary search
| File | Returns | API |
|------|---------|-----|
| `productDetailsPage.ts` | `ProductDetailsPage` | IS product_search + facets |
| `productListingPage.ts` | `ProductListingPage` | IS product_search + facets |
| `productList.ts` | `Product[]` | IS product_search |
| `suggestions.ts` | `Suggestion` | IS search_suggestions |
| `topsearches.ts` | `Suggestion` | IS top_searches |
| `productSearchValidator.ts` | Validates search args | — |

### `loaders/legacy/` (7 files) — Legacy Catalog API
| File | Returns | API |
|------|---------|-----|
| `productDetailsPage.ts` | `ProductDetailsPage` | `/products/search/:slug/p` |
| `productListingPage.ts` | `ProductListingPage` | `/products/search` + `/facets/search` |
| `productList.ts` | `Product[]` | `/products/search` |
| `suggestions.ts` | `Suggestion` | `/buscaautocomplete` |
| `relatedProductsLoader.ts` | `Product[]` | `/crossselling/:type/:id` |
| `brands.ts` | `Brand[]` | `/brand/list` |
| `pageType.ts` | `PageType` | `/portal/pagetype/:term` |

### `loaders/logistics/` (5 files)
| File | Purpose |
|------|---------|
| `getSalesChannelById.ts` | Get sales channel details |
| `listSalesChannelById.ts` | List sales channels |
| `listPickupPoints.ts` | List pickup points |
| `listPickupPointsByLocation.ts` | Pickup points near location |
| `listStockByStore.ts` | Stock availability by store |

### Other Loaders
| Directory | Files | Purpose |
|-----------|-------|---------|
| `cart.ts` | 1 | Get/create OrderForm |
| `user.ts` | 1 | Get current user (Person) |
| `wishlist.ts` | 1 | Get user wishlist |
| `navbar.ts` | 1 | Category tree for navigation |
| `proxy.ts` | 1 | VTEX checkout/API proxy handler |
| `config.ts` | 1 | Expose app config |
| `address/` | 2 | Get addresses, postal code lookup |
| `categories/` | 1 | Category tree |
| `collections/` | 1 | List collections |
| `orders/` | 3 | Get by ID, list, orderplaced |
| `payment/` | 2 | Payment systems, user payments |
| `profile/` | 2 | Get current profile, get by email |
| `session/` | 2 | Get session, get user sessions |
| `paths/` | 2 | PDP/PLP default path patterns |
| `product/` | 3 | Extend product, extensions, wishlist enrichment |
| `product/extensions/` | 4 | Enrich PDP, list, PLP, suggestions |
| `masterdata/` | 1 | Search documents |
| `options/` | 1 | Product ID by search term |
| `promotion/` | 1 | Get promotion by ID |
| `workflow/` | 2 | Product/products for workflow |

## Utils (31 files)

### Core Transform & Types
| File | Lines | Purpose |
|------|-------|---------|
| `transform.ts` | ~600 | THE canonical VTEX → schema.org mapping |
| `types.ts` | 1320 | All VTEX API types (OrderForm, Product, etc.) |
| `client.ts` | 317 | `VTEXCommerceStable` + `SP` typed interfaces |

### Fetch & HTTP
| File | Purpose |
|------|---------|
| `fetchVTEX.ts` | VTEX-specific `fetchSafe`/`fetchAPI` with URL sanitization |

### Cookies & Auth
| File | Purpose |
|------|---------|
| `cookies.ts` | `stringify`, `proxySetCookie`, cookie constants |
| `vtexId.ts` | `parseCookie` — extracts auth cookie + JWT decode |
| `orderForm.ts` | `parseCookie` — extracts checkout cookie + orderFormId |

### Segment & Search
| File | Purpose |
|------|---------|
| `segment.ts` | Segment bag management, cookie serialization, `isAnonymous` |
| `intelligentSearch.ts` | IS cookie management, search params building |

### Other Utils
| File | Purpose |
|------|---------|
| `legacy.ts` | Legacy API helpers |
| `similars.ts` | Similar products enrichment |
| `batch.ts` | Batch API calls |
| `cacheBySegment.ts` | Cache key generation per segment |
| `slugify.ts` | URL slug generation |
| `resourceRange.ts` | Range header parsing for pagination |
| `pickAndOmit.ts` | Object property picking/omitting |
| `login/getLoginCookies.ts` | Extract login-related cookies |
| `login/setLoginCookies.ts` | Set login cookies in response |
| `extensions/simulation.ts` | Price simulation enrichment |

### OpenAPI Generated Types (12 files)
```
openapi/
├── api.openapi.json + api.openapi.gen.ts       # VTEX API
├── my.openapi.json + my.openapi.gen.ts         # My Account
├── orders.openapi.json + orders.openapi.gen.ts # Orders
├── payments.openapi.json + payments.openapi.gen.ts
├── subscriptions.openapi.json + subscriptions.openapi.gen.ts
└── vcs.openapi.json + vcs.openapi.gen.ts       # VTEXCommerceStable
```

## Hooks (5 files)

| File | Framework | Purpose |
|------|-----------|---------|
| `context.ts` | Preact signals | Central state (cart, user, wishlist) + enqueue |
| `useCart.ts` | Preact signals | Cart operations via invoke proxy |
| `useUser.ts` | Preact signals | User state from context |
| `useWishlist.ts` | Preact signals | Wishlist CRUD via invoke proxy |
| `useAutocomplete.ts` | Preact signals | Search autocomplete |

## Other

| Directory | Purpose |
|-----------|---------|
| `middleware.ts` | Sets segment + IS cookies in ctx.bag |
| `handlers/sitemap.ts` | VTEX sitemap proxy |
| `sections/Analytics/Vtex.tsx` | VTEX analytics pixel section |
| `components/VTEXPortalDataLayerCompatibility.tsx` | DataLayer compat |
| `workflows/events.ts` | Workflow event definitions |
| `workflows/product/index.ts` | Product sync workflow |
| `preview/Preview.tsx` | Admin preview component |

## Key Data Flow

```
Request → middleware.ts (parse cookies, set segment/IS in bag)
        → loader/action (use ctx.bag for segment, cookies)
          → client.ts (typed HTTP call to VTEX API)
          → transform.ts (API response → schema.org)
        ← Response (proxySetCookie back to client)
```

## `utils/client.ts` — Endpoint Map

The `VTEXCommerceStable` interface (317 lines) defines every endpoint:

| Category | Endpoints |
|----------|-----------|
| Auth | startAuthentication, classicValidate, accessKeyValidate, setPassword, sendAccessKey, refreshToken |
| Checkout | orderForm, items, update, removeAll, coupons, attachments, offerings, simulation, installments, profile, messages, gifts |
| Catalog (Legacy) | products/search, crossselling, facets/search, pagetype, brand/list, category/tree, buscaautocomplete |
| Catalog (IS) | product_search, facets, search_suggestions, top_searches |
| Orders | user/orders, cancel, order-group |
| Masterdata | documents (create) |
| Newsletter | Newsletter.aspx, AviseMe.aspx |
| IO GraphQL | Private graphql endpoint (sessions, wishlist, addresses, reviews) |
