# deco-cx/deco vs @decocms/start

Mapping between the original Deco framework (Fresh/Deno) and its TanStack/Node counterpart.

## Architecture Comparison

```
deco-cx/deco (Fresh/Deno)              @decocms/start (TanStack/Node)
─────────────────────────              ──────────────────────────────
Deno runtime                           Node.js / Cloudflare Workers
Fresh 1.6.8 framework                  TanStack Start + Vite
Preact 10.23.1                         React 18/19
Hono (internal router)                 TanStack Router (file-based)
manifest.gen.ts                        Explicit imports + admin protocol
DecofileProvider                       Admin SDK (CMS state fetching)
Resolution engine (Resolvable)         Direct function calls
Block system (adapt/resolve)           Pure async functions
@preact/signals                        @tanstack/react-store / React state
deno.json (import map)                 package.json + npm
```

## Module Mapping

### Entry Points

| deco-cx/deco | @decocms/start | Notes |
|-------------|----------------|-------|
| `mod.ts` | `src/index.ts` | Main exports |
| `mod.web.ts` | Not needed | Client invoke is direct imports |
| `deco.ts` (Context) | Admin context/config | No AsyncLocalStorage pattern |
| `live.ts` | N/A (legacy) | — |
| `types.ts` | TypeScript types from packages | — |

### Engine → Generic Resolver

Both frameworks now have a resolution engine, but `@decocms/start`'s is simpler and purpose-built:

```typescript
// deco-cx/deco: full resolution engine with hints, single-flight, monitoring
// decofile state:
{ "__resolveType": "vtex/loaders/productList.ts", "query": "shoes", "count": 12 }
// → engine.resolve() → find resolver → invoke with resolved props → hints → monitoring

// @decocms/start: generic recursive resolver (internalResolve)
// Same __resolveType decofile format, resolved via:
// 1. Check commerce loaders registry
// 2. Check decofile blocks
// 3. DanglingReference fallback (configurable)
// + Per-request memoization + depth protection (max 10)
```

Key differences:
- `deco-cx/deco` has full-featured single-flight, hints, monitoring
- `@decocms/start` has simpler memoization + configurable error handlers (`setResolveErrorHandler`, `setDanglingReferenceHandler`)
- `@decocms/start` supports `select` field filtering on resolved values
- `@decocms/start` allows dynamically adding skip types via `addSkipResolveType()`

### Blocks → Functions/Components

| deco Block | TanStack Equivalent |
|-----------|---------------------|
| Section block | React component (direct import) |
| Loader block (cached, single-flight) | Server function + React Query (with staleTime) |
| Action block | Server function + React Query mutation |
| Handler block | TanStack Router route handler |
| Flag block | Feature flag config (edge-level) |
| Matcher block | Middleware or route guard |
| App block | `configure*()` function (e.g., `configureVtex()`) |
| Workflow block | Background task (platform-specific) |

### Runtime → TanStack Start

| deco Runtime | TanStack Start |
|-------------|---------------|
| Hono router | TanStack Router |
| Fresh middleware chain | TanStack Start middleware |
| `/live/invoke/*` | API routes or server functions |
| `/deco/render` | React Server Components or loader revalidation |
| `entrypoint.tsx` catch-all | `__root.tsx` + route tree |
| `Deco` class | Vite plugin + start config |

### Hooks → React Equivalents

| deco Hook | TanStack Equivalent |
|-----------|---------------------|
| `useSection()` | React Query revalidation + state updates (stub in `@decocms/start`) |
| `usePartialSection()` | TanStack Router Link / navigate (stub in `@decocms/start`) |
| `useScript()` | `@decocms/start/sdk/useScript` — with lightweight minification + LRU cache |
| `useScriptAsDataURI()` | `@decocms/start/sdk/useScript` — same, data URI variant |
| `useDevice()` | `@decocms/start/sdk/useDevice` — server-side via User-Agent + RequestContext, also `detectDevice`, `checkMobile/Tablet/Desktop` |
| `useSetEarlyHints()` | Response headers in server middleware |

### Plugins → Config

| deco Plugin | TanStack Equivalent |
|------------|---------------------|
| `plugins/deco.ts` (Fresh plugin) | `@decocms/start` Vite plugin + entry |
| `plugins/fresh.ts` (Tailwind + Deco) | Tailwind via Vite plugin |
| `plugins/styles.ts` (global CSS) | CSS in `__root.tsx` or global stylesheet |

### Clients → Direct Imports

| deco Client | TanStack Equivalent |
|------------|---------------------|
| `proxy<Manifest>()` | Direct function imports |
| `invoke["key"](props)` | `await loaderFn(props)` or `/deco/invoke` with FormData/URLEncoded/JSON |
| `readFromStream()` | `fetch()` + ReadableStream |
| `formDataToProps()` | Built into invoke handler (auto-parses multipart/form-data and URL-encoded) |

### Components → React Components

| deco Component | TanStack Equivalent |
|---------------|---------------------|
| `LiveControls.tsx` | `LiveControls.tsx` in `@decocms/start` (adapted) |
| `SectionContext` | React context per section |
| `ErrorBoundary` | React Error Boundary |
| `StubSection` | Fallback component |
| `JsonViewer` | JSON display component |

## State Management Comparison

### deco-cx/deco

```
CMS Admin → publish → DecofileProvider.onChange()
  → ReleaseResolver rebuilds
  → New resolvables available
  → Next request uses new state
```

### @decocms/start

```
CMS Admin → publish → POST /.decofile (hot-reload)
  → setBlocks() updates in-memory state
  → Revision recomputed (content-hash)
  → onChange listeners notified (meta cache invalidated)
  → clearLoaderCache() ensures fresh data
  → Edge cache purge (Cloudflare)
  → Next request uses new state + fresh schema
```

## Rendering Comparison

### deco-cx/deco (SSR + Islands)

```
Request → Fresh handler
  → Resolve page sections (engine)
  → Preact renderToString (server)
  → Hydrate islands only (client)
  → Partial updates via useSection + /deco/render
```

### @decocms/start (SSR + Full Hydration)

```
Request → TanStack Start handler
  → Route loader runs (server function)
  → React renderToString (server)
  → Full hydration (client)
  → Client-side navigation via TanStack Router
  → Data updates via React Query revalidation
```

## Caching Comparison

| Aspect | deco-cx/deco | @decocms/start |
|--------|-------------|---------------|
| Loader cache | In-process single-flight + LRU | React Query staleTime + Cloudflare cache |
| Page cache | CDN + Deco edge | Cloudflare Workers cache API |
| Static assets | Fresh static serving | Vite build + CDN |
| Cache invalidation | DecofileProvider onChange | `setBlocks` → onChange listeners + `clearLoaderCache()` + edge purge |

## Key Takeaways for Porting

1. **Simpler resolution engine**: `@decocms/start` now has a generic recursive resolver (`internalResolve`) for `__resolveType`, but it's simpler than `deco-cx/deco`'s full engine (no hints, no single-flight). It resolves commerce loaders, decofile blocks, and has configurable fallback for dangling references.

2. **No manifest**: Instead of auto-generated manifests with lazy imports, `@decocms/apps-start` uses explicit exports that sites import directly.

3. **No islands architecture**: React hydrates everything. Optimize with React.lazy, Suspense, and code splitting instead.

4. **Enhanced invoke**: The `/deco/invoke` endpoint now supports FormData, URL-encoded bodies, `?select=` filtering, batch execution, actions registration, and nested `__resolveType` resolution.

5. **CMS integration**: `@decocms/start` provides the admin protocol (LiveControls, section editing) through its own SDK. Schema registries are dynamic (loaders + matchers registered at runtime).

6. **Edge-first**: `@decocms/start` is designed for Cloudflare Workers, with caching handled at the edge rather than in-process.

7. **Observability parity**: `@decocms/start` now has pluggable `TracerAdapter` + `MeterAdapter`, standardized `MetricNames`, and a `/deco/_health` endpoint with uptime, memory, cache stats, and request metrics.

8. **Server-side device detection**: `useDevice()` works server-side via `RequestContext` + User-Agent parsing, matching `deco-cx/deco`'s functionality.
