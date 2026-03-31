
# Deco TanStack Storefront Patterns

Patterns and fixes discovered while porting and running `espacosmart-storefront` on the `@decocms/start` + TanStack Start stack. These apply to **any** Deco site after the initial migration.

## When to Use This Reference

- Debugging runtime errors in a deco-start storefront
- Porting sections that use nested sections (`{ Component, props }`)
- Configuring dev mode vs production cache behavior
- Fixing Cloudflare Worker / miniflare errors
- Making VTEX API calls resilient to 404s
- Finding and fixing remaining Fresh/Preact patterns in React components

---

## 1. Nested Sections (`{ Component, props }`)

### Problem

In `deco-cx/deco` (Fresh), nested sections arrived as `{ Component: FunctionRef, props: {...} }`. In TanStack, the CMS engine resolves sections to `{ __resolveType: "site/sections/X.tsx", ...props }` — the `Component` property is a string key, not a function reference.

Using `<section.Component {...section.props} />` in React treats the string as an HTML tag name, causing: `Error: Invalid tag: site/sections/Product/BuyTogether.tsx`

### Solution (two layers)

**Engine (`deco-start/src/cms/resolve.ts`)** — `normalizeNestedSections`:
After resolving top-level section props, recursively walks all props and converts any nested section (objects with `__resolveType` pointing to a registered section) from:
```
{ __resolveType: "site/sections/X.tsx", ...props }
```
to:
```
{ Component: "site/sections/X.tsx", props: { ...normalizedProps } }
```

This preserves the same `{ Component, props }` shape as Fresh.

**Renderer (`deco-start/src/hooks/DecoPageRenderer.tsx`)** — `SectionRenderer` / `SectionList`:
Components that accept nested sections import from `@decocms/start/hooks`:

```typescript
import { SectionRenderer, SectionList, type Section } from "@decocms/start/hooks";

// Single nested section
<SectionRenderer section={children} />

// Array of nested sections
<SectionList sections={sectionChildrens} />
```

`SectionRenderer` handles both:
- **String `Component`** → lazy lookup in section registry
- **Function `Component`** → direct render (legacy Fresh compat)

### How to Find Affected Sections

```bash
rg '<\w+\.Component' src/sections/ src/components/
```

Any `<section.Component {...section.props} />` or `<children.Component {...children.props} />` must be replaced with `<SectionRenderer section={section} />` or `<SectionList sections={sections} />`.

### Common Affected Patterns

| Pattern | Files |
|---------|-------|
| `children.Component` | Container, GridItem, NotFoundChallenge |
| `sectionChildrens.map(s => <s.Component>)` | Grid, Flex |
| `section.Component` | ShelfWithImage, ProductMain (sectionDefaultPage, sectionHouseCatalog) |
| `notFoundSections.map(s => <s.Component>)` | search/NotFound |

---

## 2. Nested Section Loaders Don't Run

### Problem

Section loaders (`export const loader`) registered via `registerSectionLoaders()` only run for **top-level** sections (those directly on the CMS page). Nested sections rendered via `SectionRenderer` don't have their loaders executed — they get raw CMS props without enrichment.

### Symptom

A nested section crashes because it expects loader-enriched props (e.g., `buyTogetherPricesSimulation` is `undefined`).

### Fix

Add a guard at the top of the component:

```typescript
function BuyTogether({ products, buyTogetherPricesSimulation, ...rest }) {
  if (!products?.length || !buyTogetherPricesSimulation) return null;
  // ...
}
```

For full support, either:
1. Register the nested section in `registerSectionLoaders()` AND make the section loader registry run recursively on normalized nested sections
2. Integrate the nested section's data fetching into the parent section's loader

---

## 3. Dev Mode Cache Control

### Architecture — 4 cache layers

| # | Layer | Where | Dev | Prod |
|---|-------|-------|-----|------|
| 1 | **Cloudflare Cache API** | Edge Worker (`workerEntry.ts`) | `caches` doesn't exist → skip | Full Cache API with segments |
| 2 | **Server-side SWR** | SSR in-memory (`createCachedLoader`) | `NODE_ENV=development` → bypass | SWR with maxAge per loader |
| 3 | **TanStack Query** | Client (`__root.tsx`) | `staleTime: 0` via `import.meta.env.DEV` | `staleTime: 30_000` |
| 4 | **TanStack Router** | Client SPA nav (`routeCacheDefaults`) | `isDevMode()` → `{staleTime:0, gcTime:0}` | Profile-based (1-5 min) |

### Key Configuration

**`.env`** — Do NOT set `DECO_CACHE_DISABLE=true` (dangerous if deployed to prod). Vite automatically sets `NODE_ENV=development` in dev.

**`__root.tsx`** — Use `import.meta.env.DEV` for client-side:
```typescript
new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: import.meta.env.DEV ? 0 : 30_000,
      gcTime: import.meta.env.DEV ? 0 : 5 * 60_000,
      refetchOnWindowFocus: import.meta.env.DEV,
    },
  },
})
```

**`cachedLoader.ts`** — Inline env detection (Cloudflare Worker can't resolve cross-file imports from linked packages):
```typescript
const env = typeof globalThis.process !== "undefined" ? globalThis.process.env : undefined;
const isDev = env?.DECO_CACHE_DISABLE === "true" || env?.NODE_ENV === "development";
if (policy === "no-store" || isDev) return loaderFn;
```

**`routeCacheDefaults()`** — Same inline pattern (no `import { isDevMode }` — fails in Worker runtime).

### Critical: Do NOT use `import { isDevMode } from "./env"` in SDK files

Cloudflare Worker's module runner (`workers/runner-worker.js`) can't resolve relative imports from linked packages. Always inline the env detection:

```typescript
// WRONG — crashes with "ReferenceError: isDevMode is not defined"
import { isDevMode } from "./env";

// CORRECT — inline detection
const env = typeof globalThis.process !== "undefined" ? globalThis.process.env : undefined;
const isDev = env?.DECO_CACHE_DISABLE === "true" || env?.NODE_ENV === "development";
```

---

## 4. Cloudflare Cache API Guards (`workerEntry.ts`)

### Problem

`caches.default` (Cloudflare Cache API) doesn't exist in local dev (miniflare/wrangler dev). Accessing it throws: `internal error; reference = ...`

### Fix

Guard all cache operations:

```typescript
const cache = typeof caches !== "undefined"
  ? (caches as unknown as { default?: Cache }).default ?? null
  : null;

// cache.match
if (cache) {
  try {
    const cached = await cache.match(cacheKey);
    // ...
  } catch { /* Cache API unavailable */ }
}

// cache.put
if (cache) {
  try {
    ctx.waitUntil(cache.put(cacheKey, toStore));
  } catch { /* skip */ }
}

// cache.delete (purge)
if (!cache) {
  return Response.json({ purged: [], total: 0, note: "Cache API unavailable" });
}
```

---

## 5. VTEX API Resilience

### Problem

VTEX cross-selling endpoints (e.g., `/crossselling/{id}/showtogether`) return 404 for products without related items. An unhandled 404 crashes the entire section loader, causing the PDP to fail.

### Fix

Wrap optional VTEX calls with `.catch(() => fallback)`:

```typescript
const showTogetherPromise = getCrossSelling(id, "showtogether").catch(() => []);
```

### General Pattern for Section Loaders

Section loaders that call multiple APIs should use `Promise.allSettled` or individual `.catch()` to prevent one failure from killing the entire page.

---

## 6. Fresh/Preact Remnants to Fix

### `f-partial` / `f-client-nav` attributes

Fresh/HTMX-specific attributes. Replace with TanStack Router navigation:

```typescript
// BEFORE (Fresh)
<button f-partial="/products/variant" f-client-nav>

// AFTER (TanStack)
<a href={relative(url)} />
// or
const navigate = useNavigate();
<button onClick={() => navigate({ to: relative(url) })} />
```

### `MouseEvent` vs `React.MouseEvent`

React 19 requires `React.MouseEvent<HTMLButtonElement>` instead of native `MouseEvent` in onClick handlers.

### `product.url` absolute URLs

VTEX returns absolute URLs (e.g., `https://secure.store.com.br/product/p`). Always wrap with `relative()`:

```typescript
href={relative(product.url) ?? product.url}
```

### SVG attribute casing

`stroke-linecap` → `strokeLinecap`, `stroke-linejoin` → `strokeLinejoin`, `fetchpriority` → `fetchPriority`

### `selected` on `<option>`

React uses `<select defaultValue={val}>` instead of `<option selected>`.

### `isMobile` / custom props on DOM elements

React warns about unknown DOM props. Filter them before spreading onto native elements:

```typescript
const { isMobile, productMain, ...htmlProps } = props;
return <div {...htmlProps} />;
```

---

## 7. `DecoPageRenderer` Consolidation

The `DecoPageRenderer` should come from `@decocms/start/hooks`, not be duplicated in the site:

```typescript
// src/components/DecoPageRenderer.tsx
export { DecoPageRenderer } from "@decocms/start/hooks";
```

This ensures the lazy cache is shared between `DecoPageRenderer` (top-level sections) and `SectionRenderer` (nested sections).

---

## 8. Vite Cache Stale Data

### Symptom

Code changes don't take effect after restarting the dev server.

### Fix

```bash
pkill -f "vite dev"
rm -rf node_modules/.vite .wrangler
bun run dev  # or npx vite dev
```

When using `file:` dependencies (local linked packages), Vite's pre-bundling cache can serve stale modules. Always clear after changes to linked packages.

---

## 9. Section Registry Debug

If a section doesn't render, add this guard in `DecoPageRenderer`:

```typescript
lazy(async () => {
  const mod = await loader();
  if (!mod?.default) {
    console.error(`[DecoSection] "${key}" has no default export`, Object.keys(mod ?? {}));
    return { default: () => null };
  }
  return mod;
})
```

This logs the exact section key that's broken instead of crashing with "Element type is invalid".

---

## 10. `node:async_hooks` Leak to Client Bundle

### Problem

`src/apps/site.ts` imports `RequestContext` from `@decocms/start/sdk/requestContext`, which uses `AsyncLocalStorage` from `node:async_hooks`. When client components import from `site.ts` (e.g., for `AppContext` type or `_platform` constant), the bundler pulls `node:async_hooks` into the client bundle:

```
Uncaught (in promise) Error: Module "node:async_hooks" has been externalized for browser compatibility
```

### Root Cause

A single file (`site.ts`) exports both:
- **Client-safe** things: `Platform` type, `_platform` constant, `AppContext` type
- **Server-only** things: `getAppContext()` function that uses `RequestContext` (AsyncLocalStorage)

Client components importing `{ AppContext }` from `~/apps/site.ts` transitively import the server-only code.

### Fix — Split into Two Files

**`src/apps/site.types.ts`** (client-safe):
```typescript
import type { Device } from "~/sdk/useDevice";

export type Platform = "vtex";
export const _platform: Platform = "vtex";

export interface AppContext {
  request: Request;
  device: Device;
}
```

**`src/apps/site.ts`** (server-only):
```typescript
import { RequestContext } from "@decocms/start/sdk/requestContext";
import { detectDevice } from "~/sdk/useDevice";

export type { Platform, AppContext } from "./site.types";
export { _platform } from "./site.types";

export function getAppContext(req?: Request) {
  const request = req ?? RequestContext.value;
  return { request, device: detectDevice(request) };
}
```

**All client components**: import from `site.types.ts`:
```typescript
// BEFORE
import { AppContext } from "~/apps/site.ts";

// AFTER
import type { AppContext } from "~/apps/site.types.ts";
```

### Discovery Command

```bash
rg 'from.*~/apps/site' src/components/ src/sections/ src/sdk/ --glob '*.{tsx,ts}' -l
```

---

## 11. SliderJS DOM Timing (requestAnimationFrame Retry)

### Problem

`SliderJS.tsx` uses vanilla JS `document.querySelector` inside `useEffect` to find slider elements. In TanStack Start with Suspense/lazy sections, the DOM elements may not exist when the effect runs — `setup()` fails silently.

### Symptom

Slider arrows/dots don't work, autoplay doesn't start, but no console errors. The `setup()` function returns early because `root` is `null`.

### Fix — rAF Retry Loop

```typescript
function Slider({ rootId, scroll, interval, infinite }: Props) {
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let retries = 0;
    const maxRetries = 20;

    const trySetup = () => {
      cleanup = setup({ rootId, scroll, interval, infinite });
      if (cleanup) return;

      retries++;
      if (retries < maxRetries) {
        requestAnimationFrame(trySetup);
      }
    };

    requestAnimationFrame(trySetup);

    return () => cleanup?.();
  }, [rootId, scroll, interval, infinite]);

  return <div data-slider-controller-js />;
}
```

Uses `requestAnimationFrame` (not `setTimeout`) because rAF fires after the browser has painted — the DOM is guaranteed to be up to date.

### Why Not Convert to React Refs

SliderJS relies on data-attributes (`data-slider`, `data-slide`, `data-dot`) and `IntersectionObserver` on items. Converting entirely to React refs would require rewriting every section that uses `<Slider.Root>`, `<Slider.Item>`, `<Slider.Dot>`. The rAF retry is a pragmatic fix that preserves the existing API surface.

---

## 12. Cart Button Loading State Block

### Problem

`CartButtonVTEX.tsx` reads `loading` from `useCart()`, which starts as `true` during initialization. If the cart fetch fails silently or takes too long, the button stays disabled and the user cannot open the cart drawer.

### Fix — Separate Data Loading from UI Interactivity

The cart icon/button always needs to be clickable (to open the drawer). The loading state should only affect the badge/total display:

```typescript
return (
  <Button
    currency={currency}
    loading={false}  // Button always clickable
    total={(total - discounts) / 100}
    items={items.map((item, index) =>
      itemToAnalyticsItem({ ...item, coupon }, index)
    )}
  />
);
```

### General Pattern

For UI elements with dual purpose (data display + action trigger), don't let data loading block the action:

```typescript
// BAD — loading blocks everything
<button disabled={isLoading} onClick={openDrawer}>

// GOOD — loading only affects display, button always works
<button onClick={openDrawer}>
  {isLoading ? <CartIcon count={0} /> : <CartIcon count={items.length} />}
</button>
```

---

## 13. Server Functions for VTEX Actions

### Problem

In Fresh/Deno, VTEX API calls (newsletter signup, MasterData writes, shipping simulation) happened server-side via form actions or inline `fetch()`. In TanStack Start on Cloudflare Workers, client-side `fetch()` to VTEX APIs hits CORS issues, and form actions cause full reloads.

### Solution — `createServerFn`

```typescript
// src/lib/vtex-actions-server.ts
import { createServerFn } from "@tanstack/react-start";

export const createDocument = createServerFn({ method: "POST" })
  .handler(async (ctx) => {
    const { entity, dataForm } = ctx.data;
    const resp = await fetch(
      `https://${ACCOUNT}.vtexcommercestable.com.br/api/dataentities/${entity}/documents`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "VtexIdclientAutCookie": VTEX_AUTH_TOKEN,
        },
        body: JSON.stringify(dataForm),
      }
    );
    if (!resp.ok) throw new Error(`VTEX ${resp.status}`);
    return resp.json();
  });

export const simulateShipping = createServerFn({ method: "POST" })
  .handler(async (ctx) => {
    const { items, postalCode, country } = ctx.data;
    const resp = await fetch(
      `https://${ACCOUNT}.vtexcommercestable.com.br/api/checkout/pub/orderForms/simulation`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, postalCode, country }),
      }
    );
    return resp.json();
  });
```

### Pattern: Every VTEX Write Must Be a Server Function

| Operation | Server Function | Why |
|-----------|----------------|-----|
| Newsletter signup | `createDocument` | MasterData write needs auth |
| Shipping simulation | `simulateShipping` | CORS on checkout API |
| Cart add/remove | `addItems` / `updateItems` | Already in `useCart` |
| Coupon apply | `addCouponsToCart` | OrderForm mutation |

---

## 14. DOM Manipulation Conflicts with React

### Problem

Fresh-era components use `document.querySelector` and `element.checked = true` to control UI, bypassing React's rendering:

```typescript
// BAD — React doesn't know about this state change
const cartCheckbox = document.querySelector('.drawer-end .drawer-toggle');
if (cartCheckbox) cartCheckbox.checked = true;
```

### Fix — Use Signals/State

```typescript
import { useUI } from "~/sdk/useUI";
const { displayCart } = useUI();
displayCart.value = true;
```

### Discovery Command

```bash
rg 'document\.(querySelector|getElementById)' src/components/ --glob '*.{tsx,ts}' -l
rg '\.checked\s*=' src/components/ --glob '*.{tsx,ts}'
rg '\.classList\.(add|remove|toggle)' src/components/ --glob '*.{tsx,ts}'
```

### Acceptable DOM Manipulation

- **Analytics scripts**: Fire-and-forget `addEventListener` for click tracking
- **Third-party library init**: `Autodesk.Viewing.Initializer` in `useEffect`
- **Scroll operations**: `element.scrollTo()`, `element.scrollIntoView()`
- **Focus management**: `element.focus()`, `element.blur()`

---

## 15. TypeScript Patterns Post-Migration

### `productId` Type Coercion

VTEX loaders return `productID` as `string | undefined`. Cart APIs require `string`:

```typescript
const id = product.productID ?? "";
```

### Explicit Typing for Nullable Values

```typescript
// PROBLEM: TypeScript infers 'null'
let noInterestValue = null;

// FIX: explicit typing
let noInterestValue: string | null = null;
```

### `React.MouseEvent` vs `MouseEvent`

```typescript
// BEFORE (native DOM)
onClick={(e: MouseEvent) => { ... }}

// AFTER (React)
onClick={(e: React.MouseEvent<HTMLButtonElement>) => { ... }}
```

---

## 16. Loader `cache` / `cacheKey` Module Exports

### Problem

In `deco-cx/apps`, loaders declare their caching policy as module exports:

```typescript
// deco-cx/apps pattern
export const cache = "stale-while-revalidate";
export const cacheKey = (props, req, ctx) =>
  JSON.stringify(props) + `:sc=${ctx.salesChannel}`;
export default async function myLoader(props) { ... }
```

`@decocms/start`'s `createCachedLoader` previously only accepted inline options.

### Solution — `createCachedLoaderFromModule`

New utility in `@decocms/start/sdk/cachedLoader`:

```typescript
import { createCachedLoaderFromModule, type LoaderModule } from "@decocms/start/sdk/cachedLoader";

// Import the loader module (not just the default export)
import * as myLoaderModule from "./loaders/myLoader";

const cached = createCachedLoaderFromModule("myLoader", myLoaderModule, {
  policy: "stale-while-revalidate",
  maxAge: 60_000, // fallback if module doesn't declare cache
});
```

### `LoaderModule` Interface

```typescript
interface LoaderModule<TProps = any, TResult = any> {
  default: (props: TProps) => Promise<TResult>;
  cache?: CachePolicy | { maxAge: number };
  cacheKey?: (props: TProps) => string | null;
}
```

### Priority

1. Module `cache` export overrides the defaults `policy`
2. Module `cacheKey` export overrides the default `keyFn`
3. If module has `cache: { maxAge: 120_000 }`, policy is automatically `stale-while-revalidate` with that TTL
4. If `cacheKey` returns `null`, falls back to `JSON.stringify(props)`

### When to Use

- Porting loaders from `deco-cx/apps` that already have `export const cache = ...`
- Creating new loaders that need custom cache keys (e.g., segment-aware caching)
- When different instances of the same loader type need different cache policies

---

## 17. Multi-Layer VTEX Cache Architecture

### Current Cache Stack (as of March 2026)

```
┌─────────────────────────────────────────────────────────┐
│  Cloudflare Edge Cache (workerEntry.ts)                 │
│  Profile-based: 1min (search) → 1 day (static)         │
├─────────────────────────────────────────────────────────┤
│  TanStack Router staleTime (client)                     │
│  Profile-based: 60s (search) → 5min (product/static)   │
├─────────────────────────────────────────────────────────┤
│  Layout Resolution Cache (resolve.ts)                   │
│  5 min TTL — full CMS section output                    │
├─────────────────────────────────────────────────────────┤
│  Layout Section Loader Cache (sectionLoaders.ts)        │
│  5 min TTL — section loader enrichment                  │
├─────────────────────────────────────────────────────────┤
│  createCachedLoader SWR (cachedLoader.ts)               │
│  30-120s TTL per loader — commerce data                 │
├─────────────────────────────────────────────────────────┤
│  vtexCachedFetch / fetchWithCache (fetchCache.ts)       │
│  3 min TTL — raw HTTP JSON responses, LRU 500           │
├─────────────────────────────────────────────────────────┤
│  In-flight dedup (all layers)                           │
│  Concurrent calls share same Promise                    │
└─────────────────────────────────────────────────────────┘
```

### Key Insight

Each layer serves a different purpose:
- **Edge cache**: Avoids hitting the Worker at all
- **Router staleTime**: Avoids client→server roundtrip
- **Layout caches**: Avoids re-resolving Header/Footer sections
- **Loader SWR**: Avoids re-running commerce data transformations
- **Fetch SWR**: Avoids re-hitting VTEX APIs
- **Inflight dedup**: Avoids duplicate concurrent requests at any layer

The layers are **complementary**, not redundant. A request might hit the loader cache (miss, 60s expired) but still get a fetch cache hit (3 min fresh).

---

## 18. Setup Import Order in `server.ts`

### Problem

When navigating client-side (SPA), TanStack Start calls `loadCmsPage` as a server function. If `./setup` isn't imported before `createStartHandler`, the section registry, block data, and VTEX loaders are empty when the server function runs — resulting in a 404 or blank page on client navigation even though SSR works fine.

### Fix

```typescript
// server.ts — import setup FIRST, before createStartHandler
import "./setup";
import { createStartHandler, defaultStreamingHandler } from "@tanstack/react-start/server";
import { getRouterManifest } from "@tanstack/react-start/router-manifest";
import { createRouter } from "./router";

export default createStartHandler({
  createRouter,
  getRouterManifest,
})(defaultStreamingHandler);
```

### Why

TanStack Start compiles `createServerFn()` into split modules with isolated Vite instances. Module-level state from `setup.ts` (section registry, blocks, commerce loaders) doesn't persist across the split unless explicitly initialized before the handler is created.

---

## 19. globalThis Backing for Module-Level State

### Problem

TanStack Start compiles `createServerFn()` calls into "split modules" — each server function runs in a separate Vite module instance. Module-level `let` or `const` variables (`blockData`, `commerceLoaders`, `registry`, etc.) start empty in each RPC call because they're declared in a different instance than the one that ran `setup.ts`.

### Symptom

- Sections render fine on first SSR load
- On client navigation (TanStack Router), pages return empty or 404
- `blockData` is empty, loaders return `undefined`

### Fix — Back State with `globalThis.__deco`

All singleton module-level state in `@decocms/start` is backed by `globalThis.__deco`:

```typescript
// src/cms/loader.ts
declare global { var __deco: { blockData?: ...; revision?: string; ... } }
if (!globalThis.__deco) globalThis.__deco = {};

let _blockData: BlockData = globalThis.__deco.blockData ?? {};
export function setBlocks(data: BlockData) {
  globalThis.__deco.blockData = data;
  _blockData = data;
}
```

Files affected:

| File | State backed by globalThis |
|------|---------------------------|
| `cms/loader.ts` | `blockData`, `revision` |
| `cms/resolve.ts` | `commerceLoaders`, `customMatchers`, `initCallback`, `initialized`, `asyncConfig` |
| `cms/registry.ts` | `registry`, `sectionOptions` |
| `cms/sectionLoaders.ts` | `loaderRegistry` (Map), `layoutSections` (Set) |

---

## 20. Async Rendering / Deferred Sections

### Architecture

`setAsyncRenderingConfig()` controls which sections are rendered synchronously (eager) vs deferred via `IntersectionObserver`:

```typescript
// setup.ts
import { setAsyncRenderingConfig } from "@decocms/start";

setAsyncRenderingConfig({
  respectCmsLazy: true,     // honor Lazy wrapper in CMS config
  foldThreshold: 2,         // first N sections always eager
  alwaysEager: [            // specific sections always eager (by __resolveType)
    "site/sections/Header.tsx",
    "site/sections/Footer.tsx",
  ],
});
```

### How `shouldDeferSection()` Works

| Condition | Result |
|-----------|--------|
| Section has `Lazy` wrapper in CMS | Deferred (if `respectCmsLazy: true`) |
| Section is in `alwaysEager` list | Always eager |
| Section is a layout section (Header/Footer) | Always eager |
| Section index < `foldThreshold` | Eager |
| Request is from a bot (UA detection) | All sections eager |

### `loadDeferredSection` — POST not GET

The server function uses `POST` (not `GET`) because section props (images, text, arrays) serialized as query params exceed the 431 "Request Header Fields Too Large" limit.

```typescript
// cmsRoute.ts
export const loadDeferredSection = createServerFn({ method: "POST" })
  .handler(async (ctx) => {
    const { data } = ctx;
    return resolveDeferredSection(data);
  });
```

### `DeferredSectionWrapper` in `DecoPageRenderer.tsx`

Uses `IntersectionObserver` with `rootMargin: "300px"` to load sections before they enter the viewport:

```typescript
function DeferredSectionWrapper({ deferred, loadDeferredSectionFn }) {
  const ref = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          loadDeferredSectionFn(deferred).then(setSection);
        }
      },
      { rootMargin: "300px" }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return section
    ? <SectionRenderer section={section} />
    : <div ref={ref} style={{ minHeight: "1px" }} />;
}
```

---

## 21. Section Ordering Fix — Index Stamping

### Problem (v0.16.3 → v0.16.4)

`mergeSections()` (which interleaves eager + deferred sections for rendering) used slot-filling — trying to fill deferred "slots" by index into the original CMS array. When multiple eager sections resolved from a single CMS entry (e.g., a shelf with 0 products), the slot indices diverged and sections rendered out of order or disappeared.

### Root Cause

The original design assumed: 1 CMS entry → 1 rendered section. In practice, loaders can return multiple or zero sections.

### Fix — Stamp `index` on Each Eager Section

In `resolve.ts`, after running section loaders, stamp each resolved section with its original CMS position:

```typescript
// Each resolved eager section gets its original flat CMS index
for (const eagerly of eagerSections) {
  eagerly.then((s) => {
    if (s) s.index = currentFlatIndex;
  });
  currentFlatIndex++;
}
```

In `mergeSections()`, sort by `index` instead of slot-filling:

```typescript
function mergeSections(
  sections: ResolvedSection[],
  deferredSections: DeferredSection[]
): Array<{ type: "resolved"; section: ResolvedSection } | { type: "deferred"; deferred: DeferredSection }> {
  const all = [
    ...sections.map(s => ({ type: "resolved" as const, index: s.index ?? 0, section: s })),
    ...deferredSections.map(d => ({ type: "deferred" as const, index: d.index, deferred: d })),
  ];
  return all.sort((a, b) => a.index - b.index);
}
```

---

## 22. Layout Section Caching

### Problem

Header and Footer re-execute their full commerce loaders (navigation menu, cart, promotions) on every page navigation. These sections are identical across all pages but were resolved fresh each time.

### Solution — `resolvedLayoutCache`

In `resolve.ts`, layout sections (registered via `registerLayoutSection()`) are cached for 5 minutes:

```typescript
const resolvedLayoutCache = new Map<string, { result: ResolvedSection; timestamp: number }>();
const LAYOUT_CACHE_TTL = 5 * 60 * 1000; // 5 min

async function resolveLayoutSection(key: string, ...): Promise<ResolvedSection> {
  const cached = resolvedLayoutCache.get(key);
  if (cached && Date.now() - cached.timestamp < LAYOUT_CACHE_TTL) {
    return cached.result;
  }
  const result = await resolveSection(key, ...);
  resolvedLayoutCache.set(key, { result, timestamp: Date.now() });
  return result;
}
```

### Registration

```typescript
// setup.ts
import { registerLayoutSection } from "@decocms/start";
registerLayoutSection("site/sections/Header.tsx");
registerLayoutSection("site/sections/Footer.tsx");
```

---

## 23. Analytics Hydration Mismatch Fix

### Problem

`Analytics.tsx` used `useScriptAsDataURI` which converts a function to a string via `fn.toString()`. The string representation differs between server-side and client-side bundles (minification, whitespace), causing a hydration mismatch and CLS.

### Fix

Replace with `useScript` + `dangerouslySetInnerHTML` + `suppressHydrationWarning`:

```typescript
// BEFORE — causes hydration mismatch
const src = useScriptAsDataURI(sendAnalytics, { endpoint: "/analytics" });
return <script async src={src} />;

// AFTER — suppresses hydration comparison for this element
function Analytics({ endpoint }: Props) {
  const script = useScript(sendAnalytics, { endpoint });
  return (
    <script
      dangerouslySetInnerHTML={{ __html: script }}
      suppressHydrationWarning
    />
  );
}
```

---

## 24. Vite Config for Published `@decocms/start` Packages

### Problem

When `@decocms/start` is a published npm package (not `file:` reference), three issues emerge:

1. **`React is not defined` in SSR deps**: The esbuild pre-bundler uses the classic JSX runtime by default — `React.createElement(...)` without importing React.
2. **`tanstack-start-injected-head-scripts:v` in client bundle**: `router-manifest.js` (from `@tanstack/start-server-core`) ends up in the client bundle via import chain. This virtual module is registered only in the SSR environment.
3. **Module deduplication**: Without `resolve.dedupe`, Vite may resolve multiple instances of TanStack packages.

### Required `vite.config.ts`

```typescript
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({ server: { entry: "server" } }),
    react({ babel: { plugins: [["babel-plugin-react-compiler", { target: "19" }]] } }),
    tailwindcss(),

    // Fix #2: register no-op fallback for the server-only virtual module
    // in the client environment
    {
      name: "deco-tanstack-client-virtual-fallback",
      enforce: "post",
      resolveId(id) {
        if (id === "tanstack-start-injected-head-scripts:v") return `\0${id}`;
      },
      load(id) {
        if (id === "\0tanstack-start-injected-head-scripts:v")
          return "export const injectedHeadScripts = undefined;";
      },
    },
  ],
  optimizeDeps: {
    // Fix #1: use automatic JSX runtime so esbuild adds react/jsx-runtime
    // imports when pre-bundling @decocms/start source files
    esbuildOptions: { jsx: "automatic" },
  },
  resolve: {
    // Fix #3: force single instance for TanStack packages
    dedupe: [
      "@tanstack/react-start",
      "@tanstack/react-router",
      "@tanstack/react-start-server",
      "@tanstack/start-server-core",
      "@tanstack/start-client-core",
      "@tanstack/start-plugin-core",
      "@tanstack/start-storage-context",
      "react",
      "react-dom",
    ],
  },
});
```

### Root Causes

- **Fix #1 (`esbuildOptions.jsx: "automatic"`)**: `@decocms/start` ships raw `.tsx` source. Vite's esbuild pre-bundler uses the classic transform by default. `jsx: "automatic"` makes it emit `import { jsx } from "react/jsx-runtime"` instead of `React.createElement`.
- **Fix #2 (virtual module fallback)**: The import chain `cmsRoute.ts → @tanstack/react-start → @tanstack/start-server-core → router-manifest.js` reaches the client bundle. The `tanstack-start-injected-head-scripts:v` virtual is registered with `applyToEnvironment: server` only.
- **Fix #3 (dedupe)**: Prevents duplicate TanStack instances when hoisting from peer deps.
