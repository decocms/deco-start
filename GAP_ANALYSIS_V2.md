# deco-cx/deco vs @decocms/start -- Second-Pass Gap Analysis

> Deep audit of `deco-cx/deco` + `deco-cx/apps` vs `@decocms/start` + `@decocms/apps`.
> Covers architecture decisions, commerce gaps, SEO, schema/admin, and utilities.
> Each gap includes proposed solutions, trade-offs, and a recommendation.
>
> Last updated: March 6, 2026 (Tier 0 + Tier 1 + Tier 2 implemented)

---

## Table of Contents

- [Part 1 -- Architecture Decisions](#part-1----architecture-decisions)
  - [A. Section Data Ownership](#a-section-data-ownership)
  - [B. Partial Section Re-rendering](#b-partial-section-re-rendering)
  - [C. Vary / Segment / CDN Cache Coherence](#c-vary--segment--cdn-cache-coherence)
  - [D. RequestContext via AsyncLocalStorage](#d-requestcontext-via-asynclocalstorage)
- [Part 2 -- Commerce Platform Gaps](#part-2----commerce-platform-gaps)
  - [E. VTEX Middleware](#e-vtex-middleware)
  - [F. VTEX Proxy Routes](#f-vtex-proxy-routes)
  - [G. Product Extension Pipeline](#g-product-extension-pipeline)
  - [H. Missing VTEX Loaders/Actions](#h-missing-vtex-loadersactions)
  - [I. Missing Shopify Capabilities](#i-missing-shopify-capabilities)
- [Part 3 -- SEO / Infrastructure](#part-3----seo--infrastructure)
  - [J. Sitemap Generation](#j-sitemap-generation)
  - [K. Redirect System](#k-redirect-system)
  - [L. SEO Components / JSON-LD](#l-seo-components--json-ld)
  - [M. Deferred / Lazy Section Rendering](#m-deferred--lazy-section-rendering)
- [Part 4 -- Schema / Admin](#part-4----schema--admin)
  - [N. Schema Generation Improvements](#n-schema-generation-improvements)
  - [O. Admin Live Preview / Hot Reload](#o-admin-live-preview--hot-reload)
- [Part 5 -- Components / Utilities](#part-5----components--utilities)
  - [P. Optimized Media Components](#p-optimized-media-components)
  - [Q. Client-side State Hooks](#q-client-side-state-hooks)
  - [R. Missing Matchers](#r-missing-matchers)
  - [S. Minor Utilities](#s-minor-utilities)
- [Part 6 -- Prioritized Roadmap](#part-6----prioritized-roadmap)

---

## Part 1 -- Architecture Decisions

These are the structural questions that affect everything else.

---

### A. Section Data Ownership

**The question:** Should sections own their data fetching (deco model), or should loaders be wired externally (current model)?

#### How deco does it

In `deco-cx/deco`, a section file can export three things:

```typescript
// blocks/section.ts lifecycle
export const loader = (props, req, ctx) => fetchProducts(props);
export const action = (props, req, ctx) => updateCart(props);
export default function MySection(loaderResult) { /* render */ }
```

The block system dispatches by HTTP method: `GET` calls `loader`, non-GET calls `action`. It also supports **object-shaped loaders** where each key resolves independently and concurrently:

```typescript
export const loader = {
  products: (props, req, ctx) => fetchProducts(props),
  banners: (props, req, ctx) => fetchBanners(props),
};
```

#### How we do it today

Sections are pure React components. Data fetching is wired externally in `setup.ts` via `registerCommerceLoaders()`. The CMS decofile embeds `__resolveType` references inside section props, and `resolveDecoPage()` walks the tree, detects these references, calls the registered loader, and replaces the block with actual data before the component ever sees it.

```
[CMS decofile]                    [setup.ts]                     [resolveDecoPage]
Section props with                Commerce loaders               Walks the tree,
__resolveType: "vtex/..."  --->   registered by key       --->   calls loaders,
                                                                  returns resolved props
                                                                        |
                                                                        v
                                                                  [React Component]
                                                                  Receives plain data
```

#### Do variants need section loaders?

**No.** Looking at the actual decofile (`pages-home-*.json`), the `sections` array is wrapped in `website/flags/multivariate.ts`. Variants swap entire section arrays, including their `__resolveType` references. The resolver picks the winning variant first, then resolves the nested loaders. Both models support variant-driven data changes equally.

Where deco's section loaders add value our model lacks:

1. **Server-side prop enrichment** -- A section receives CMS props and needs to transform them before render (e.g., take a `collectionId` and call an API). In our model, this requires registering a commerce loader in `setup.ts`.
2. **Colocation** -- The data fetching logic lives with the component, making the section portable across sites.
3. **Request context access** -- Deco's section loader receives `(props, req, ctx)`, so it can vary behavior based on cookies, headers, URL. Our commerce loaders only receive props.

#### Trade-offs

| | External wiring (current) | Section loaders (deco) | Hybrid |
|---|---|---|---|
| **React idiomatic** | Yes -- sections are pure components | No -- sections become more than components | Partial |
| **TanStack compatible** | Fully -- works with route loaders | Against the grain | Coexists awkwardly |
| **Portability** | Low -- needs setup.ts per site | High -- self-contained | Medium |
| **Request context** | Not passed to loaders today | Full access (req, cookies, headers) | Optional |
| **Testing** | Easy -- pure components, loaders separate | Harder -- component+loader coupled | Easy for pure sections |
| **CMS flexibility** | CMS controls which loader (`__resolveType`) | Section controls how data is fetched | Both |
| **Optimization** | Route-level can batch across sections | Per-section, harder to deduplicate | Route-level + optional per-section |
| **Complexity** | Simple mental model | Requires section-aware SSR pipeline | Two ways to do things |

#### Recommendation

**Keep external wiring** as the primary model -- it's idiomatic React/TanStack and already working. But address the two real gaps:

1. **Pass request context to commerce loaders.** Change `CommerceLoader` signature from `(props) => Promise<any>` to `(props, ctx?: RequestContext) => Promise<any>`. This gives loaders access to cookies, headers, URL without changing the architecture.

2. **Add a `sectionMiddleware` optional pattern.** Sections can export a `transformProps` function that runs server-side before render. This covers the enrichment use case without the full section loader lifecycle:

```typescript
// Optional: section can export this
export function transformProps(props: Props): Props {
  return { ...props, computedField: derive(props.someValue) };
}
// Required: the component
export default function MySection(props: Props) { /* render */ }
```

The resolver would check for `transformProps` in the section registry and apply it during resolution. Light-touch, no new pipeline needed.

---

### B. Partial Section Re-rendering

**The question:** `useSection()` and `usePartialSection()` are stubs. How should we enable section-level updates without full page navigation?

#### What deco does

`useSection({ props, href })` builds a URL to `/deco/render?props=...&href=...&pathTemplate=...&renderSalt=...&__cb=...`. The `__cb` parameter is a Murmurhash cache-bust key derived from `[revisionId, vary, stableHref, deploymentId]`. It strips 20+ marketing UTM params from URLs for cache stability (fbclid, gclid, utm_*, etc.).

`usePartialSection()` wraps this and returns `hx-get`/`f-partial` attributes for Fresh/HTMX partial navigation. The response is server-rendered HTML that gets swapped into the DOM.

This powers: infinite scroll, load-more buttons, filter changes, tab content loading, and any interaction that refreshes a single section.

#### Options in our stack

**Option 1: Client-side re-fetching via TanStack Query + invoke**

```
User interaction -> TanStack Query refetch -> POST /deco/invoke/:key -> JSON -> React re-render
```

- **Pros:** Idiomatic React. Works today. TanStack Query handles SWR, dedup, background refetch. Integrates with `invokeQueryOptions()` we already built.
- **Cons:** Requires client-side JS for the section. Initial render is SSR, updates are client-side. Bundle size increases per interactive section. The section must be a client component (or at least have a client wrapper).
- **Complexity:** Low -- we already have the invoke proxy.
- **Best for:** Cart updates, wishlist toggles, autocomplete, any section with frequent client interaction.

**Option 2: Server-rendered HTML swap (HTMX-style)**

```
User interaction -> fetch("/deco/render?section=X&props=...") -> HTML -> innerHTML swap
```

- **Pros:** Zero client JS for the section content. True SSR. CDN-cacheable. Matches deco's model.
- **Cons:** DOM manipulation outside React's control. Breaks React's reconciliation. State management is awkward (the swapped-in HTML doesn't have React hydration). Need a custom `<PartialSection>` wrapper.
- **Complexity:** Medium -- need to build the URL construction, param stripping, and DOM swap logic.
- **Best for:** Infinite scroll, load-more, content that doesn't need client-side interactivity after swap.

**Option 3: Route-level navigation with TanStack Router SWR**

```
User interaction -> router.navigate({ search: { page: 2 } }) -> full page re-render with SWR
```

- **Pros:** Simplest. Fully server-rendered. URL reflects state (bookmarkable, shareable). TanStack Router's SWR makes it fast (stale page shows immediately, fresh data streams in).
- **Cons:** Full page re-render (even if fast). URL changes on every interaction. Not suitable for infinite scroll within a section.
- **Complexity:** Near-zero -- just use TanStack Router.
- **Best for:** Filter changes, pagination, sort order -- anything where URL state makes sense.

**Option 4: React Server Components (future)**

```
User interaction -> Server re-renders component -> Streamed RSC payload -> React reconciles
```

- **Pros:** True server-side re-rendering with proper React reconciliation. No client JS for the section. No DOM manipulation hacks.
- **Cons:** TanStack Start doesn't support RSC yet (experimental). Not available today.
- **Complexity:** N/A until available.
- **Best for:** Everything, once it works.

#### Recommendation

**Use Options 1 + 3 together, skip Option 2.** Here's why:

- **Option 3 (router navigation)** for filter changes, pagination, sort -- anywhere URL state makes sense. This is free with TanStack Router.
- **Option 1 (TanStack Query + invoke)** for cart, wishlist, autocomplete, load-more -- anywhere you need section-level updates without URL changes.

Option 2 (HTML swap) is a dead end in a React architecture. It fights React's reconciliation model and creates hydration problems. It only makes sense in an HTMX/Fresh world.

Deprecate the stub `usePartialSection()` and instead provide:
- `useSectionQuery(loaderKey, props, options?)` -- returns a TanStack Query hook for client-side section data
- Document the pattern of using TanStack Router search params for server-side section re-rendering

---

### C. Vary / Segment / CDN Cache Coherence

**The question:** Do we need deco's custom Vary/Segment system, or does Cloudflare Cache API + our `workerEntry.ts` cover it?

#### What deco does

Two-layer system:

1. **Vary system:** Each loader pushes its cache-relevant dimensions into a `Vary` object during rendering. Example: a loader that reads a cookie pushes `"cookie:myKey"`. The aggregate of all pushed keys becomes the cache differentiation key. If a loader sets `shouldCache = false`, the entire page becomes uncacheable.

2. **`segmentFor()`:** Computes a Murmurhash3 fingerprint from `sorted cookies + sorted flags + deploymentId + revision + URL`. Two users with identical fingerprints get the same CDN response. This is the cohort/segment hash.

Together, these ensure: anonymous users share cached pages, logged-in users get personalized (uncached) pages, and A/B test cohorts get their own cached variants.

#### What we have today

`workerEntry.ts` uses Cloudflare's Cache API with:
- Device-specific cache keys (`__cf_device=mobile|desktop`)
- Profile-based cache headers (`static`, `product`, `listing`, `search`, `cart`, `private`, `none`)
- `detectCacheProfile(url)` based on URL patterns
- Cache purge endpoint

This handles the simple case (anonymous vs. device), but doesn't differentiate by:
- Login state (logged-in users see personalized prices)
- A/B test cohort
- Sales channel / segment
- Cookies that affect content

#### Solution: Segment-aware cache keys

Instead of porting deco's full Vary system (which is tightly coupled to their resolver), build a lighter-weight segment key that integrates with Cloudflare's Cache API:

```typescript
interface SegmentKey {
  device: "mobile" | "desktop";
  loggedIn: boolean;
  salesChannel?: string;
  flags: string[];  // sorted active flag names
}

function buildCacheKey(request: Request, segment: SegmentKey): Request {
  const url = new URL(request.url);
  url.searchParams.set("__seg", hashSegment(segment));
  return new Request(url.toString(), { method: "GET" });
}
```

**Where this runs:** In `workerEntry.ts`, before the Cache API lookup. The segment is derived from cookies (VTEX segment cookie, auth token presence) and evaluated flags.

**Trade-offs:**

| | Full Vary system (deco) | Segment cache key (proposed) |
|---|---|---|
| **Granularity** | Per-loader, any dimension | Per-request, predefined dimensions |
| **Complexity** | High -- every loader participates | Low -- computed once at the edge |
| **Cache hit rate** | Optimal -- minimal differentiation | Good -- slightly over-differentiated |
| **Coupling** | Tightly coupled to resolver | Decoupled -- runs at Worker level |
| **Implementation** | ~400 LOC across utils/vary.ts + segment.ts + loaders | ~100 LOC in workerEntry.ts |

**Recommendation:** Build the segment cache key approach. It covers the 90% case (login state, device, sales channel, A/B cohort) without the complexity of per-loader Vary. If we later need per-loader granularity, the segment system can be extended.

---

### D. RequestContext via AsyncLocalStorage

**The question:** Should we implement implicit per-request context like deco does?

#### What deco does

`RequestContext` uses `AsyncLocalStorage` (from `node:async_hooks`) to bind per-request state:

- **Automatic fetch cancellation:** Global `fetch` is monkey-patched to inject the request's `AbortSignal`. When a client disconnects, all in-flight fetches for that request abort automatically.
- **Implicit context access:** Any code in the call stack can call `RequestContext.signal`, `RequestContext.framework`, or `Context.active()` without prop drilling.
- **Context binding:** `RequestContext.bind(request, fn)` runs a function within a specific request's context.

#### Feasibility on Cloudflare Workers

`nodejs_compat` is already enabled in `wrangler.jsonc`. `AsyncLocalStorage` works on Workers with this flag. So this is technically feasible.

#### What it buys us

1. **Automatic fetch abort** -- The biggest win. If a user navigates away mid-request, all VTEX/Shopify API calls for that request abort. Without this, abandoned requests keep running and consuming resources.
2. **No prop drilling for request context** -- Loaders, utilities, and middleware can access the request without it being passed through every function signature.
3. **Foundation for richer FnContext** -- Once we have implicit request context, we can build lazy `device`, `isBot`, `flags` accessors like deco does.

#### Trade-offs

| | AsyncLocalStorage | Explicit context passing |
|---|---|---|
| **Ergonomics** | Implicit -- any function can access | Explicit -- must thread through params |
| **Debuggability** | Harder -- invisible data flow | Easier -- data flow is visible |
| **Performance** | Slight overhead per request | Zero overhead |
| **Testing** | Must mock the global context | Just pass different params |
| **Global fetch patch** | Powerful but surprising (monkey-patch) | No surprises |
| **CF Workers compat** | Works with `nodejs_compat` | Always works |

#### Recommendation

**Implement it, but conservatively:**

1. Create `RequestContext` with `AsyncLocalStorage` -- bind it in middleware, expose `.signal` and `.request` getters.
2. **Do NOT monkey-patch global fetch.** Instead, expose `RequestContext.fetch` as an alternative that auto-injects the abort signal. Let code opt in.
3. Use it in the commerce loader pipeline: `resolveDecoPage` binds the context, commerce loaders can access it.

This gives us automatic cancellation where it matters (commerce loaders making VTEX calls) without the surprise of a global monkey-patch.

---

## Part 2 -- Commerce Platform Gaps

These are concrete, actionable gaps in the commerce layer.

---

### E. VTEX Middleware -- DONE

**What's missing:** `vtex/middleware.ts` from `deco-cx/apps` does three critical things:

1. **Segment extraction** -- Reads the VTEX segment cookie, decodes it, extracts sales channel, price tables, region ID, and trade policy. This determines which prices and products a user sees.
2. **IS cookie propagation** -- Propagates Intelligent Search cookies (`vtex_is_*`) for search personalization and analytics.
3. **Login-aware cache control** -- Detects if a user is logged in (via `VtexIdclientAutCookie`). Logged-in users get `Cache-Control: private` to prevent personalized content from being cached and served to others.

**Impact without it:**
- Anonymous and logged-in users may share cached pages (wrong prices, wrong wishlists)
- B2B customers on different price tables see retail prices
- IS search quality degrades without cookie propagation

**Proposed solution:**

Create `apps-start/vtex/middleware.ts`:

```typescript
export interface VtexSegment {
  salesChannel: string;
  priceTables?: string[];
  regionId?: string;
  tradePolicy?: string;
  isLoggedIn: boolean;
}

export function extractVtexSegment(request: Request): VtexSegment { /* ... */ }
export function vtexCacheControl(segment: VtexSegment): string { /* ... */ }
export function propagateISCookies(request: Request, response: Response): void { /* ... */ }
```

This integrates with TanStack Start's `createMiddleware()` in the storefront. The segment feeds into the cache key system (Part 1, Section C).

**Location:** `apps-start/vtex/middleware.ts`
**Effort:** ~150 LOC
**Dependencies:** `vtexId.ts` for JWT parsing (Section E.1)

#### E.1 vtexId JWT parsing

We also need `vtexId.ts` to parse `VtexIdclientAutCookie` without calling VTEX APIs. This is a JWT decode (no verification needed since we're just checking presence and expiry, not authenticating).

```typescript
export function parseVtexAuthCookie(cookie: string): { isLoggedIn: boolean; email?: string; exp?: number } { /* ... */ }
```

**Location:** `apps-start/vtex/utils/vtexId.ts`
**Effort:** ~50 LOC

---

### F. VTEX Proxy Routes -- DONE

**What's missing:** VTEX checkout, My Account, and API calls require proxying to VTEX's servers. The storefront must route these paths to VTEX origin:

| Path | Purpose |
|------|---------|
| `/checkout/*` | VTEX checkout pages |
| `/account/*`, `/account` | My Account pages |
| `/api/*` | VTEX API (orderForm, session, etc.) |
| `/files/*`, `/arquivos/*` | VTEX static files (invoices, receipts) |
| `/checkout/changeToAnonymousUser/*` | Logout from checkout |

**Impact without it:** Checkout and My Account don't work. Cart operations fail because `/api/checkout/pub/orderForm/*` is unreachable.

**Proposed solution:**

Create `apps-start/vtex/utils/proxy.ts`:

```typescript
export interface VtexProxyConfig {
  account: string;
  environment?: "vtexcommercestable" | "vtexcommercebeta";
  extraPaths?: string[];
}

export function getVtexProxyPaths(config: VtexProxyConfig): string[] { /* ... */ }

export async function proxyToVtex(
  request: Request,
  config: VtexProxyConfig,
): Promise<Response> { /* ... */ }
```

The storefront registers these as TanStack Start API routes:

```typescript
// src/routes/api/vtex-proxy.ts (storefront)
import { createAPIFileRoute } from "@tanstack/react-start/api";
import { proxyToVtex } from "@decocms/apps/vtex/utils/proxy";

export const APIRoute = createAPIFileRoute("/api/$")({
  GET: async ({ request }) => proxyToVtex(request, vtexConfig),
  POST: async ({ request }) => proxyToVtex(request, vtexConfig),
});
```

**Cloudflare Workers consideration:** Workers have a 100MB response body limit and no streaming for subrequest bodies in some cases. For large file downloads (`/files/*`), we may need to use `Response.redirect()` to VTEX origin instead of proxying the body.

**Location:** `apps-start/vtex/utils/proxy.ts`
**Effort:** ~200 LOC
**Dependencies:** VTEX client config (already exists)

---

### G. Product Extension Pipeline

**What's missing:** Deco has `vtex/loaders/product/extensions/*` -- a composable pipeline to enrich products after the initial fetch:

1. **Simulation extension** -- Calls VTEX's simulation API to get real-time prices (important for B2B, regional pricing, promotions)
2. **Wishlist extension** -- Checks which products are in the user's wishlist and adds `isInWishlist` to each product
3. **Details page extension** -- Enriches PDP products with additional data (related products, reviews, etc.)

Without this, our loaders return the raw VTEX response. Products may show stale prices (from the search index) rather than real-time prices.

**Proposed solution:**

Create a composable `enrichProducts()` pipeline in apps-start:

```typescript
type ProductEnricher = (
  products: Product[],
  ctx: { request: Request; segment?: VtexSegment },
) => Promise<Product[]>;

export function createProductPipeline(...enrichers: ProductEnricher[]): ProductEnricher {
  return async (products, ctx) => {
    let result = products;
    for (const enricher of enrichers) {
      result = await enricher(result, ctx);
    }
    return result;
  };
}

// Built-in enrichers
export const withSimulation: ProductEnricher = async (products, ctx) => { /* ... */ };
export const withWishlist: ProductEnricher = async (products, ctx) => { /* ... */ };
```

Storefronts compose their pipeline in `setup.ts`:

```typescript
const enrichProducts = createProductPipeline(withSimulation, withWishlist);
// Wire into commerce loaders
```

**Location:** `apps-start/vtex/utils/enrichment.ts` + `apps-start/vtex/enrichers/*.ts`
**Effort:** ~300 LOC
**Dependencies:** VTEX simulation API client, wishlist API (already in actions)

---

### H. Missing VTEX Loaders/Actions

Prioritized by commerce impact:

| Capability | Priority | Effort | Notes |
|-----------|----------|--------|-------|
| **Top searches** (`topsearches.ts`) | High | ~50 LOC | Autocomplete completeness. Simple IS API call. |
| **Search validator** (`productSearchValidator.ts`) | Medium | ~80 LOC | Validates search terms, redirects misspellings. |
| **Legacy brands** (`brands.ts`) | Medium | ~40 LOC | Brand listing pages. Simple catalog API call. |
| **Page type resolver** (`pageType.ts`) | Medium | ~60 LOC | URL to page type (product, category, brand, search). Already partially covered by our path matching. |
| **Order placed** (`orderplaced.ts`) | Medium | ~100 LOC | Thank-you page data (order summary, items, totals). |
| **Review submit** (`review/submit.ts`) | Low | ~60 LOC | Product review submission. |
| **Notify me** (`notifyme.ts`) | Low | ~50 LOC | Back-in-stock notification signup. |
| **MasterData search** (`searchDocuments.ts`) | Low | ~80 LOC | Query MasterData V2 documents. Already have create/update. |
| **Server-side analytics** (`sendEvent.ts`) | Low | ~100 LOC | Send analytics events from server. |
| **User sessions** (`getUserSessions.ts`) | Low | ~40 LOC | List active sessions. |
| **Payment token delete** | Low | ~30 LOC | Delete saved payment method. |

**Recommendation:** Implement top searches first (it's the most visible gap in the storefront). Then search validator + page type resolver (they improve SEO and search UX). The rest are feature-complete niceties.

---

### I. Missing Shopify Capabilities

| Capability | Priority | Effort | Notes |
|-----------|----------|--------|-------|
| **Draft order calculate** | Medium | ~100 LOC | B2B/wholesale pricing. Only needed for B2B stores. |
| **Password/digest cookies** | Medium | ~50 LOC | Storefront password protection (development stores). |
| **Config loader** | Low | ~30 LOC | Shop config (currencies, languages). |
| **Proxy routes** | Medium | ~80 LOC | `/apps/*`, `/tools/*` proxy to Shopify. Less critical than VTEX proxy. |
| **Sitemap handler** | Medium | ~80 LOC | Shopify-specific sitemap (see Section J). |

**Recommendation:** Draft order and proxy routes only if/when a Shopify storefront needs them. Password/digest cookies for dev stores.

---

## Part 3 -- SEO / Infrastructure

---

### J. Sitemap Generation -- DONE

**What's missing:** No sitemap.xml generation at all. Deco has three handlers:
- `website/handlers/sitemap.ts` -- Static routes from CMS pages
- `vtex/handlers/sitemap.ts` -- Pulls product/category URLs from VTEX's sitemap API
- `shopify/handlers/sitemap.ts` -- Pulls from Shopify's sitemap

**Impact:** Search engines can't discover all product/category pages. Major SEO penalty.

**Proposed solution:**

Two-part system:

1. **Static sitemap from CMS pages** -- Scan `.deco/blocks/pages-*.json` at build time, generate sitemap entries for all page paths. Goes into `@decocms/start`.

2. **Commerce sitemap from VTEX/Shopify** -- Runtime endpoint that fetches product/category URLs from the commerce platform API. Goes into `apps-start/vtex/utils/sitemap.ts` and `apps-start/shopify/utils/sitemap.ts`.

The storefront exposes a TanStack Start API route:

```typescript
// src/routes/sitemap[.]xml.ts (storefront)
export const APIRoute = createAPIFileRoute("/sitemap.xml")({
  GET: async () => {
    const cmsPages = getCMSPagePaths();
    const vtexPages = await getVtexSitemapUrls(vtexConfig);
    return new Response(generateSitemapXml([...cmsPages, ...vtexPages]), {
      headers: { "Content-Type": "application/xml" },
    });
  },
});
```

**Caching:** Sitemap should be cached aggressively (`s-maxage=3600`). Product URLs don't change frequently.

**Location:** `deco-start/src/sdk/sitemap.ts` + `apps-start/vtex/utils/sitemap.ts`
**Effort:** ~200 LOC total
**Dependencies:** CMS page loader, VTEX catalog API

---

### K. Redirect System -- DONE

**What's missing:** Deco has a full redirect pipeline:
- `website/loaders/redirect.ts` -- Single redirect definition in CMS
- `website/loaders/redirects.ts` -- Aggregates all redirect routes
- `website/loaders/redirectsFromCsv.ts` -- Bulk import from CSV file/URL
- `website/handlers/redirect.ts` -- HTTP redirect handler

Our `site.json` already defines `website/loaders/redirects.ts` in routes, but it's in `SKIP_RESOLVE_TYPES` and ignored.

**Impact:** Old URLs from platform migrations (Deco v1, other platforms) return 404 instead of redirecting. SEO link equity is lost.

**Proposed solution:**

1. **CMS-managed redirects** -- Read redirect blocks from `.deco/blocks/` at startup. Store in a `Map<string, { to: string; type: 301 | 302 }>`.

2. **CSV import** -- Utility to parse CSV files with `from,to,type` columns. Can be loaded from URL (for Google Sheets export) or local file.

3. **Middleware integration** -- Run redirect lookup in TanStack Start middleware, before route matching. Return `Response.redirect()` for matches.

```typescript
// @decocms/start/sdk/redirects.ts
export function loadRedirects(blocks: Record<string, any>): Map<string, Redirect> { /* ... */ }
export function matchRedirect(path: string, redirects: Map<string, Redirect>): Redirect | null { /* ... */ }
```

**Location:** `deco-start/src/sdk/redirects.ts`
**Effort:** ~150 LOC
**Dependencies:** CMS block loader (already exists)

---

### L. SEO Components / JSON-LD -- DONE

**What's missing:** Deco has:
- `commerce/sections/Seo/SeoPDPV2.tsx` -- JSON-LD structured data for product detail pages (Product schema, BreadcrumbList, offers, reviews)
- `commerce/sections/Seo/SeoPLPV2.tsx` -- JSON-LD for product listing pages (ItemList, CollectionPage)
- `website/components/Seo.tsx` -- General SEO meta tag injection
- `website/components/_seo/*` -- Social media preview cards (Open Graph, Twitter Cards, Discord, etc.)

These are in `SKIP_RESOLVE_TYPES` in our resolver, meaning the CMS has them but we don't render them.

**Impact:** Product pages lack structured data, reducing rich snippet visibility in search results (star ratings, price, availability).

**Proposed solution:**

Create SEO utility components in `deco-start` or `apps-start`:

```typescript
// apps-start/commerce/components/JsonLd.tsx
export function ProductJsonLd({ product }: { product: Product }) {
  const jsonld = productToJsonLd(product);
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonld) }} />;
}

export function PLPJsonLd({ page }: { page: ProductListingPage }) { /* ... */ }
export function BreadcrumbJsonLd({ breadcrumb }: { breadcrumb: BreadcrumbList }) { /* ... */ }
```

For meta tags, use TanStack Router's built-in `Meta` component via route `meta()` function:

```typescript
export const Route = createFileRoute("/product/$slug")({
  meta: ({ loaderData }) => [
    { title: loaderData.product.name },
    { name: "description", content: loaderData.product.description },
    { property: "og:title", content: loaderData.product.name },
    { property: "og:image", content: loaderData.product.image[0]?.url },
  ],
});
```

**Location:** `apps-start/commerce/components/` for JSON-LD, TanStack Router `meta()` for head tags
**Effort:** ~200 LOC
**Dependencies:** Commerce types (already exist)

---

### M. Deferred / Lazy Section Rendering

**What's missing:** Deco has two rendering optimization sections:

1. **`Rendering/Deferred.tsx`** -- Streams the section HTML after the initial page shell loads. Uses React Suspense on the server to defer heavy sections.
2. **`Rendering/Lazy.tsx`** -- Uses intersection observer (`hx-trigger="intersect once"`) to lazy-load sections when they scroll into view.

**What we have:** `DecoPageRenderer` already uses `React.Suspense` with `React.lazy()` for code splitting. But we don't have intersection-based lazy loading for below-the-fold content.

**Proposed solution:**

Create a `<LazySection>` wrapper that uses IntersectionObserver to defer rendering:

```tsx
export function LazySection({ children, fallback, rootMargin = "200px" }: Props) {
  const [isVisible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect(); } },
      { rootMargin },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return <div ref={ref}>{isVisible ? children : fallback}</div>;
}
```

The `DecoPageRenderer` could automatically wrap sections below a configurable fold threshold (e.g., index > 3) with `LazySection`.

**Streaming (Deferred):** TanStack Start already supports streaming SSR via React Suspense. Sections loaded with `React.lazy()` naturally stream. No additional work needed for this.

**Location:** `deco-start/src/hooks/LazySection.tsx`
**Effort:** ~80 LOC
**Dependencies:** None

---

## Part 4 -- Schema / Admin

---

### N. Schema Generation Improvements -- DONE

All JSDoc tags, `$` prefix filtering, and widget type detection are implemented.

Remaining: Loader/action schema generation (deferred -- needs manifest format design).

**Location:** `deco-start/scripts/generate-schema.ts`

---

### N.1 Admin Schema Composition Architecture -- DONE

**Problem:** The admin's properties form showed "Unsupported field schema for field root: Unknown field type undefined" because:
1. Framework-managed block types (pages) were hardcoded in the build-time schema generator, creating a coupling between the generator and the framework
2. Base64 keys used unpadded encoding (`.replace(/=+$/, "")`) while the admin uses `btoa()` which produces padded output, causing definition lookup failures
3. The admin cached stale `/_meta` responses, so schema changes didn't take effect

**Solution: Runtime schema composition via `composeMeta()`**

Framework-level schemas (pages, and future block types like loaders/matchers) are now defined in `deco-start/src/admin/schema.ts` and injected at runtime when `setMetaData()` is called, rather than being generated at build time.

Data flow:
```
[generate-schema.ts]          [setup.ts]                [composeMeta()]
Scans src/sections/    --->   Imports meta.gen.json  -->  Injects page schema,
Produces section-only         Calls setMetaData()        merges definitions,
meta.gen.json                                            populates pages root
      |                                                        |
      v                                                        v
  Section schemas only                              Full schema with pages +
  (pages: empty anyOf)                              sections + Resolvable
```

Key changes:
- `scripts/generate-schema.ts` -- Only generates section schemas; `toBase64()` now produces standard padded Base64
- `src/admin/schema.ts` (NEW) -- Defines `MetaResponse` type, `composeMeta()`, `buildPageSchema()`; framework owns its block schemas
- `src/admin/meta.ts` -- `setMetaData()` calls `composeMeta()` before storing; ETag uses content-based DJB2 hash; etag included in JSON body for admin cache busting
- `src/admin/index.ts` -- Exports `composeMeta` and `MetaResponse`

**Location:** `deco-start/src/admin/schema.ts`, `deco-start/src/admin/meta.ts`, `deco-start/scripts/generate-schema.ts`

---

### O. Admin Live Preview / Hot Reload

**What's missing:**
- `/deco/preview` -- WebSocket-based live preview where the admin sends props and gets rendered HTML back in real time
- `/deco/reload` -- Accept a new decofile via POST without redeploying

**Impact:** CMS editors can't see changes in real-time. Every content change requires a full page refresh or redeploy.

**Proposed solution:**

**Preview:** Our `/deco/render` already renders a single section with given props. The admin currently refreshes the iframe on each change. A WebSocket upgrade would allow the admin to push props and receive HTML streams, reducing latency.

However, the admin client would need to implement the WebSocket protocol. This is a coordinated effort between `deco-start` and the admin frontend.

**Hot reload:** More impactful. A `/deco/reload` endpoint that:
1. Accepts a new decofile JSON via POST
2. Calls `setBlocks(newBlocks)` to update the in-memory state
3. Subsequent page renders use the new blocks

This already partially works -- `setBlocks()` exists. The gap is the HTTP endpoint with authentication.

```typescript
// New admin endpoint
export function handleReload(request: Request): Response {
  const token = request.headers.get("Authorization");
  if (!isValidReloadToken(token)) return new Response("Unauthorized", { status: 401 });
  const newBlocks = await request.json();
  setBlocks(newBlocks);
  return new Response("OK");
}
```

**Location:** `deco-start/src/admin/reload.ts`
**Effort:** ~50 LOC for reload, ~300 LOC for WebSocket preview
**Dependencies:** Admin frontend changes for WebSocket preview

---

## Part 5 -- Components / Utilities

---

### P. Optimized Media Components

**What's missing:** Deco provides `Image.tsx`, `Picture.tsx`, `Video.tsx` with:
- CDN-aware image transforms (resize, format conversion via URL params)
- Responsive `srcset` generation
- Lazy loading with blur placeholder
- Aspect ratio enforcement (prevents CLS)
- Width/height attributes for layout stability

**Proposed solution:**

Create these as React components in `apps-start/commerce/components/` (since they're used across commerce storefronts):

```tsx
interface ImageProps {
  src: string;
  width: number;
  height: number;
  alt: string;
  sizes?: string;
  loading?: "lazy" | "eager";
  fetchPriority?: "high" | "low" | "auto";
  cdn?: "deco" | "vtex" | "shopify" | "cloudflare";
}

export function Image({ src, width, height, cdn = "deco", ...props }: ImageProps) {
  const optimizedSrc = buildCDNUrl(src, { width, height }, cdn);
  const srcSet = buildSrcSet(src, width, cdn);
  return <img src={optimizedSrc} srcSet={srcSet} width={width} height={height} {...props} />;
}
```

The CDN URL builder would support multiple image CDNs:
- `decocache.com` assets -> Deco's image transform API
- VTEX image URLs -> VTEX's built-in resize params
- Shopify image URLs -> Shopify's CDN transforms
- Generic -> Cloudflare Image Resizing (if available)

**Location:** `apps-start/commerce/components/Image.tsx`, `Picture.tsx`, `Video.tsx`
**Effort:** ~250 LOC total
**Dependencies:** None

---

### Q. Client-side State Hooks

**What's missing:** Deco provides `useCart`, `useUser`, `useWishlist`, `useAutocomplete` as client-side reactive state hooks. These manage loading states, optimistic updates, and cache invalidation for their respective domains.

**Proposed solution:**

Use TanStack Query as the state management layer (we already have it in the stack). Create hook factories in `apps-start`:

```typescript
// apps-start/vtex/hooks/useCart.ts
export function useCart() {
  const query = useQuery({
    queryKey: ["cart"],
    queryFn: () => invokeLoader("vtex/loaders/cart.ts"),
    staleTime: 0,  // always fresh
  });

  const addItem = useMutation({
    mutationFn: (item) => invokeAction("vtex/actions/checkout/addItems", item),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cart"] }),
  });

  return { cart: query.data, isLoading: query.isLoading, addItem, /* ... */ };
}
```

This pattern leverages TanStack Query's built-in SWR, optimistic updates, cache invalidation, and loading states. No need to reinvent state management.

**Location:** `apps-start/vtex/hooks/useCart.ts`, `useUser.ts`, `useWishlist.ts`
**Effort:** ~150 LOC per hook
**Dependencies:** TanStack Query, invoke proxy

---

### R. Missing Matchers -- PARTIALLY DONE

**Current:** 6 matchers (always, never, device, random, utm, posthog) + 6 new (cookie, cron/date, host, pathname, queryString)
**Deco has:** 16 matchers

Prioritized by real-world usage:

| Matcher | Priority | Effort | Use case |
|---------|----------|--------|----------|
| **cookie** | High | ~30 LOC | Match by specific cookie value (e.g., loyalty program tier) |
| **pathname** | High | ~30 LOC | Match by URL pattern (e.g., show banner only on `/sale/*`) |
| **queryString** | Medium | ~30 LOC | Match by query params (e.g., `?ref=partner1`) |
| **date** | Medium | ~40 LOC | Time-based content (Black Friday banner starts Nov 29) |
| **host** | Medium | ~20 LOC | Multi-domain stores (different content per domain) |
| **multi** | Medium | ~40 LOC | AND/OR combinator for composing matchers |
| **negate** | Medium | ~15 LOC | Invert any matcher |
| **cron** | Low | ~60 LOC | Scheduled content swaps (weekend vs weekday) |
| **location** | Low | ~50 LOC | Geo-targeting (requires IP geolocation, CF provides this) |
| **environment** | Low | ~20 LOC | Prod vs staging content |
| **site** | Low | ~15 LOC | Multi-site setup |
| **userAgent** | Low | ~30 LOC | Bot detection, specific browser targeting |

**Recommendation:** Implement cookie, pathname, queryString, date, multi, and negate. These cover 95% of real-world CMS personalization needs. The rest are niche.

**Location:** `deco-start/src/cms/resolve.ts` (add cases to `evaluateMatcher`)
**Effort:** ~200 LOC for the priority set

---

### S. Minor Utilities

These are small, self-contained gaps:

#### S.1 `useScript` minification

Deco's `useScript` LRU-caches terser-minified output. Ours concatenates raw strings.

**Recommendation:** Skip. Modern bundlers already minify the output. The inline scripts are small (event handlers, analytics snippets). The minification overhead at runtime isn't worth it for our deployment model (Cloudflare Workers have limited CPU time).

#### S.2 `readFromStream` (SSE)

Deco's client SDK can read streaming invoke responses via Server-Sent Events.

**Recommendation:** Defer. We don't have streaming loaders today. When we need real-time data (e.g., stock updates, price changes), implement SSE support in the invoke proxy.

#### S.3 `setCSPHeaders` for admin embedding -- DONE

Sets `Content-Security-Policy: frame-ancestors` allowing the deco admin origin to embed the storefront.

**Recommendation:** Implement. Small effort, needed for admin iframe preview to work without browser blocking it.

```typescript
export function setCSPHeaders(response: Response, adminOrigin: string = "https://admin.deco.cx"): void {
  response.headers.set(
    "Content-Security-Policy",
    `frame-ancestors 'self' ${adminOrigin} https://localhost:*`,
  );
}
```

**Effort:** ~10 LOC. Add to `deco-start/src/admin/cors.ts`.

#### S.4 Cache-Control merge -- DONE

`mergeCacheControl(h1, h2)` takes the minimum of numeric values (most restrictive wins). Useful when multiple middleware layers set cache headers.

**Recommendation:** Implement. Small, useful utility.

```typescript
export function mergeCacheControl(a: CacheControl, b: CacheControl): CacheControl {
  return {
    "max-age": Math.min(a["max-age"] ?? Infinity, b["max-age"] ?? Infinity),
    "s-maxage": Math.min(a["s-maxage"] ?? Infinity, b["s-maxage"] ?? Infinity),
    // ... etc, taking most restrictive
  };
}
```

**Effort:** ~40 LOC. Add to `deco-start/src/sdk/cacheHeaders.ts`.

#### S.5 `wrapCaughtErrors` (deferred error proxy) -- DONE

Catches loader errors and wraps them in a Proxy that defers the throw to render time, so `ErrorFallback` handles it.

**Recommendation:** Implement. Improves resilience -- a failing loader doesn't crash the page, it just shows the section's error fallback.

```typescript
export function wrapCaughtError(error: Error): Record<string, unknown> {
  return new Proxy({}, {
    get(_, prop) {
      if (prop === "__isWrappedError") return true;
      if (prop === "__error") return error;
      throw error;
    },
  });
}
```

**Effort:** ~30 LOC. Add to `deco-start/src/cms/resolve.ts`.

#### S.6 UTM param stripping for cache keys -- DONE

`useSection()` strips 20+ marketing query params for cache stability. Even without partial rendering, this is useful for page-level caching.

**Recommendation:** Implement in `workerEntry.ts` cache key builder.

Known params to strip: `fbclid`, `gclid`, `gclsrc`, `dclid`, `gbraid`, `wbraid`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `mc_cid`, `mc_eid`, `_hsenc`, `_hsmi`, `hsCtaTracking`, `__hsfp`, `__hssc`, `__hstc`, `msclkid`, `yclid`, `igshid`, `twclid`, `ttclid`.

**Effort:** ~20 LOC. Add to `deco-start/src/sdk/workerEntry.ts`.

---

## Part 6 -- Prioritized Roadmap

### Tier 0 -- Blocking for production -- ALL DONE

| # | Gap | Section | Status | Location |
|---|-----|---------|--------|----------|
| 1 | VTEX proxy routes | F | **DONE** | `apps-start/vtex/utils/proxy.ts` |
| 2 | VTEX middleware (segment + login-aware cache + vtexId) | E | **DONE** | `apps-start/vtex/middleware.ts` + `apps-start/vtex/utils/vtexId.ts` |
| 3 | Redirect system | K | **DONE** | `deco-start/src/sdk/redirects.ts` |
| 4 | Sitemap generation | J | **DONE** | `deco-start/src/sdk/sitemap.ts` + `apps-start/vtex/utils/sitemap.ts` |
| 5 | SEO JSON-LD components | L | **DONE** | `apps-start/commerce/components/JsonLd.tsx` |

### Tier 1 -- Important for quality -- ALL DONE

| # | Gap | Section | Status | Location |
|---|-----|---------|--------|----------|
| 6 | Segment-aware cache keys | C | **DONE** | `deco-start/src/sdk/workerEntry.ts` (SegmentKey + buildSegment option, UTM stripping, logged-in bypass) |
| 7 | Priority matchers (cookie, pathname, cron/date, host, queryString) | R | **DONE** | `deco-start/src/matchers/builtins.ts` |
| 8 | Top searches + search validator | H | **DONE** | `apps-start/vtex/loaders/search.ts` (already existed) |
| 9 | Product extension pipeline | G | **DONE** | `apps-start/vtex/utils/enrichment.ts` (createProductPipeline, withSimulation, withWishlist) |
| 10 | LazySection component | M | **DONE** | `deco-start/src/hooks/LazySection.tsx` |
| 11 | UTM param stripping + canonical URL utils | S.6 | **DONE** | `deco-start/src/sdk/urlUtils.ts` |
| 12 | `wrapCaughtErrors` for resilient rendering | S.5 | **DONE** | `deco-start/src/sdk/wrapCaughtErrors.ts` |
| 13 | CSP headers for admin embedding | S.3 | **DONE** | `deco-start/src/sdk/csp.ts` |
| 14 | Cache-Control merge utility | S.4 | **DONE** | `deco-start/src/sdk/mergeCacheControl.ts` |

### Tier 2 -- DX and completeness -- ALL DONE

| # | Gap | Section | Status | Location |
|---|-----|---------|--------|----------|
| 15 | Schema gen: all JSDoc tags + `$` filtering + widget detection | N | **DONE** | `deco-start/scripts/generate-schema.ts` (20+ JSDoc tags, $ prefix filtering, widget type detection) |
| 16 | Client-side hooks (useCart, useUser, useWishlist) | Q | **DONE** | `apps-start/vtex/hooks/useCart.ts`, `useUser.ts`, `useWishlist.ts` |
| 17 | Optimized Image/Picture components | P | **DONE** | `apps-start/commerce/components/Image.tsx` (Image + Picture with multi-CDN support) |
| 18 | RequestContext via AsyncLocalStorage | D | **DONE** | `deco-start/src/sdk/requestContext.ts` |
| 19 | Commerce loader request context | A (rec. 1) | **DONE** | `deco-start/src/cms/resolve.ts` (CommerceLoaderContext + MatcherContext._request) |
| 20 | Remaining VTEX loaders (brands, pageType) | H | **DONE** | `apps-start/vtex/loaders/brands.ts`, `pageType.ts` (orderPlaced already in orders.ts) |
| 21 | Admin schema composition (composeMeta) | N.1 | **DONE** | `deco-start/src/admin/schema.ts` (runtime composition, padded Base64, content-hash ETag) |

### Tier 3 -- Future / deferred

| # | Gap | Section | Dependencies |
|---|-----|---------|-------------|
| 22 | Loader/action schema generation | N | Manifest format design |
| 23 | Admin live preview (WebSocket) | O | Admin frontend changes |
| 24 | Hot reload endpoint | O | Auth token system |
| 25 | SSE streaming reader | S.2 | Streaming loaders |
| 26 | `sectionMiddleware` / transformProps | A (rec. 2) | Registry changes |
| 27 | Shopify draft order, proxy routes | I | Shopify store demand |
| 28 | Geo/location matchers | R | IP geolocation service |

---

## Intentional Divergences (not gaps)

These are architectural choices, not missing features:

| Deco | deco-start | Why it's intentional |
|------|-----------|---------------------|
| Section exports `loader()` + `action()` | Sections are pure React components | Idiomatic React/TanStack; loaders wired externally |
| HTMX partials (`hx-get`, `f-partial`) | TanStack Query + Router navigation | React reconciliation model; no DOM swap hacks |
| Fresh islands (selective hydration) | Full React SPA with SSR | TanStack Start's model; Suspense for code splitting |
| Deno runtime | Node.js on Cloudflare Workers | Deployment target choice |
| Import maps for app composition | npm packages | Standard Node.js package resolution |
| Daemon/CRDT/tunnel dev server | Vite HMR + TanStack devtools | Modern frontend DX stack |
| Global fetch monkey-patch | Explicit instrumented fetch | Predictable; no hidden behavior |
| `RequestContext.framework = "htmx"` | Always React | Single rendering framework |
| Per-loader Vary system | Segment-based cache keys | Simpler; Cloudflare Cache API handles differentiation |
