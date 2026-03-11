# Structure Map: deco-cx/apps → apps-start

File-by-file mapping showing what exists, what's missing, and what needs improvement.

## Legend

- ✅ Ported and verified
- ⚠️ Ported but needs review/improvements
- ❌ Missing — needs to be created
- 🔀 Consolidated into another file
- ➖ Not needed in TanStack (platform-specific)

---

## Root Files

| Original (apps/vtex/) | apps-start (vtex/) | Status |
|----------------------|-------------------|--------|
| `mod.ts` | `index.ts` + `client.ts` (configureVtex) | ⚠️ mod.ts creates 7 typed clients; apps-start has vtexFetch only |
| `manifest.gen.ts` | `package.json` exports | ✅ Different approach, OK |
| `runtime.ts` | Not needed | ➖ No invoke proxy in TanStack |
| `middleware.ts` | `middleware.ts` | ⚠️ Simplified version, missing full segment bag |
| `README.md` | `README.md` | ✅ |

## Actions

### Cart (Original: 16 files → apps-start: 1 file `checkout.ts`)

| Original | apps-start | Status |
|----------|-----------|--------|
| `actions/cart/addItems.ts` | `actions/checkout.ts` → `addItems()` | ✅ |
| `actions/cart/updateItems.ts` | `actions/checkout.ts` → `updateItems()` | ✅ |
| `actions/cart/removeItems.ts` | `actions/checkout.ts` → `removeAllItems()` | ✅ |
| `actions/cart/updateCoupons.ts` | `actions/checkout.ts` → `updateCoupons()` | ✅ |
| `actions/cart/updateAttachment.ts` | `actions/checkout.ts` → `sendAttachment()` | ✅ |
| `actions/cart/updateItemAttachment.ts` | `actions/checkout.ts` → `updateItemAttachment()` | ✅ |
| `actions/cart/removeItemAttachment.ts` | `actions/checkout.ts` → `removeItemAttachment()` | ✅ |
| `actions/cart/updateItemPrice.ts` | `actions/checkout.ts` → `changePrice()` | ✅ |
| `actions/cart/updateProfile.ts` | `actions/checkout.ts` → `ignoreProfileData()` | ✅ |
| `actions/cart/updateUser.ts` | `actions/checkout.ts` → `removeAllPersonalData()` | ✅ |
| `actions/cart/addOfferings.ts` | `actions/checkout.ts` → `addOfferings()` | ⚠️ Verify logic matches |
| `actions/cart/removeOffering.ts` | `actions/checkout.ts` → `removeOffering()` | ⚠️ Verify logic matches |
| `actions/cart/getInstallment.ts` | `actions/checkout.ts` → `getInstallments()` | ⚠️ Verify logic matches |
| `actions/cart/updateGifts.ts` | `actions/checkout.ts` → `updateGifts()` | ⚠️ Verify logic matches |
| `actions/cart/clearOrderformMessages.ts` | `actions/checkout.ts` → `clearMessages()` | ✅ |
| `actions/cart/simulation.ts` | `actions/checkout.ts` → `simulation()` | ⚠️ Verify |

### Authentication (Original: 8 files → apps-start: 1 file `auth.ts`)

| Original | apps-start | Status |
|----------|-----------|--------|
| `actions/authentication/startAuthentication.ts` | `actions/auth.ts` → `startAuthentication()` | ✅ |
| `actions/authentication/classicSignIn.ts` | `actions/auth.ts` → `classicSignIn()` | ✅ |
| `actions/authentication/accessKeySignIn.ts` | `actions/auth.ts` → `accessKeySignIn()` | ✅ |
| `actions/authentication/sendEmailVerification.ts` | `actions/auth.ts` → `sendEmailVerification()` | ✅ |
| `actions/authentication/recoveryPassword.ts` | `actions/auth.ts` → `recoveryPassword()` | ✅ |
| `actions/authentication/resetPassword.ts` | `actions/auth.ts` → `resetPassword()` | ✅ |
| `actions/authentication/refreshToken.ts` | `actions/auth.ts` → `refreshToken()` | ⚠️ Verify |
| `actions/authentication/logout.ts` | `actions/auth.ts` → `logout()` | ✅ |

### Other Actions (Original: 13 files → apps-start: 9 files)

| Original | apps-start | Status |
|----------|-----------|--------|
| `actions/session/createSession.ts` | `actions/session.ts` | ✅ |
| `actions/session/editSession.ts` | `actions/session.ts` | ✅ |
| `actions/session/deleteSession.ts` | `actions/session.ts` | ✅ |
| `actions/address/create.ts` | `actions/address.ts` | ✅ |
| `actions/address/update.ts` | `actions/address.ts` | ✅ |
| `actions/address/delete.ts` | `actions/address.ts` | ✅ |
| `actions/newsletter/subscribe.ts` | `actions/newsletter.ts` | ✅ |
| `actions/newsletter/updateNewsletterOptIn.ts` | `actions/newsletter.ts` | ✅ |
| `actions/wishlist/addItem.ts` | `actions/wishlist.ts` | ✅ |
| `actions/wishlist/removeItem.ts` | `actions/wishlist.ts` | ✅ |
| `actions/orders/cancel.ts` | `actions/orders.ts` | ✅ |
| `actions/profile/updateProfile.ts` | `actions/profile.ts` | ✅ |
| `actions/review/submit.ts` | `actions/misc.ts` → `submitReview()` | ✅ |
| `actions/payment/deletePaymentToken.ts` | `actions/misc.ts` → `deletePaymentToken()` | ✅ |
| `actions/notifyme.ts` | `actions/misc.ts` → `notifyMe()` | ✅ |
| `actions/trigger.ts` | `actions/trigger.ts` | ✅ |
| `actions/masterdata/createDocument.ts` | `actions/masterData.ts` | ⚠️ Verify completeness |
| `actions/masterdata/updateDocument.ts` | `actions/masterData.ts` | ⚠️ Verify completeness |
| `actions/analytics/sendEvent.ts` | `actions/misc.ts` → `sendEvent()` | ✅ |

## Loaders

### Intelligent Search (Original: 6 files → apps-start: `search.ts` + inline-loaders)

| Original | apps-start | Status |
|----------|-----------|--------|
| `loaders/intelligentSearch/productDetailsPage.ts` | `inline-loaders/productDetailsPage.ts` | ✅ |
| `loaders/intelligentSearch/productListingPage.ts` | `inline-loaders/productListingPage.ts` | ✅ |
| `loaders/intelligentSearch/productList.ts` | `inline-loaders/productList.ts` | ✅ |
| `loaders/intelligentSearch/suggestions.ts` | `inline-loaders/suggestions.ts` | ✅ |
| `loaders/intelligentSearch/topsearches.ts` | `loaders/search.ts` → `getTopSearches()` | ✅ |
| `loaders/intelligentSearch/productSearchValidator.ts` | ❌ Missing | ❌ |

### Legacy Catalog (Original: 7 files → apps-start: `legacy.ts` + `catalog.ts`)

| Original | apps-start | Status |
|----------|-----------|--------|
| `loaders/legacy/productDetailsPage.ts` | `loaders/legacy.ts` | ✅ |
| `loaders/legacy/productListingPage.ts` | `loaders/legacy.ts` | ✅ |
| `loaders/legacy/productList.ts` | `loaders/legacy.ts` | ✅ |
| `loaders/legacy/suggestions.ts` | `loaders/legacy.ts` → `legacySuggestions()` | ✅ |
| `loaders/legacy/relatedProductsLoader.ts` | `inline-loaders/relatedProducts.ts` + `loaders/catalog.ts` | ✅ |
| `loaders/legacy/brands.ts` | `loaders/brands.ts` | ✅ |
| `loaders/legacy/pageType.ts` | `loaders/pageType.ts` | ✅ |

### Other Loaders

| Original | apps-start | Status |
|----------|-----------|--------|
| `loaders/cart.ts` | `loaders/cart.ts` | ✅ |
| `loaders/user.ts` | `loaders/user.ts` | ✅ |
| `loaders/wishlist.ts` | `loaders/wishlist.ts` | ✅ |
| `loaders/navbar.ts` | `loaders/navbar.ts` | ✅ |
| `loaders/proxy.ts` | `utils/proxy.ts` | ⚠️ Different location |
| `loaders/config.ts` | `client.ts` (getVtexConfig) | 🔀 |
| `loaders/categories/tree.ts` | `loaders/catalog.ts` → `getCategoryTree()` | ✅ |
| `loaders/collections/list.ts` | `loaders/collections.ts` | ✅ |
| `loaders/logistics/getSalesChannelById.ts` | `loaders/logistics.ts` | ⚠️ Verify |
| `loaders/logistics/listPickupPoints.ts` | `loaders/logistics.ts` | ⚠️ Verify |
| `loaders/logistics/listPickupPointsByLocation.ts` | `loaders/logistics.ts` | ⚠️ Verify |
| `loaders/logistics/listSalesChannelById.ts` | `loaders/logistics.ts` | ⚠️ Verify |
| `loaders/logistics/listStockByStore.ts` | `loaders/logistics.ts` | ⚠️ Verify |
| `loaders/orders/getById.ts` | `loaders/orders.ts` | ⚠️ Verify |
| `loaders/orders/list.ts` | `loaders/orders.ts` | ⚠️ Verify |
| `loaders/orders/orderplaced.ts` | `loaders/orders.ts` | ⚠️ Verify |
| `loaders/payment/paymentSystems.ts` | `loaders/payment.ts` | ⚠️ Verify |
| `loaders/payment/userPayments.ts` | `loaders/payment.ts` | ⚠️ Verify |
| `loaders/profile/getCurrentProfile.ts` | `loaders/profile.ts` | ⚠️ Verify |
| `loaders/profile/getProfileByEmail.ts` | `loaders/profile.ts` | ⚠️ Verify |
| `loaders/session/getSession.ts` | `loaders/session.ts` | ⚠️ Verify |
| `loaders/session/getUserSessions.ts` | `loaders/session.ts` | ⚠️ Verify |
| `loaders/address/getAddressByPostalCode.ts` | `loaders/address.ts` | ⚠️ Verify |
| `loaders/address/getUserAddresses.ts` | `loaders/address.ts` | ⚠️ Verify |
| `loaders/masterdata/searchDocuments.ts` | ❌ Missing | ❌ |
| `loaders/options/productIdByTerm.ts` | ❌ Missing | ❌ |
| `loaders/promotion/getPromotionById.ts` | `loaders/promotion.ts` | ⚠️ Verify |
| `loaders/workflow/product.ts` | `loaders/workflow.ts` | ✅ |
| `loaders/workflow/products.ts` | `loaders/workflow.ts` | ✅ |
| `loaders/paths/PDPDefaultPath.ts` | ❌ Missing (storefront handles routing) | ➖ |
| `loaders/paths/PLPDefaultPath.ts` | ❌ Missing (storefront handles routing) | ➖ |
| `loaders/product/extend.ts` | ❌ Missing | ❌ |
| `loaders/product/extensions/*` (4 files) | ❌ Missing (extensions are framework-specific) | ➖ |
| `loaders/product/wishlist.ts` | ❌ Missing | ❌ |

## Utils

| Original | apps-start | Status |
|----------|-----------|--------|
| `utils/transform.ts` | `utils/transform.ts` | ✅ Ported and verified |
| `utils/types.ts` | `utils/types.ts` | ✅ |
| `utils/client.ts` | `client.ts` (vtexFetch, etc.) | ⚠️ Different approach — no typed Proxy |
| `utils/fetchVTEX.ts` | Part of `client.ts` | 🔀 URL sanitization may be missing |
| `utils/cookies.ts` | `utils/cookies.ts` | ✅ |
| `utils/vtexId.ts` | `utils/vtexId.ts` | ✅ |
| `utils/orderForm.ts` | Part of `loaders/cart.ts` + `hooks/useCart.ts` | ⚠️ Split across files |
| `utils/segment.ts` | `utils/segment.ts` | ⚠️ Simplified, missing full serialization |
| `utils/intelligentSearch.ts` | `utils/intelligentSearch.ts` | ✅ |
| `utils/legacy.ts` | `utils/legacy.ts` | ⚠️ Verify completeness |
| `utils/similars.ts` | `utils/similars.ts` | ✅ |
| `utils/batch.ts` | `utils/batch.ts` | ⚠️ Verify |
| `utils/cacheBySegment.ts` | ❌ Missing (caching handled differently) | ➖ |
| `utils/resourceRange.ts` | ❌ Missing | ❌ |
| `utils/slugify.ts` | `utils/slugify.ts` | ✅ |
| `utils/pickAndOmit.ts` | `utils/pickAndOmit.ts` | ✅ |
| `utils/extensions/simulation.ts` | `utils/enrichment.ts` | 🔀 |
| `utils/login/getLoginCookies.ts` | Part of `actions/auth.ts` | 🔀 |
| `utils/login/setLoginCookies.ts` | Part of `actions/auth.ts` | 🔀 |
| `utils/openapi/*.gen.ts` (12 files) | Not needed (no OpenAPI codegen) | ➖ |

## Hooks

| Original | apps-start | Status |
|----------|-----------|--------|
| `hooks/context.ts` | Not needed (react-query manages state) | ➖ |
| `hooks/useCart.ts` | `hooks/useCart.ts` | ✅ React Query version |
| `hooks/useUser.ts` | `hooks/useUser.ts` | ✅ |
| `hooks/useWishlist.ts` | `hooks/useWishlist.ts` | ✅ |
| `hooks/useAutocomplete.ts` | ❌ Missing | ❌ Should add |

## Other

| Original | apps-start | Status |
|----------|-----------|--------|
| `handlers/sitemap.ts` | `utils/sitemap.ts` | ⚠️ Different location |
| `sections/Analytics/Vtex.tsx` | ❌ Missing (storefront handles analytics) | ➖ |
| `components/VTEXPortalDataLayerCompatibility.tsx` | ❌ Not needed | ➖ |
| `workflows/events.ts` | Not applicable | ➖ |
| `workflows/product/index.ts` | Not applicable | ➖ |
| `preview/Preview.tsx` | Not applicable | ➖ |

## Commerce Module

| Original (apps/commerce/) | apps-start (commerce/) | Status |
|--------------------------|----------------------|--------|
| `types.ts` (786 lines) | `types/commerce.ts` | ✅ Same types |
| `mod.ts` | Not applicable | ➖ |
| `utils/canonical.ts` | `utils/canonical.ts` | ✅ |
| `utils/constants.ts` | `utils/constants.ts` | ✅ |
| `utils/filters.ts` | `utils/filters.ts` | ✅ |
| `utils/productToAnalyticsItem.ts` | `utils/productToAnalyticsItem.ts` | ✅ |
| `utils/stateByZip.ts` | `utils/stateByZip.ts` | ✅ |
| `loaders/extensions/*` | ❌ Missing (framework-specific) | ➖ |
| `sections/Seo/*` | ❌ Not needed (storefront handles SEO) | ➖ |
| **SDK (NEW in apps-start)** | | |
| N/A (was in site sdk/) | `sdk/useOffer.ts` | ✅ |
| N/A | `sdk/useVariantPossibilities.ts` | ✅ |
| N/A | `sdk/formatPrice.ts` | ✅ |
| N/A | `sdk/url.ts` (relative) | ✅ |
| N/A | `sdk/analytics.ts` | ✅ |
| N/A | `components/Image.tsx` | ✅ |
| N/A | `components/JsonLd.tsx` | ✅ |

## Shared Utils

| Original (apps/utils/) | apps-start | Status |
|------------------------|-----------|--------|
| `http.ts` (createHttpClient) | Not needed (vtexFetch replaces it) | ➖ |
| `graphql.ts` (createGraphqlClient) | `client.ts` → vtexIOGraphQL | 🔀 |
| `fetch.ts` (fetchSafe, retry) | `client.ts` → vtexFetch (no retry) | ⚠️ Missing retry logic |
| `cookie.ts` (proxySetCookie) | `client.ts` → vtexFetchWithCookies | 🔀 Different approach |
| `normalize.ts` (removeDirtyCookies) | ❌ Missing | ⚠️ Should add URL sanitization |

## Priority Missing Items

1. **`utils/fetchVTEX.ts` URL sanitization** — original sanitizes UTM params, `ft` param. apps-start doesn't
2. **Retry logic** — original uses cockatiel ExponentialBackoff. apps-start has no retry
3. **`hooks/useAutocomplete.ts`** — client-side autocomplete hook
4. **`loaders/masterdata/searchDocuments.ts`** — MasterData search
5. **`loaders/product/extend.ts`** — Product enrichment loader
6. **Segment cookie serialization** — original has stable serialization for cache hits
