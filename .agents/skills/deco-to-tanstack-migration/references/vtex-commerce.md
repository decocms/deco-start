# VTEX Commerce Gotchas

> Section loaders, cart CORS, price specs, facets, URL-blind loaders, cookie handling.


## 1. Section Loaders Don't Execute

Deco sections have `export const loader = async (props, req, ctx) => { ... }` that runs server-side before the component renders. In TanStack Start, these don't execute automatically. Components typed as `SectionProps<typeof loader>` expect the augmented props, but only receive the raw CMS block props.

**Symptom**: Components crash on `.find()`, `.length`, or property access of loader-provided props that are `undefined`.

**Fix**: Register them via `registerSectionLoaders()` in `setup.ts`.

**Safe-default pattern** (most pragmatic for initial migration):

```typescript
// Before: component expects loader-augmented props
function ProductMain({ page, productAdditional, showTogether, priceSimulation, isMobile }: SectionProps<typeof loader>) {

// After: destructure with safe defaults for all loader-only props
function ProductMain(rawProps: any) {
  const {
    page,
    productAdditional = [],         // from section loader
    showTogether = [],               // from section loader
    showTogetherSimulation = [],     // from section loader
    priceSimulation = 0,             // from section loader
    noInterestInstallmentValue = null,
    skuProductsKit = [],             // from section loader
    isMobile = false,                // from section loader (device detection)
  } = rawProps;
```

This lets the core component render while gracefully degrading features that depend on loader data (cross-selling, price simulation, etc.).


## 7. VTEX API Auth on Cloudflare Workers

Env vars must be set via `wrangler secret put` or `.dev.vars`, not `.env`.


## 8. Cookie Handling

In TanStack Start, manage `checkout.vtex.com__orderFormId` cookies manually via `document.cookie`.


## 32. Section Loader Logic Must Not Be Stripped

**Severity**: HIGH — sections render empty/broken

During migration, section loaders (e.g., `sections/Header/Header.tsx`) may have their async data-fetching logic removed. For example, the `ctx.invoke.vtex.loaders.categories.tree()` call that populates navigation menus. Without it, the header renders with no category links.

**Fix**: Keep all section loader logic intact. The loader signature `(props, req, ctx) => {...}` and the `ctx.invoke` calls should be preserved as-is.


## 34. Commerce Loaders Are Blind to the URL

**Severity**: CRITICAL — search and category pages return wrong/no products

When `resolve.ts` processes CMS blocks, it passes only the static CMS block props to commerce loaders (PLP, PDP). The current URL, query string (`?q=`), path (`/drywall`), sort, pagination, and filter parameters are never forwarded.

**Symptom**: Search pages (`/s?q=parafuso`) return zero products. Category pages (`/drywall`) show random/no products. Sort and pagination controls do nothing.

**Root cause**: `resolveValue()` in `resolve.ts` calls commerce loaders with `resolvedProps` (CMS block config only). The `matcherCtx` (containing URL, path, user-agent) is used for matcher evaluation but never passed to commerce loaders.

**Fix**: Pass `matcherCtx` as a second argument to commerce loaders in `resolve.ts`. Then the PLP loader can extract `?q=` for search, path for categories, `?sort=` for sorting, `?page=` for pagination, and `?filter.X=Y` for facets.

This is a change in `@decocms/start` (resolve.ts). Until upstreamed, use patch-package or vendor the file.


## 35. VTEX Product Loaders Ship with Empty priceSpecification

**Severity**: HIGH — no discount badges, no strikethrough prices, no installments

All three VTEX product loaders (`vtexProductList`, `productListingPage`, `productDetailsPage`) build offers with `priceSpecification: []`. The `useOffer()` hook depends on this array to extract `ListPrice` (for discount math + strikethrough), `SalePrice`, and `Installment` entries.

**Symptom**: Product cards show only one price (no strikethrough). No "X% OFF" discount badge. No "Ou em Nx de R$ X sem juros" installment text.

**Fix**: Add a `buildPriceSpecification()` helper to each loader that transforms the VTEX `commertialOffer` data:

```typescript
function buildPriceSpecification(offer: any): any[] {
  const specs: any[] = [];
  if (offer.ListPrice != null) {
    specs.push({ "@type": "UnitPriceSpecification", priceType: "https://schema.org/ListPrice", price: offer.ListPrice });
  }
  if (offer.Price != null) {
    specs.push({ "@type": "UnitPriceSpecification", priceType: "https://schema.org/SalePrice", price: offer.Price });
  }
  // Find best no-interest installment
  const noInterest = (offer.Installments ?? [])
    .filter((i: any) => i.InterestRate === 0)
    .sort((a: any, b: any) => b.NumberOfInstallments - a.NumberOfInstallments);
  if (noInterest.length > 0) {
    const best = noInterest[0];
    specs.push({
      "@type": "UnitPriceSpecification",
      priceType: "https://schema.org/SalePrice",
      priceComponentType: "https://schema.org/Installment",
      billingDuration: best.NumberOfInstallments,
      billingIncrement: best.Value,
      price: best.TotalValuePlusInterestRate,
    });
  }
  return specs;
}
```

This is a change in `@decocms/apps`. Until upstreamed, patch or vendor the loader files.


## 36. VTEX Facets API Response Structure Mismatch

The VTEX Intelligent Search facets endpoint returns `{ facets: ISFacetGroup[] }`, NOT a direct `ISFacetGroup[]` array. Accessing `response` directly as an array yields no filter data.

Additionally, `PRICERANGE` facets must be converted to `FilterToggle` format (with `value: "min:max"` strings) for the existing `Filters.tsx` component to render them. The component's `isToggle()` filter drops anything that isn't `FilterToggle`.

**Fix**: Unwrap with `const facetGroups = response.facets ?? [];` and convert price ranges:

```typescript
if (group.type === "PRICERANGE") {
  return { "@type": "FilterToggle" as const, key: "price", label: group.name, quantity: 0,
    values: group.values.map((v) => ({
      value: `${v.range.from}:${v.range.to}`, label: `R$ ${v.range.from} - R$ ${v.range.to}`,
      quantity: v.quantity, selected: false, url: `?filter.price=${v.range.from}:${v.range.to}`,
    })),
  };
}
```


## 39. Cart Requires Server-Side Proxy for VTEX API (CORS)

**Severity**: HIGH — add-to-cart, minicart, and checkout flow completely broken

The storefront domain (e.g., `espacosmart-tanstack.deco.site`) differs from the VTEX checkout domain (`lojaespacosmart.vtexcommercestable.com.br`). Direct browser `fetch()` calls to VTEX are blocked by CORS. Additionally, the `checkout.vtex.com__orderFormId` cookie is scoped to the VTEX domain and inaccessible from the storefront.

**Fix**: Use TanStack Start `createServerFn` to create server-side proxy functions:

```typescript
// src/lib/vtex-cart-server.ts
import { createServerFn } from "@tanstack/react-start";

export const getOrCreateCart = createServerFn({ method: "GET" })
  .validator((orderFormId: string) => orderFormId)
  .handler(async ({ data: orderFormId }) => {
    const url = orderFormId
      ? `https://${ACCOUNT}.vtexcommercestable.com.br/api/checkout/pub/orderForm/${orderFormId}`
      : `https://${ACCOUNT}.vtexcommercestable.com.br/api/checkout/pub/orderForm`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VTEX-API-AppKey": API_KEY, "X-VTEX-API-AppToken": API_TOKEN },
      body: JSON.stringify({ expectedOrderFormSections: ["items", "totalizers", "shippingData", "clientPreferencesData", "storePreferencesData", "marketingData"] }),
    });
    return res.json();
  });
```

The `useCart` hook manages the `orderFormId` in a client-side cookie and calls these server functions.

**Checkout URL**: The minicart's "Finalizar Compra" link must append the `orderFormId` as a query parameter since the VTEX checkout domain can't read the storefront's cookies:

```typescript
const checkoutUrl = `https://secure.${STORE_DOMAIN}/checkout/?orderFormId=${orderFormId}`;
```
