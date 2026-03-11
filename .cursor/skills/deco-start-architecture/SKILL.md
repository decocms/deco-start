---
name: deco-start-architecture
description: Architecture reference for @decocms/start — the Deco framework for TanStack Start/React/Cloudflare Workers. Covers the three-layer architecture (@decocms/start + @decocms/apps + site), admin protocol (meta, decofile, invoke, render), CMS block resolution with generic recursive resolver, dynamic schema registries, section registry, worker entry with edge caching, SDK utilities (useDevice, useScript with minification, observability, health metrics), matchers, middleware, hooks, schema generation, and the comprehensive gap analysis vs deco-cx/deco. Includes a prioritized roadmap (Tier 0-3 complete, plus Tier 2.5 framework improvements). Use when working on deco-start, understanding the framework, adding features, debugging admin protocol issues, or planning what to port next from deco-cx/deco.
globs:
  - "**/workerEntry.ts"
  - "**/cacheHeaders.ts"
  - "**/LiveControls.tsx"
  - "**/DecoPageRenderer.tsx"
  - "**/resolve.ts"
  - "**/setup.ts"
  - "**/.decofile"
  - "**/meta.gen.json"
  - "**/blocks.gen.ts"
---

## Sub-documents

| Document | Topic |
|----------|-------|
| [admin-protocol.md](./admin-protocol.md) | Admin protocol — meta, decofile, invoke, render, CORS, LiveControls |
| [cms-resolution.md](./cms-resolution.md) | CMS block loading, page resolution, section registry, matchers |
| [worker-entry-caching.md](./worker-entry-caching.md) | Cloudflare Worker entry, edge caching, segment keys, cache profiles |
| [sdk-utilities.md](./sdk-utilities.md) | All SDK utilities — useScript, signal, analytics, cookies, redirects, sitemap |
| [gap-analysis.md](./gap-analysis.md) | Feature-by-feature comparison with deco-cx/deco + prioritized roadmap |
| [code-quality.md](./code-quality.md) | Code quality tools, scripts, recommendations |

# @decocms/start Architecture

Reference for `@decocms/start` — the Deco framework for TanStack Start storefronts on Cloudflare Workers.

## Three-Layer Architecture

```
 Layer 1: @decocms/start (this repo)
   Framework: CMS bridge, admin protocol, worker entry, caching, rendering
         |
 Layer 2: @decocms/apps (apps-start)
   Commerce: VTEX/Shopify loaders, types, hooks, transforms
         |
 Layer 3: Site repo (e.g., espacosmart-storefront)
   UI: components, routes, styles, contexts, sections
```

## Repository Structure

```
deco-start/
|-- package.json            # v0.6.0, exports map, peer deps
|-- tsconfig.json           # ES2022, bundler resolution, strictNullChecks
|-- .releaserc.json         # semantic-release (Angular preset)
|-- CLAUDE.md               # AI guidance document
|-- GAP_ANALYSIS_V2.md      # Detailed gap analysis vs deco-cx/deco
|
|-- src/
|   |-- index.ts            # Barrel: re-exports admin, cms, hooks, types, middleware
|   |
|   |-- admin/              # Admin protocol handlers (9 files)
|   |   |-- setup.ts        # Client-safe config (setMetaData, setInvokeLoaders, setInvokeActions, setRenderShell, register*Schema)
|   |   |-- meta.ts         # GET /live/_meta handler (auto-invalidates on decofile change)
|   |   |-- schema.ts       # composeMeta(), dynamic schema registries (loaders + matchers)
|   |   |-- decofile.ts     # GET/POST /.decofile handlers (revision tracking, cache invalidation)
|   |   |-- invoke.ts       # POST /deco/invoke handler (form-data, select, actions, batch, nested resolve)
|   |   |-- render.ts       # POST /live/previews/* handler
|   |   |-- liveControls.ts # Admin-storefront bridge script
|   |   |-- cors.ts         # CORS for admin origins
|   |   |-- index.ts        # Barrel export
|   |
|   |-- cms/                # CMS block resolution (4 files)
|   |   |-- loader.ts       # loadBlocks, findPageByPath, getAllPages, withBlocksOverride, getRevision, onChange
|   |   |-- registry.ts     # registerSection, getSection, getSectionRegistry
|   |   |-- resolve.ts      # resolveValue, resolveDecoPage, internalResolve, registerCommerceLoader, registerMatcher, addSkipResolveType, set*Handler
|   |   |-- index.ts        # Barrel export
|   |
|   |-- hooks/              # React components/hooks (5 files)
|   |   |-- LiveControls.tsx     # Admin bridge component
|   |   |-- DecoPageRenderer.tsx # Renders sections with Suspense
|   |   |-- LazySection.tsx      # IntersectionObserver lazy loading
|   |   |-- SectionErrorFallback.tsx # Per-section error boundary
|   |   |-- index.ts
|   |
|   |-- middleware/          # Request middleware (5 files)
|   |   |-- observability.ts # configureTracer, configureMeter, withTracing, logRequest, MetricNames, recordRequestMetric, recordCacheMetric
|   |   |-- healthMetrics.ts # trackRequest, getHealthMetrics, handleHealthCheck (/deco/_health)
|   |   |-- liveness.ts     # /deco/_liveness health probe (integrated with /deco/_health)
|   |   |-- decoState.ts    # buildDecoState per request
|   |   |-- index.ts
|   |
|   |-- sdk/                # SDK utilities (21 files)
|   |   |-- workerEntry.ts      # createDecoWorkerEntry (CF Worker wrapper)
|   |   |-- cacheHeaders.ts     # detectCacheProfile, routeCacheDefaults
|   |   |-- cachedLoader.ts     # In-memory SWR loader cache
|   |   |-- mergeCacheControl.ts # Cache-Control merge
|   |   |-- analytics.ts        # useSendEvent, ANALYTICS_SCRIPT, gtmScript
|   |   |-- useScript.ts        # useScript (with minification + LRU cache), usePartialSection, useSection
|   |   |-- useDevice.ts        # Server-side device detection (detectDevice, useDevice, checkMobile/Tablet/Desktop)
|   |   |-- signal.ts           # Reactive signal (replaces @preact/signals)
|   |   |-- clx.ts              # CSS class utility
|   |   |-- cookie.ts           # Cookie get/set/delete (client + server)
|   |   |-- invoke.ts           # createInvokeProxy, batchInvoke, invokeQueryOptions
|   |   |-- redirects.ts        # CMS redirect loading + matching
|   |   |-- sitemap.ts          # Sitemap XML generation
|   |   |-- csp.ts              # CSP frame-ancestors for admin
|   |   |-- urlUtils.ts         # UTM stripping, canonical URLs
|   |   |-- requestContext.ts   # AsyncLocalStorage per-request context
|   |   |-- serverTimings.ts    # Server-Timing header
|   |   |-- instrumentedFetch.ts # Fetch with logging/tracing
|   |   |-- useId.ts            # React useId wrapper
|   |   |-- wrapCaughtErrors.ts # Deferred error proxy for resilient rendering
|   |   |-- index.ts
|   |
|   |-- matchers/            # Feature flag matchers (2 files)
|   |   |-- builtins.ts     # cookie, cron, host, pathname, queryString
|   |   |-- posthog.ts      # PostHog integration
|   |
|   |-- types/               # Type definitions (2 files)
|   |   |-- index.ts        # FnContext, App, Section, SectionProps, Flag, etc.
|   |   |-- widgets.ts      # ImageWidget, HTMLWidget, VideoWidget aliases
|
|-- scripts/
|   |-- generate-blocks.ts   # .deco/blocks/*.json -> blocks.gen.ts
|   |-- generate-schema.ts   # TypeScript props -> JSON Schema (meta.gen.json)
```

## Package Exports

| Import Path | File | Purpose |
|-------------|------|---------|
| `@decocms/start` | `src/index.ts` | Main barrel |
| `@decocms/start/admin` | `src/admin/index.ts` | Admin protocol |
| `@decocms/start/cms` | `src/cms/index.ts` | Block resolution |
| `@decocms/start/hooks` | `src/hooks/index.ts` | React components |
| `@decocms/start/middleware` | `src/middleware/index.ts` | Request middleware |
| `@decocms/start/sdk` | `src/sdk/index.ts` | SDK utilities |
| `@decocms/start/sdk/workerEntry` | `src/sdk/workerEntry.ts` | CF Worker entry |
| `@decocms/start/sdk/cacheHeaders` | `src/sdk/cacheHeaders.ts` | Cache profiles |
| `@decocms/start/sdk/invoke` | `src/sdk/invoke.ts` | Invoke proxy |
| `@decocms/start/types` | `src/types/index.ts` | Type definitions |
| `@decocms/start/types/widgets` | `src/types/widgets.ts` | Widget type aliases |
| `@decocms/start/sdk/useDevice` | `src/sdk/useDevice.ts` | Server-side device detection |
| `@decocms/start/middleware/healthMetrics` | `src/middleware/healthMetrics.ts` | Health metrics + `/deco/_health` |
| `@decocms/start/matchers/builtins` | `src/matchers/builtins.ts` | Built-in matchers |

## Key Concepts

### 1. Worker Entry (Edge Layer)

```
Request -> createDecoWorkerEntry(serverEntry, options)
  |-- tryAdminRoute()         <- /live/_meta, /.decofile, /live/previews/*
  |-- cache purge check       <- __deco_purge_cache
  |-- static asset bypass     <- /assets/*, favicon, sprites
  |-- Cloudflare edge cache   <- caches.open() with profile-based TTLs
  |-- serverEntry.fetch()     <- TanStack Start handles the rest
```

### 2. Admin Protocol

| Route | Method | Handler | Purpose |
|-------|--------|---------|---------|
| `/live/_meta` | GET | `handleMeta` | JSON Schema + manifest |
| `/.decofile` | GET | `handleDecofileRead` | CMS content blocks |
| `/.decofile` | POST | `handleDecofileReload` | Hot reload blocks |
| `/deco/invoke` | POST | `handleInvoke` | Execute loaders/actions |
| `/live/previews/*` | POST | `handleRender` | Section preview in admin |
| `/deco/_liveness` | GET | `handleLiveness` | Health probe |
| `/deco/_health` | GET | `handleHealthCheck` | Detailed health metrics (uptime, memory, cache, requests) |

### 3. CMS Resolution

```
[CMS decofile]                 [setup.ts]                    [resolveDecoPage]
Section props with             Commerce loaders              Generic recursive resolver:
__resolveType: "vtex/..."  --> registered by key       -->   1. Check commerce loaders
                               + matchers                    2. Check decofile blocks
                               + schema registries           3. DanglingReference fallback
                                                             + memoization + depth protection
                                                                   |
                                                                   v
                                                             [React Component]
                                                             Receives plain data
```

### 4. Section Rendering

```tsx
<DecoPageRenderer sections={resolvedSections}>
  {sections.map((section, i) => (
    <SectionErrorBoundary key={i}>
      <Suspense fallback={<div />}>
        {isBelowFold(i) ? (
          <LazySection><SectionComponent {...section.props} /></LazySection>
        ) : (
          <SectionComponent {...section.props} />
        )}
      </Suspense>
    </SectionErrorBoundary>
  ))}
</DecoPageRenderer>
```

## Dependencies

- **Peer**: `@tanstack/store` >= 0.7.0, `react` ^19, `react-dom` ^19
- **Dev**: `ts-morph` (schema gen), `typescript` ^5.9

## Implementation Status

Tier 0 (production-blocking), Tier 1 (quality), Tier 2 (DX/completeness), and Tier 2.5 (framework improvements) are ALL DONE. See [gap-analysis.md](./gap-analysis.md) for details on Tier 3 items remaining.

### Tier 2.5 Highlights (PR #3: feat/framework-improvements)
- Dynamic schema registries (loaders + matchers) — replaces hardcoded `KNOWN_LOADERS`
- Generic recursive resolver with memoization, depth protection, DanglingReference handler
- `useDevice` server-side (User-Agent + RequestContext)
- `/deco/_health` endpoint with uptime, memory, cache stats, request metrics
- Enhanced observability: `MeterAdapter`, `MetricNames`, context propagation
- Enhanced invoke: FormData/URLEncoded parsing, `?select=`, actions, nested `__resolveType`
- Decofile revision tracking + `onChange` listeners + meta auto-invalidation
- `useScript` minification + LRU cache
