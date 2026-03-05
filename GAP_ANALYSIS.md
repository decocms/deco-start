# deco-cx/deco vs @decocms/start — Capability Gap Analysis

> Generated from a full audit of `deco-cx/deco` (v1.174.2) compared against `@decocms/start` + `@decocms/apps`.
> Last updated: March 2026

---

## What's Already Ported

| Area | Status | Notes |
|---|---|---|
| CMS Block Storage + Page Routing | Solid | In-memory blocks, pattern matching with specificity |
| Deep Recursive Resolution | Solid | Walks section tree, dereferences blocks, handles variants |
| Section Registry | Solid | Lazy-loaded, async component registry with per-section options |
| Multivariate Flags / A/B Testing | Solid | Matchers + variant evaluation + PostHog bridge for sticky sessions |
| Admin Protocol | Functional | `/deco/meta`, `/deco/decofile`, `/deco/invoke`, `/deco/render` |
| Build-time Schema Gen | Good | `ts-morph` based, Props -> JSON Schema 7 |
| Build-time Block Gen | Good | `.deco/blocks/*.json` -> `blocks.gen.ts` |
| Analytics SDK | Good | `data-event` pattern, IntersectionObserver, GTM |
| useScript / useScriptAsDataURI | Ported | Function -> IIFE serialization |
| Signal (reactive state) | Ported | `@tanstack/store` backed, Preact signals API compat |
| Cookie Utilities | Ported | Client + server |
| className helper (clx) | Ported | Falsy filtering, whitespace collapse |
| Widget Types | Partial | Image, HTML, Video, Text, RichText, Secret, Color, Button |
| Core Type Aliases | Partial | App, AppContext, FnContext, Section, SectionProps, Flag |
| Admin Iframe Bridge | Ported | LiveControls with postMessage |
| DecoPageRenderer | Ported | Suspense + lazy sections + error boundaries + per-section fallbacks |
| Commerce Types | Solid | Full schema.org model (Product, PDP, PLP, etc.) |
| Commerce SDK | Good | useOffer, useVariantPossibilities, formatPrice, analytics |
| VTEX Integration | Extensive | 15 loaders, 11 actions, 6 inline loaders, instrumented fetch support |
| Shopify Integration | Partial | 4 loaders, 2 actions (missing related products, coupons), instrumented fetch support |
| **Loader Caching** | **NEW** | `createCachedLoader()` — SWR, single-flight dedup, LRU eviction |
| **Section Error Boundaries** | **NEW** | `SectionErrorBoundary` — per-section isolation, dev stack trace, prod silent |
| **Middleware Utilities** | **NEW** | `buildDecoState`, `handleLiveness`, `applyServerTiming`, `applyCorsHeaders` |
| **CDN Cache Headers** | **NEW** | `cacheHeaders()` — named profiles (static, product, listing, search, cart) |
| **Server-Timing** | **NEW** | `createServerTimings()` — start/record/toHeader for DevTools visibility |
| **Typed Invoke Proxy** | **NEW** | `createInvokeProxy()`, `batchInvoke()`, `invokeQueryOptions()` for TanStack Query |
| **PostHog Matcher Bridge** | **NEW** | `createPostHogMatcher()` + `createServerPostHogAdapter()` for sticky A/B |
| **Observability Toolkit** | **NEW** | `configureTracer()`, `withTracing()`, `logRequest()` — pluggable tracer adapter |
| **Instrumented Fetch** | **NEW** | `createInstrumentedFetch()` — dev logging + OTel tracing for outbound HTTP |

---

## What's Still Missing

### 1. Runtime / Server Infrastructure

| Capability | Impact | Status |
|---|---|---|
| ~~Middleware pipeline~~ | ~~No composable interceptors~~ | **DONE** — middleware utilities exported for TanStack Start `createMiddleware()` |
| ~~Multi-tier caching~~ | ~~No SWR, no CDN headers~~ | **DONE** — `createCachedLoader()` + `cacheHeaders()` |
| ~~Fetch enhancement~~ | ~~Raw fetch, no instrumented wrapper~~ | **DONE** — `createInstrumentedFetch()` wired into VTEX/Shopify clients |
| ~~Loader cache modes~~ | ~~Loaders always run fresh~~ | **DONE** — 3 policies: `no-store`, `no-cache`, `stale-while-revalidate` |
| ~~Server-Timing headers~~ | ~~No performance visibility~~ | **DONE** — `createServerTimings()` + middleware integration |
| ~~CORS utility~~ | ~~Admin-only CORS~~ | **DONE** — `applyCorsHeaders()` in middleware |
| Built-in route system | Path matching exists but no TanStack Router integration | Deferred — TanStack Router handles this |
| Static asset serving | Handled by TanStack Start | Deferred — not needed |
| Early Hints (103) | No resource preloading hints | Remaining |

### 2. Observability

| Capability | Impact | Status |
|---|---|---|
| ~~Pluggable tracing~~ | ~~No tracing~~ | **DONE** — `configureTracer()` + `withTracing()` adapter |
| ~~Structured logging~~ | ~~No structured logs~~ | **DONE** — `logRequest()` (JSON in prod, colored in dev) |
| ~~Fetch instrumentation~~ | ~~No auto-trace on outbound HTTP~~ | **DONE** — `createInstrumentedFetch()` |
| ~~Health probes~~ | ~~No liveness check~~ | **DONE** — `handleLiveness()` at `/_liveness` |
| Full OTel SDK integration | No auto-instrumentation | Remaining — use Sentry add-on or OTel SDK manually |
| OTel metrics (histograms) | No cache hit/miss, latency metrics | Remaining |
| Debug sampling | No debug-mode tracing | Remaining |

### 3. Block System

| Capability | Impact | Status |
|---|---|---|
| ~~Error boundary per section~~ | ~~Sections can crash the whole page~~ | **DONE** — `SectionErrorBoundary` wraps each section |
| ~~Loading fallback per section~~ | ~~No granular loading states~~ | **DONE** — per-section `SectionOptions` in registry |
| Handler blocks | No custom HTTP handler blocks | Deferred — TanStack server routes replace this |
| Workflow blocks | No durable workflows | Deferred — Cloudflare Workflows is the replacement |
| Account blocks | No credential management blocks | Deferred — env vars / t3env add-on |
| Block middleware | No per-block interceptors | Remaining |
| Gate Keeper visibility | No admin-only vs. public block control | Remaining |

### 4. Engine / Resolution

| Capability | Impact | Status |
|---|---|---|
| `ReleaseResolver` | No lazy/deferred resolution, no `runOnce` | Remaining |
| Resolve chains (tracing) | Can't track which block called which | Remaining |
| Override maps | Can't substitute resolvables at runtime | Remaining |
| Decofile hot-reload | Changes require full redeploy | Remaining |
| Composable decofile providers | Only fs-based | Remaining |
| Import map building | No app composition via import maps | Deferred — npm handles this |

### 5. Client SDK

| Capability | Impact | Status |
|---|---|---|
| ~~Typed invoke proxy~~ | ~~No `Runtime.vtex.loaders.x()` pattern~~ | **DONE** — `createInvokeProxy()` |
| ~~Batch invoke~~ | ~~No batch client-side calls~~ | **DONE** — `batchInvoke()` |
| ~~TanStack Query integration~~ | ~~No SWR for invoke calls~~ | **DONE** — `invokeQueryOptions()` |
| SSE streaming reader | No streaming invoke support | Remaining |
| `forApp<TApp>()` | No app-specific typed invocations | Remaining |

### 6. Matcher System

| Capability | Impact | Status |
|---|---|---|
| ~~Sticky sessions / PostHog~~ | ~~Random matcher is non-deterministic~~ | **DONE** — `createPostHogMatcher()` + server-side adapter |
| Geo matchers | No location-based targeting | Remaining |
| Date/time matchers | No time-based content scheduling | Remaining |
| Cron matchers | No scheduled content swaps | Remaining |
| User-based matchers | No logged-in/anonymous targeting | Remaining |

### 7. Context System

| Capability | Impact | Status |
|---|---|---|
| ~~`DecoState` per-request~~ | ~~No state threading~~ | **DONE** — `buildDecoState()` in middleware |
| `RequestContext` (AsyncLocalStorage) | No per-request state without prop drilling | Remaining |
| Platform detection | No K8s/Deploy/localhost detection | Remaining |

### 8. Auth / JWT

| Capability | Status |
|---|---|
| JWT issuers / JWKS / key pairs | Deferred — use Clerk or WorkOS TanStack add-on |

### 9. Developer Tooling / CLI

| Capability | Status |
|---|---|
| Dev daemon / CRDT / tunnel | Deferred — TanStack Start dev server + Vite HMR |
| Codemod system | Deferred |

### 10. Widget Types (remaining)

| Missing | Status |
|---|---|
| `Select`, `CheckboxGroup`, `RadioGroup`, `DatePicker`, `NumberRange`, `Dynamic` | Remaining |
| Custom widget registration | Remaining |

### 11. Schema Generation Gaps (remaining)

| Missing | Status |
|---|---|
| Loader/action schema generation | Remaining |
| Widget type annotation detection | Remaining |
| Incremental/watch mode | Remaining |
| App dependency schema merging | Remaining |

---

## Severity Tiers (Updated)

### Tier 1 — Critical for production: DONE

- ~~Multi-tier caching (loader SWR + CDN headers)~~ **DONE**
- ~~Error boundaries per section~~ **DONE**
- ~~Sticky sessions for A/B tests~~ **DONE**
- ~~Server-Timing headers~~ **DONE**
- ~~DecoState per-request~~ **DONE** (via middleware)
- RequestContext / AsyncLocalStorage threading — **remaining**

### Tier 2 — Important for DX: MOSTLY DONE

- Decofile hot-reload (no redeploy) — **remaining**
- ~~Typed invoke proxy (client-side)~~ **DONE**
- Loader/action schema generation — **remaining**
- Widget annotation detection in schema gen — **remaining**
- ~~Loading fallbacks per section~~ **DONE**

### Tier 3 — Important for scale: MOSTLY DONE

- ~~Pluggable observability (tracer adapter + tracing + logging)~~ **DONE**
- ~~Health probes~~ **DONE**
- ~~Fetch instrumentation~~ **DONE**
- ~~Middleware pipeline~~ **DONE**
- Full OTel auto-instrumentation — **remaining** (use Sentry add-on)

### Tier 4 — Nice to have / deferred

- Dev daemon — Deferred (TanStack Start dev server)
- JWT utilities — Deferred (Clerk/WorkOS add-on)
- Workflow/durable blocks — Deferred (Cloudflare Workflows)
- Handler blocks — Deferred (TanStack server routes)
- AI code generation — Deferred
- Codemod system — Deferred

---

## New Module Map

```
@decocms/start
├── src/
│   ├── cms/           # Block storage, page routing, resolution, registry
│   ├── admin/         # Admin protocol endpoints (meta, decofile, invoke, render)
│   ├── hooks/         # DecoPageRenderer, SectionErrorBoundary, LiveControls
│   ├── middleware/     # DecoState, liveness, Server-Timing, CORS, observability
│   ├── matchers/      # PostHog feature flag bridge
│   ├── sdk/           # cachedLoader, cacheHeaders, serverTimings, invoke, instrumentedFetch, analytics, signal, cookie, clx, useScript
│   └── types/         # Core types + widget types
├── scripts/           # generate-blocks, generate-schema
└── package.json       # 18 export paths
```

---

## Evolution Path

The framework is now at **"production-capable"** — it has the CMS resolution engine, section isolation, caching, middleware, observability hooks, typed client SDK, and instrumented fetch. What remains is:

1. **Next** — AsyncLocalStorage-based RequestContext, decofile hot-reload
2. **Then** — Schema generation improvements (loaders, widgets, watch mode)
3. **Later** — Full OTel auto-instrumentation, advanced matchers (geo, time, user)
4. **Eventually** — SSE streaming, remaining widget types
