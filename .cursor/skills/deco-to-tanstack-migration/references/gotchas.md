# Migration Gotchas

Common pitfalls encountered during the Deco -> TanStack Start migration.

## 1. Section Loaders Don't Execute

Deco sections have `export const loader = async (props, req, ctx) => { ... }` that runs server-side before the component renders. In TanStack Start, these don't execute automatically. Components typed as `SectionProps<typeof loader>` expect the augmented props, but only receive the raw CMS block props.

**Symptom**: Components crash on `.find()`, `.length`, or property access of loader-provided props that are `undefined`.

**Fix**: Either:
- Move loader logic to a TanStack route loader
- Call it from a `createServerFn`
- Pass defaults and handle missing data gracefully in the component

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

## 2. useEffect Doesn't Run on Server

Components relying on `useEffect` to populate state will render empty on SSR, causing hydration mismatches.

**Fix**: Use TanStack route loaders or `createServerFn` to fetch data before rendering.

## 3. Signal .value in Render Doesn't Re-render

Reading `signal.value` inside a React render function doesn't create a subscription. The component won't re-render when the signal changes.

**Fix**: Use `useStore(signal.store)` from `@tanstack/react-store` for reactive reads in render. Write-only access (in event handlers) can still use `.value` setter.

## 4. class vs className

Preact accepts both `class` and `className`. React only accepts `className`. Most JSX files already use `className`, but some (especially `Drawer.tsx`, `Aside` components) use `class`.

**Fix**: Grep for `class=` (without `Name`) in JSX and replace.

## 5. dangerouslySetInnerHTML Syntax

Preact and React use the same syntax, but some Deco components use `innerHTML` directly.

**Fix**: Replace with `dangerouslySetInnerHTML={{ __html: content }}`.

## 6. ComponentChildren -> ReactNode

Not just a type rename -- `ComponentChildren` in Preact accepts `null | undefined | boolean | number | string | VNode`, while `ReactNode` in React is similar but has subtle differences. Usually fine in practice.

## 7. VTEX API Auth on Cloudflare Workers

`createServerFn` handlers run on Workers. Environment variables must be set via `wrangler secret put` or `.dev.vars`, not `.env`.

## 8. Cookie Handling

Deco's VTEX integration handles `checkout.vtex.com__orderFormId` cookies automatically. In TanStack Start, you manage them manually via `document.cookie` on the client.

## 9. Build Succeeds but Runtime Fails

After import rewrites, always test:
1. `npm run build` (catches type/import errors)
2. `npm run dev` + visit pages (catches runtime errors)
3. Test interactive features: cart add, drawer open/close, search

## 10. npm link for Local Dev

When developing across `deco-start`, `apps-start`, and the storefront simultaneously:

```bash
cd apps-start && npm link
cd ../deco-start && npm link
cd ../my-store && npm link @decocms/apps @decocms/start
```

Verify linked versions: `grep version node_modules/@decocms/*/package.json`

## 11. SVG Attributes

React uses camelCase for SVG attributes (`strokeWidth`, `fillRule`). Preact accepts either. The React compiler will warn about `stroke-width` etc.

**Fix**: `sed -i '' 's/stroke-width/strokeWidth/g'`

## 12. No Compat Layers

After migration is complete:
- `src/compat/` directory must not exist
- `tsconfig.json` paths should only have `~/*`
- `vite.config.ts` aliases should only have `~`
- `@decocms/start` should have zero files in `src/compat/`
- `@decocms/apps` should have zero files in `compat/`

## 13. AsyncLocalStorage in Client Bundles

`@decocms/start/cms/loader.ts` uses `AsyncLocalStorage` from `node:async_hooks` for per-request decofile overrides. Vite's client build replaces `node:async_hooks` with an empty shim. A direct named import breaks:

```typescript
// BROKEN in client build:
import { AsyncLocalStorage } from "node:async_hooks";
// -> Error: "AsyncLocalStorage" is not exported by "__vite-browser-external"
```

**Fix**: Use namespace import + runtime conditional:

```typescript
import * as asyncHooks from "node:async_hooks";

const ALS = (asyncHooks as any).AsyncLocalStorage;
const blocksOverrideStorage = ALS
  ? new ALS()
  : { getStore: () => undefined, run: (_s: any, fn: any) => fn() };
```

This happens when client-side routes import from `@decocms/start/cms` (barrel export), pulling in `loader.ts` transitively. The namespace import avoids Rollup's named-export validation, and the runtime check prevents construction errors in the browser.

## 14. TanStack Start Ignores Custom Worker Entry Code

**Severity**: CRITICAL -- cache logic, admin routes, and any custom request interception will silently not work in production.

TanStack Start's Cloudflare adapter **completely ignores** the `export default` in `server.ts`. It generates its own Worker entry that calls `createStartHandler(defaultStreamHandler)` directly. Custom logic inside `createServerEntry({ async fetch(request) { ... } })` is also stripped by Vite/Rollup in production builds.

**Symptom**: Admin routes like `/live/_meta` return HTML instead of JSON. Edge caching (Cache API, X-Cache headers) doesn't work despite being implemented. Every request hits the origin at full SSR cost. The `Cache-Control` headers from route-level `headers()` functions appear correctly (because TanStack applies them), but the custom `X-Cache` header and cache storage never execute.

**Diagnosis**: Search the built `dist/server/worker-entry-*.js` bundle for your custom code (e.g., `X-Cache`, `caches.open`, `_cache/purge`). If absent, TanStack stripped it.

**Fix**: Create a **separate** `src/worker-entry.ts` file that wraps TanStack Start's built handler. Point `wrangler.jsonc` to this file instead of `@tanstack/react-start/server-entry`.

```typescript
// src/worker-entry.ts
import "./setup";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
import { handleMeta, handleDecofileRead, handleDecofileReload, handleRender, corsHeaders } from "@decocms/start/admin";

const serverEntry = createServerEntry({
  async fetch(request) {
    return await handler.fetch(request);
  },
});

export default createDecoWorkerEntry(serverEntry, {
  admin: { handleMeta, handleDecofileRead, handleDecofileReload, handleRender, corsHeaders },
});
```

```jsonc
// wrangler.jsonc -- MUST point to custom entry, NOT the default
{
  "main": "./src/worker-entry.ts",
  // NOT: "main": "@tanstack/react-start/server-entry"
}
```

This ensures admin route interception AND edge caching survive the build because they're in the Worker's own fetch handler, outside of TanStack's build pipeline.

## 15. DaisyUI v4 Theme in Preview Shell

DaisyUI v4 with Tailwind v4's `@plugin "daisyui/theme"` scopes all color variables to `[data-theme="light"]`. The admin preview HTML shell (`/live/previews/*`) must include this attribute, or colors will be wrong.

**Symptom**: Preview in admin shows default/missing colors while production looks correct.

**Fix**: Configure the preview shell in `setup.ts`:

```typescript
setRenderShell({
  css: appCss,
  fonts: [...],
  theme: "light",     // adds data-theme="light" to <html>
  bodyClass: "bg-base-100 text-base-content",
  lang: "pt-BR",
});
```

The production HTML has `<html lang="pt-BR" data-theme="light">` set by the TanStack root layout. The preview shell must replicate this.

## 16. Admin Route Cache Bypass

Admin endpoints (`/live/_meta`, `/.decofile`, `/live/previews/*`) must NEVER be cached by Cloudflare's edge cache. They serve dynamic JSON/HTML and have CORS headers that vary by request origin.

**Fix**: `/live/` and `/.decofile` are included in `DEFAULT_BYPASS_PATHS` in `createDecoWorkerEntry`. Admin routes are intercepted BEFORE any caching logic runs.

If you see stale or incorrect responses from admin endpoints, check:
1. The admin route handler runs before `caches.open()` in the Worker fetch
2. Cache-busting: append `?t=${Date.now()}` to verify
3. The response has correct `Content-Type: application/json` (not text/html)

## 17. SiteTheme Component is a Stub

In migrated storefronts, `components/ui/Theme.tsx` returns `null`. The CMS Theme section colors are NOT applied at runtime -- all colors come from the compiled CSS via `@plugin "daisyui/theme"` in `app.css`.

If the CMS has a Theme section with color values that differ from `app.css`, those CMS values are silently ignored. This is intentional: the source of truth for colors moves from CMS to CSS at build time.

**If you need dynamic themes**: Implement `SiteTheme` to render a `<style>` tag with CSS custom properties, converting the Theme section's color props to DaisyUI variables. But this adds complexity and is rarely needed.

## 18. Loader References in JSON Schema (`Resolvable`)

When sections have properties that can be either literal data OR a loader reference (e.g., `products: Product[]` which can also be `{ __resolveType: "vtex/loaders/..." }`), the schema must define a `Resolvable` definition.

Key requirements:
- The definition key must be the literal string `"Resolvable"` (the admin's `deRefUntil` function looks for it by name)
- It must have `additionalProperties: true` (to allow `__resolveType` + `props`)
- Properties that accept loader references must be wrapped in `anyOf: [originalSchema, { $ref: "#/definitions/Resolvable" }]`
- The `composeMeta()` function in `schema.ts` handles this via `wrapResolvableProperties()`

Without this, the admin shows "Incorrect type. Expected 'array'" for fields that contain loader references in the `.decofile`.

## 19. @tanstack/store subscribe() Returns Object, Not Function

**Severity: CRITICAL** -- This causes cascading failures across the entire page.

`@tanstack/store@0.9.x`'s `Store.subscribe()` returns `{ unsubscribe: Function }`, NOT a plain function. React's `useSyncExternalStore` (and `useEffect` cleanup) expect the subscribe callback to return a bare unsubscribe function. Passing the object through causes:

1. "TypeError: destroy_ is not a function" (non-minified) / "TypeError: J is not a function" (minified)
2. Which cascades into React #419 (hydration failure)
3. Which cascades into React #130 (undefined component after hydration bailout)
4. Which makes the entire page non-interactive (0 interactive elements)

**Symptom**: Page SSR renders fine, but client shows "J is not a function" repeating hundreds of times. All interactive elements stop working.

**Fix**: Unwrap the return value in your `Signal.subscribe()` implementation:

```typescript
subscribe(fn) {
  const sub = store.subscribe(() => fn());
  return typeof sub === "function" ? sub : sub.unsubscribe;
},
```

## 20. createPortal Imported from Wrong Module

In Preact, `createPortal` is available from `preact/compat` which maps to `react` in some setups. In React, `createPortal` lives in `react-dom`.

**Symptom**: `createPortal is not a function` or components using portals (modals, drawers, toasts) silently fail.

**Fix**:
```bash
# Find and replace across all files
grep -r 'createPortal.*from "react"' src/ --include='*.tsx' -l
# Change to: import { createPortal } from "react-dom";
```

## 21. for Attribute Must Be htmlFor in React JSX

Preact accepts both `for` and `htmlFor` on `<label>` elements. React only accepts `htmlFor`. Using `for` causes a hydration mismatch because the server renders `for` but the client expects `htmlFor`.

**Symptom**: React #419 hydration errors on pages with labels (search bars, forms, drawers).

**Fix**: `grep -r ' for={' src/ --include='*.tsx'` and replace with `htmlFor={`.

## 22. Fresh-Specific Attributes Must Be Removed

Fresh/Preact components may use `data-fresh-disable-lock={true}` on elements. This attribute has no meaning in React and can cause hydration mismatches.

**Fix**: Remove all `data-fresh-disable-lock` attributes.

## 23. Custom useId with Math.random() Causes Hydration Mismatch

Some storefronts have a custom `useId` hook that appends `Math.random()` to generate "unique" IDs. This guarantees different IDs on server vs client, causing React #419.

**Fix**: Replace with React's native `useId`:

```typescript
import { useId as useReactId } from "react";
export const useId = useReactId;
```

## 24. new URL() with Relative Paths Fails in Workers

`new URL("/product/p")` works in browsers (uses `window.location` as base) but throws `Invalid URL` in Workers/Node because there's no implicit base.

**Fix**: Always provide a base URL:
```typescript
const parsed = new URL(url, "https://localhost");
return parsed.pathname + parsed.search;
```

## 25. Global Variables Throw ReferenceError

Code that references undeclared globals (e.g., `userAddressData` injected by VTEX scripts) will throw `ReferenceError: X is not defined` in Workers where those scripts don't run.

**Fix**: Access via `globalThis`:
```typescript
const data = (globalThis as any).userAddressData;
if (data && Array.isArray(data)) { /* use data */ }
```

## 26. Section-Type Props Use __resolveType Format

In the new `@decocms/start`, section-type props from the CMS arrive as `{ __resolveType: "site/sections/Foo.tsx", ...props }`, NOT the old `{ Component, props }` format. Components that render section props must handle this.

**Fix**: Create a `RenderSection` bridge component that:
1. Checks for `section.Component` (old format) and renders directly
2. Checks for `section.__resolveType` (new format), resolves via `getSection()` from `@decocms/start/cms`, and renders with `React.lazy` + `Suspense`

## 27. jsdom Must Be Replaced in Workers

`jsdom` is a heavy Node.js dependency that cannot run in Cloudflare Workers. Components using it for HTML sanitization must use `dompurify` instead.

**Fix**: Replace `import { JSDOM } from "jsdom"` with:
```typescript
import DOMPurify from "dompurify";
const clean = typeof document !== "undefined" ? DOMPurify.sanitize(html) : html;
```

## 28. Deno npm: Prefix Must Be Removed

Imports like `import Color from "npm:colorjs.io"` use the Deno-specific `npm:` prefix. Vite/Node don't understand it.

**Fix**: Remove the `npm:` prefix and install the package: `npm install colorjs.io`.

## 29. Device Context Must Be Server-Driven, Not Hardcoded

**Severity**: HIGH — breaks entire page layout (mobile vs desktop)

The original Deco/Fresh framework injected `ctx.device` automatically into section contexts. In the new TanStack Start stack, the `Device` context (used by `useDevice()`) must be explicitly provided with the correct value from server-side User-Agent detection.

**Symptom**: All visitors see the mobile layout regardless of device. The `useDevice()` hook always returns `{ isMobile: true }` because the `Device.Provider` was hardcoded with `value={{ isMobile: true }}` in `__root.tsx`.

**Root cause**: The root route can't use `createServerFn` for device detection (causes Rollup code-split errors with `tss-serverfn-split`). And the Device context default was set to mobile.

**Fix**: Detect device inside each page route's existing `createServerFn` loader (which already has access to `getRequestHeader("user-agent")`), return `isMobile` alongside the page data, and wrap the page component with `<Device.Provider>`:

```typescript
// In routes/index.tsx or routes/$.tsx
const MOBILE_RE = /mobile|android|iphone|ipad|ipod|webos|blackberry|opera mini|iemobile/i;

const loadPage = createServerFn({ method: "GET" }).handler(async () => {
  const ua = getRequestHeader("user-agent") ?? "";
  const matcherCtx = { userAgent: ua, url: getRequestUrl().toString(), path: "/", cookies: getCookies() };
  const page = await resolveDecoPage("/", matcherCtx);
  return { page, isMobile: MOBILE_RE.test(ua) };
});

function HomePage() {
  const { page, isMobile } = Route.useLoaderData();
  return (
    <Device.Provider value={{ isMobile }}>
      <DecoPageRenderer sections={page.resolvedSections} />
    </Device.Provider>
  );
}
```

Remove the hardcoded `<Device.Provider value={{ isMobile: true }}>` from `__root.tsx`.

**Key constraint**: Do NOT put `createServerFn` in `__root.tsx` — TanStack Start's server function splitter cannot handle it there.

## 30. Stale Edge Cache After Deploy Requires Explicit Purge

**Severity**: MEDIUM — causes "Failed to fetch dynamically imported module" errors

After deploying a new build to Cloudflare Workers, the edge cache may still serve old HTML that references previous JS bundle hashes. This causes module import failures.

**Fix**: After every deploy, purge the cache:
1. Set a `PURGE_TOKEN` secret: `npx wrangler secret put PURGE_TOKEN`
2. Call the purge endpoint: `POST /_cache/purge` with `Authorization: Bearer <token>` and body `{"paths":["/"]}`
3. Automate this in CI/CD (see the deploy.yml workflow)

## 31. CSS Theme Class Prefixes Must Not Be Renamed

**Severity**: HIGH — breaks all theme colors

The original site uses `seasonal-*` CSS class prefixes for theme variables (e.g., `bg-seasonal-brand-terciary-1`, `text-seasonal-neutral-1`). During migration, do NOT rename these to `header-*`, `footer-*`, or any other prefix. The theme variables are defined centrally and all components reference the same `seasonal-*` namespace.

**Fix**: Only change what React strictly requires: `class` → `className`, `for` → `htmlFor`. Preserve all original CSS class names exactly.

## 32. Section Loader Logic Must Not Be Stripped

**Severity**: HIGH — sections render empty/broken

During migration, section loaders (e.g., `sections/Header/Header.tsx`) may have their async data-fetching logic removed. For example, the `ctx.invoke.vtex.loaders.categories.tree()` call that populates navigation menus. Without it, the header renders with no category links.

**Fix**: Keep all section loader logic intact. The loader signature `(props, req, ctx) => {...}` and the `ctx.invoke` calls should be preserved as-is.

## 33. usePartialSection is a No-Op

**Severity**: HIGH — tab switching, filter toggling, any partial section re-render breaks silently

Deco's `usePartialSection` hook re-renders a section with new props by making a server request for just that section's HTML. In the React port, this mechanism doesn't exist — `usePartialSection` returns empty data attributes.

**Symptom**: Tabbed product shelves only show the first tab. Clicking other tabs does nothing. Filter visibility toggles don't work. Any component using `usePartialSection` for dynamic props appears frozen.

**Fix**: Replace with React `useState` for client-side state switching. If all tab data is already loaded server-side (common for tabbed shelves where the loader fetches all tabs), just switch between the data client-side:

```typescript
// Before: relies on usePartialSection to re-render with new tabIndex
<button {...usePartialSection({ props: { tabIndex: i } })}>

// After: React state-driven tab switching
const [activeTab, setActiveTab] = useState(0);
<button onClick={() => setActiveTab(i)}>
// Then render tabs[activeTab].products instead of tabs[tabIndex].products
```

For filter toggles, replace `usePartialSection({ props: { openFilter: !openFilter } })` with `useState`:
```typescript
const [openFilter, setOpenFilter] = useState(true);
<button onClick={() => setOpenFilter(!openFilter)}>
```

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

## 37. DaisyUI v4 Collapse Broken with Tailwind v4

**Severity**: MEDIUM — filter sidebars, FAQ accordions, any collapsible section renders collapsed

DaisyUI v4's collapse component uses `grid-template-rows: auto 0fr` with `content-visibility: hidden` and expands via `:has(>input:checked)`. In combination with Tailwind v4, the expand chain breaks — content stays collapsed regardless of checkbox state.

**Symptom**: Filter sidebar shows as empty space. Collapse titles may render but content is permanently hidden. Custom CSS overrides on `.collapse` conflict with DaisyUI's generated styles.

**Fix**: Replace DaisyUI collapse with native `<details>/<summary>` HTML elements:

```typescript
// Before: DaisyUI collapse with hidden checkbox
<div className="collapse">
  <input type="checkbox" defaultChecked />
  <div className="collapse-title">Category</div>
  <div className="collapse-content">...filters...</div>
</div>

// After: Native HTML, works everywhere
<details open className="group">
  <summary className="cursor-pointer font-semibold">Category</summary>
  <div className="mt-2">...filters...</div>
</details>
```

## 38. Signal Shim Doesn't Auto-Trigger React Re-renders

**Severity**: HIGH — drawers don't open, cart badge doesn't update, any signal-driven UI appears frozen

The Preact-to-React signal compat shim has a pub/sub pattern (`_listeners`), but reading `signal.value` in a React render function creates NO subscription. React components don't re-render when the signal changes.

**Symptom**: Setting `displayCart.value = true` doesn't open the cart drawer. Cart item count badge stays at 0 after adding items. Menu drawer toggle does nothing.

**Root cause**: In Preact, `@preact/signals` automatically tracks signal reads in render and re-renders. The shim just has get/set on `.value` with manual `_listeners` — React has no awareness of it.

**Fix (recommended)**: Use `useStore` from `@tanstack/react-store` for components that need reactive reads:

```typescript
import { useStore } from "@tanstack/react-store";
const { displayCart } = useUI();
const open = useStore(displayCart.store);  // auto re-renders on change
```

**Fix (interim)**: For components not yet migrated to `useStore`, bridge with `useState` + `useEffect`:

```typescript
const { displayCart } = useUI();
const [open, setOpen] = useState(displayCart.value);
useEffect(() => {
  const unsub = displayCart.subscribe(() => setOpen(displayCart.value));
  return unsub;
}, []);
```

**Fix (DaisyUI drawers)**: Since DaisyUI drawers are checkbox-driven, directly toggle the DOM checkbox as a pragmatic workaround:

```typescript
const toggleDrawer = (id: string, open: boolean) => {
  const checkbox = document.getElementById(id) as HTMLInputElement;
  if (checkbox) checkbox.checked = open;
};
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

## 40. Filter Sidebar Invisible Due to Background Color Match

**Severity**: LOW — cosmetic, but confusing during development

The aside element for search/category filters renders correctly in the DOM (proper width, height, content) but appears invisible because its background matches the page background (e.g., both `#E9E9E9`).

**Symptom**: Filters appear "non-existent" even though they're in the DOM. Filter links are accessible but invisible.

**Fix**: Add a contrasting background to the filter aside:

```typescript
<aside className="... bg-white rounded-lg p-4">
```

## 41. Component Props `class` vs `className` Causes Silent Failures

**Severity**: HIGH — specific component features silently disappear

Gotcha #4 covers JSX attributes (`class=` on HTML elements), but this is about **component props** that are destructured as `class`. Preact components often destructure `{ class: _class }` from props because Preact accepts both `class` and `className`. In React, only `className` is passed, so `_class` ends up as `undefined`.

**Symptom**: The Drawer component's `className="drawer-end"` never reaches the rendered div. CartDrawer renders without `drawer-end`, making it overlay the wrong side or not render at all.

**Fix**: In component interfaces, accept both and merge:

```typescript
// Before (Preact-style):
function Drawer({ class: _class, ...rest }) {
  return <div className={`drawer ${_class}`}>

// After (React-compatible):
function Drawer({ className, ...rest }) {
  return <div className={`drawer ${className ?? ""}`}>
```

Search for `class:` in component destructuring patterns across all files, not just in JSX attributes.

## 42. Tailwind v4 Logical vs Physical Property Cascade Conflict

**Severity**: CRITICAL — causes container width mismatches across the entire site

Tailwind v4 generates **logical CSS properties** (`padding-inline`, `margin-inline`) while Tailwind v3 generated **physical properties** (`padding-left`, `padding-right`). When an element has BOTH shorthand (`px-*`) and longhand (`pl-*`/`pr-*`) responsive classes, the cascade breaks silently.

**Symptom**: Containers are narrower or have asymmetric padding compared to production. The layout "looks off" at certain breakpoints but works at others.

**Root cause**: In Tailwind v3, `md:px-6` and `sm:pl-0` both target `padding-left` — same CSS property, media query specificity decides the winner. In Tailwind v4, `md:px-6` targets `padding-inline` (shorthand) while `sm:pl-0` targets `padding-inline-start` (longhand). These are different CSS properties. If `padding-inline-start` appears later in the compiled stylesheet, it overrides the shorthand's start value, creating asymmetric padding.

**Example**:
```html
<!-- This pattern exists in many Deco storefronts -->
<div class="pl-4 sm:pl-0 md:px-6 xl-b:px-0 max-w-[1280px] mx-auto">
```

In Tailwind v3: at `md` viewport, `px-6` sets `padding-left: 1.5rem` and `padding-right: 1.5rem`, cleanly overriding `sm:pl-0`.

In Tailwind v4: at `md` viewport, `px-6` sets `padding-inline: 1.5rem`, but `pl-0` (from `sm:`) may still override `padding-inline-start` depending on stylesheet order.

**Fix**: Replace mixed shorthand + longhand patterns with consistent longhand properties:

```
md:px-6 xl-b:px-0       →  md:pl-6 md:pr-6 xl-b:pl-0 xl-b:pr-0
px-4 lg:px-6 xl-b:px-0  →  pl-4 pr-4 lg:pl-6 lg:pr-6 xl-b:pl-0 xl-b:pr-0
```

**Detection**: Find all elements with mixed patterns:
```bash
grep -rn 'px-[0-9].*pl-\|pl-.*px-[0-9]\|px-[0-9].*pr-\|pr-.*px-[0-9]' src/ --include='*.tsx'
```

Only convert `px-*` on elements that ALSO have `pl-*` or `pr-*`. Don't blindly replace all `px-*` across the codebase — elements with only `px-*` (no mixed longhand) work fine.

Also check for the same issue with `mx-*` mixed with `ml-*`/`mr-*`, and `my-*` mixed with `mt-*`/`mb-*`.

## 43. CSS oklch() Color Variables Must Store Triplets, Not Hex

**Severity**: HIGH — all SVG icons render as black, brand colors break

Sites that use `oklch(var(--variable))` in SVG fill/stroke attributes (common in Deco storefronts with seasonal/theme color systems) require the CSS variables to store **oklch triplets** (`100% 0.00 0deg`), NOT hex values (`#FFF`). `oklch(#FFF)` is invalid CSS — the browser ignores it and falls back to black.

**Symptom**: Slider arrows, footer icons, search icons, filter icons — anything using `oklch(var(--...))` — renders as black circles/shapes instead of the brand colors.

**Root cause**: The original site's Theme section (via Deco CMS) outputs oklch triplets into CSS variables. During migration, if the CSS variables are manually set to hex values, every `oklch()` wrapper produces invalid CSS.

**Fix**: Convert all theme CSS variables from hex to oklch triplets:
```css
/* WRONG — invalid CSS when used as oklch(var(--bg-seasonal-2)) */
--bg-seasonal-2: #FFF;

/* CORRECT — oklch(100% 0.00 0deg) is valid */
--bg-seasonal-2: 100% 0.00 0deg;
```

**Dual-usage caveat**: Variables used BOTH inside `oklch()` wrappers AND directly in CSS properties need different handling:

```css
/* @theme entries for Tailwind utilities — need oklch() wrapper */
--color-bg-seasonal-1: oklch(var(--bg-seasonal-1));

/* Direct CSS usage — also needs oklch() wrapper */
background-color: oklch(var(--bg-seasonal-1));
```

The DaisyUI v4 pattern: `@theme` entries map `--color-X` to `var(--Y)`. Tailwind generates `background-color: var(--color-X)` which resolves to the raw triplet — invalid without the `oklch()` wrapper. Wrap all `@theme` entries that reference oklch-triplet variables.

**Python conversion helper**:
```python
from colorjs import Color
c = Color("#EE4F31")
l, c_val, h = c.convert("oklch").coords()
print(f"{l*100:.2f}% {c_val:.2f} {h:.0f}deg")  # 64.42% 0.20 33deg
```

## 44. Runtime Module Import Kills Lazy-Loaded Sections

**Severity**: HIGH — sections silently disappear, data appears in RSC streaming but component renders nothing

Vite tree-shakes unused imports in production builds, so a section file that imports a non-existent module may pass `npm run build` without errors. But at runtime, when the section is dynamically imported via `registerSections`'s lazy `() => import("./sections/X")`, ALL imports in the module execute. A missing file kills the entire section module.

**Symptom**: Product shelves or other sections disappear. HTML size drops significantly. Product data appears in React streaming data (`$R[...]` notation) but zero product cards render as actual HTML. No error in the build log.

**Example**:
```typescript
// sections/Product/ProductShelf.tsx
import LoadingCard from "~/components/product/loadingCard";  // file doesn't exist!
export { default, loader } from "~/components/product/ProductShelf";

export function LoadingFallback() {
  return <LoadingCard />;  // only used here — tree-shaken in build
}
```

Build passes because `LoadingFallback` is a named export that nothing imports. But at runtime, the dynamic `import("./sections/Product/ProductShelf")` executes the module, hits the missing `loadingCard` import, and the entire section fails to load.

**Fix**: Create the missing file, even if it's a minimal stub:
```typescript
// components/product/loadingCard.tsx
export default function LoadingCard() {
  return <div className="animate-pulse bg-base-200 h-[400px] w-[200px] rounded" />;
}
```

**Prevention**: After copying files from the original repo, verify all imports resolve:
```bash
npx tsc --noEmit  # catches missing modules that Vite's tree-shaking hides
```

## 45. GitHub Packages npm Requires Auth Even for Public Packages

**Severity**: MEDIUM — blocks dependency installation for new contributors and CI

GitHub Packages' npm registry (`npm.pkg.github.com`) requires authentication even for public packages. This is a known limitation that GitHub has not resolved. Attempting to `npm install` a public `@decocms/*` package without a token returns `401 Unauthorized`.

**Workaround A (recommended for development)**: Use `github:` Git URL syntax instead of npm registry references. This bypasses the npm registry entirely and uses Git HTTPS (no auth needed for public repos):

```json
{
  "@decocms/apps": "github:decocms/apps-start",
  "@decocms/start": "github:decocms/deco-start#main"
}
```

**Important**: The repo name in the `github:` URL must match the actual GitHub repo name, not the npm package name. `@decocms/start` is published from repo `decocms/deco-start`, NOT `decocms/start`.

**Workaround B (recommended for production)**: Publish to npmjs.com instead. Only npm's public registry supports truly zero-auth public package installation.

**Workaround C (if you must use GitHub Packages)**: Generate a GitHub PAT with `read:packages` scope and configure:
```bash
npm config set //npm.pkg.github.com/:_authToken <YOUR_TOKEN>
```

Or in project `.npmrc` with an env var (for CI):
```
@decocms:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

**Tradeoff with `github:` syntax**: No semver resolution — `npm update` is meaningless. Pin to a tag for stability: `github:decocms/deco-start#v0.14.2`. Without a tag, you get HEAD of the default branch.
