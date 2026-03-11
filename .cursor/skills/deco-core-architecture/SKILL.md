---
name: deco-core-architecture
description: Architecture reference for deco-cx/deco — the core Deco framework for Fresh/Deno. Covers the resolution engine (Resolvable → Resolver pipeline), block system (sections, loaders, actions, flags, matchers, handlers, apps, workflows), runtime request flow (Hono + Fresh/HTMX), DecofileProvider (state management), manifest generation, plugin system, hooks (useSection, useScript, useDevice), client-side invoke proxy, and the relationship between deco-cx/deco (Fresh/Deno) and @decocms/start (TanStack/Node). Use when exploring the deco repo, understanding how the framework works, building new block types, debugging resolution issues, or porting deco internals to TanStack Start.
globs:
  - "**/deco.ts"
  - "**/manifest.gen.ts"
  - "**/mod.ts"
  - "**/runtime.ts"
  - "**/fresh.config.ts"
---

## Sub-documents

| Document | Topic |
|----------|-------|
| [engine.md](./engine.md) | Resolution engine — Resolvable, Resolver, DecofileProvider, resolve pipeline |
| [blocks.md](./blocks.md) | Block system — all block types, adapt/decorate, manifest registration |
| [runtime.md](./runtime.md) | Runtime request flow — Hono, middleware chain, routes, rendering |
| [hooks-components.md](./hooks-components.md) | Hooks, components, and client-side code |
| [plugins-clients.md](./plugins-clients.md) | Fresh plugins, client-side invoke proxy, formdata utils |
| [site-usage.md](./site-usage.md) | How a Deco site uses the framework — osklenbr as reference |
| [deco-vs-deco-start.md](./deco-vs-deco-start.md) | Mapping deco-cx/deco (Fresh) → @decocms/start (TanStack) |

# deco-cx/deco Core Architecture

Reference for the `deco-cx/deco` repository — the core Deco framework powering Fresh/Deno storefronts.

## Repository Overview

```
deco/
├── mod.ts               # Main entry — re-exports engine, runtime, blocks, context
├── mod.web.ts           # Web/client entry — invoke proxy, stream reader
├── deco.ts              # DecoContext, RequestContext, AsyncLocalStorage bindings
├── live.ts              # Re-export of deco.ts (legacy alias)
├── types.ts             # DecoManifest, DecoState, block type constants
├── deps.ts              # External deps (OpenTelemetry, std, durable, inspect)
├── deno.json            # v1.177.5 — imports, exports, tasks
│
├── engine/              # Resolution engine (45 files)
│   ├── core/            # Resolver, Resolvable, resolve pipeline
│   ├── manifest/        # Manifest builder, generation, defaults
│   ├── decofile/        # State providers (filesystem, JSON, realtime)
│   ├── schema/          # JSON Schema generation and introspection
│   └── importmap/       # Import map builder for blocks
│
├── blocks/              # Block definitions (15 files)
│   ├── section.ts       # UI components with optional loader/action
│   ├── loader.ts        # Data fetching blocks (cached, single-flight)
│   ├── action.ts        # Mutation blocks
│   ├── handler.ts       # HTTP request handlers
│   ├── flag.ts          # Feature flags
│   ├── matcher.ts       # Audience targeting predicates
│   ├── page.tsx         # Page-level sections
│   ├── app.ts           # App containers with manifest + state
│   ├── workflow.ts      # Durable workflows
│   └── function.ts      # Legacy loader format
│
├── runtime/             # Request handling (51 files)
│   ├── mod.ts           # Deco class — main runtime entry
│   ├── handler.tsx      # Hono app setup, route registration
│   ├── middleware.ts     # Middleware chain (liveness, state, o11y, response)
│   ├── routes/          # Built-in routes (/live/invoke, /deco/render, etc.)
│   ├── features/        # Invoke, render, meta, preview, styles
│   ├── fresh/           # Fresh framework plugin + Bindings
│   ├── htmx/            # HTMX framework (alternative renderer)
│   ├── fetch/           # Instrumented fetch (logging, caching)
│   └── caches/          # LRU, Redis, tiered, filesystem caches
│
├── hooks/               # Server-side hooks (6 files)
├── components/          # Framework components (5 files)
├── plugins/             # Fresh plugins (3 files)
├── clients/             # Client-side invoke proxy (3 files)
├── commons/             # JWT, workflows
├── utils/               # HTTP, cookies, timings, invoke helpers
├── observability/       # OpenTelemetry instrumentation
├── daemon/              # Sidecar/embedded daemon for dev
├── dev/                 # Dev server utilities
├── hypervisor/          # Multi-site orchestration
└── scripts/             # Release, dev, bundle scripts
```

## Core Concepts

### 1. Everything is a Resolvable

The fundamental unit in Deco is a **Resolvable** — an object with a `__resolveType` field pointing to a resolver:

```typescript
// A resolvable stored in the decofile (CMS state)
{
  "__resolveType": "site/loaders/productList.ts",
  "query": "shoes",
  "count": 12
}
```

The engine recursively resolves all props, then invokes the matching resolver function.

### 2. Blocks define the type system

Each block type (section, loader, action, etc.) defines how modules are adapted into resolvers:

- **section** → wraps a Preact component, adding SSR + optional data loading
- **loader** → wraps a function with caching, single-flight dedup, and tracing
- **action** → wraps a mutation function with tracing
- **handler** → produces an HTTP handler from config
- **matcher** → evaluates a predicate against request context
- **flag** → combines matchers with variants for feature flags
- **app** → bundles manifest + state + dependencies

### 3. DecofileProvider manages state

The decofile is the CMS state — a `Record<string, Resolvable>`. Providers can be:
- **Filesystem** (`newFsProvider`) — reads from local `.json`/`.jsonl` files
- **Realtime** — connects to CMS websocket for live updates
- **JSON** — static in-memory state

### 4. Request flow

```
Request → Hono
  → bindings middleware (RENDER_FN, GLOBALS)
  → liveness probe (/deco/_liveness)
  → state builder (prepareState, debug, echo)
  → observability (OpenTelemetry trace/span)
  → main middleware (CORS, headers, cache, segment)
  → route matching:
      /styles.css        → tailwind CSS
      /live/_meta         → schema + manifest
      /live/invoke/*      → single/batch invoke
      /deco/render        → partial section render
      * (catch-all)       → page handler → resolve → render
```

### 5. Two rendering frameworks

| Framework | Islands | Partials | Usage |
|-----------|---------|----------|-------|
| **Fresh** | Preact islands | `<Partial>` + `f-partial` | Standard Deco sites |
| **HTMX** | None (no JS) | `hx-get/hx-swap` | Lightweight alternative |

### 6. Invoke system

Client-side code calls server loaders/actions via the invoke API:

```typescript
// Client-side (runtime.ts in a site)
import { proxy } from "@deco/deco/web";
const invoke = proxy<Manifest>();

// Calls POST /live/invoke/site/loaders/productList.ts
const products = await invoke["site/loaders/productList.ts"]({ query: "shoes" });
```

## Key Exports

### `mod.ts` (main)
- `Context` — AsyncLocalStorage-based context
- `$live`, `initContext`, `newContext` — engine initialization
- `Deco`, `PageData` — runtime class and page data type
- `Block`, `BlockFunc`, `Resolvable`, `Resolved` — type system
- `asResolved`, `isDeferred`, `isResolvable` — resolution utilities
- `allowCorsFor` — CORS utility
- `JsonViewer`, `Framework` — components

### `mod.web.ts` (client)
- `proxy`, `withManifest`, `forApp` — invoke proxy builders
- `readFromStream` — SSE stream reader
- `InvokeAwaiter` — chainable invoke proxy

### `deco.ts` (context)
- `DecoContext` — site, siteId, deploymentId, platform, release, runtime
- `RequestContext` — signal, framework
- `Context.active()` — current context
- `Context.bind(ctx, fn)` — run fn with context

## Dependencies

- **Runtime**: Deno, Fresh 1.6.8, Preact 10.23.1
- **Observability**: OpenTelemetry (api, sdk-trace, sdk-metrics, sdk-logs)
- **Framework**: Hono (HTTP router)
- **Deco ecosystem**: `@deco/durable`, `@deco/inspect-vscode`, `@deco/warp`
- **Std**: `@std/assert`, `@std/async`, `@std/crypto`, `@std/encoding`, `@std/http`
- **Compiler**: `jsx: "react-jsx"`, `jsxImportSource: "preact"`
