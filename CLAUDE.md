# CLAUDE.md

Guidance for AI assistants working with `@decocms/start`.

## Project Overview

`@decocms/start` is the framework layer for Deco storefronts built on **TanStack Start + React 19 + Cloudflare Workers**. It provides CMS block resolution, admin protocol handlers, section rendering, schema generation, and edge caching infrastructure.

**Not a storefront itself** — this is the npm package that storefronts depend on.

## Tech Stack

- Runtime: Cloudflare Workers (Node compat)
- Framework: TanStack Start / TanStack Router
- UI: React 19 + React Compiler
- State: @tanstack/store + @tanstack/react-store
- Build: Vite
- Published as: `@decocms/start` on GitHub Packages

## Common Commands

```bash
npm run build        # tsc — compile to dist/
npm run typecheck    # tsc --noEmit
```

No dev server — this is a library. Consumers run their own `vite dev`.

## Architecture

```
src/
├── admin/           # Admin protocol: meta, decofile, invoke, render, schema, CORS, setup
├── cms/             # Block loading, page resolution, section registry
├── hooks/           # DecoPageRenderer, LiveControls, LazySection, SectionErrorFallback
├── middleware/       # Observability, deco state, liveness probe
├── sdk/             # Worker entry, caching, useScript, signal, clx, analytics, redirects, sitemap
├── matchers/        # PostHog, built-in feature flag matchers
├── types/           # FnContext, App, Section, SectionProps, widgets
└── index.ts         # Barrel export
scripts/
├── generate-blocks.ts   # Scans site src/ for sections/loaders -> blocks.gen.ts
└── generate-schema.ts   # Extracts TypeScript props -> JSON Schema (meta.gen.json)
```

### Package Exports (from package.json)

Every export maps to a source file — no dist indirection:

| Import path | File |
|-------------|------|
| `@decocms/start` | `src/index.ts` |
| `@decocms/start/admin` | `src/admin/index.ts` |
| `@decocms/start/cms` | `src/cms/index.ts` |
| `@decocms/start/hooks` | `src/hooks/index.ts` |
| `@decocms/start/sdk/workerEntry` | `src/sdk/workerEntry.ts` |
| `@decocms/start/sdk/cacheHeaders` | `src/sdk/cacheHeaders.ts` |
| `@decocms/start/sdk/cachedLoader` | `src/sdk/cachedLoader.ts` |
| `@decocms/start/sdk/useScript` | `src/sdk/useScript.ts` |
| `@decocms/start/sdk/signal` | `src/sdk/signal.ts` |
| `@decocms/start/sdk/clx` | `src/sdk/clx.ts` |
| ... | (see `package.json` exports for full list) |

### Three-Layer Architecture

| Layer | Package | Responsibility |
|-------|---------|---------------|
| **@decocms/start** | This repo | Framework: CMS bridge, admin protocol, worker entry, caching, rendering |
| **@decocms/apps** | `decocms/apps-start` | Commerce: VTEX/Shopify loaders, types, SDK (useOffer, formatPrice) |
| **Site repo** | Not published | UI: components, hooks, routes, styles, contexts |

### Key Boundaries

- `@decocms/start` must NOT contain: Preact references, widget type aliases, site-specific section maps, commerce API calls
- `@decocms/apps` must NOT contain: UI components (Image, Picture), hook stubs, Preact/Fresh references
- Site repo must NOT contain: `compat/` directories, Vite aliases beyond `~` -> `src/`

## Worker Entry (`src/sdk/workerEntry.ts`)

The outermost Cloudflare Worker wrapper. Request flow:

```
Request → createDecoWorkerEntry(serverEntry, options)
  ├─ tryAdminRoute()        ← /live/_meta, /.decofile, /live/previews/*
  ├─ cache purge check      ← __deco_purge_cache
  ├─ static asset bypass    ← /assets/*, favicon, sprites
  ├─ Cloudflare edge cache  ← caches.open() with profile-based TTLs
  └─ serverEntry.fetch()    ← TanStack Start handles the rest
```

Admin routes MUST be handled here, NOT inside TanStack's `createServerEntry` — Vite strips custom fetch logic from server entries in production builds.

## Edge Caching (`src/sdk/cacheHeaders.ts`)

Built-in URL-to-profile detection:

| URL Pattern | Profile | Edge TTL |
|-------------|---------|----------|
| `/` | static | 1 day |
| `*/p` | product | 5 min |
| `/s`, `?q=` | search | 60s |
| `/cart`, `/checkout` | private | none |
| Everything else | listing | 2 min |

Cache API ignores `s-maxage` — the worker stores with `max-age` equal to `sMaxAge` as a workaround.

## Admin Protocol

The admin (admin.deco.cx) communicates with self-hosted storefronts via:

- `GET /live/_meta` — JSON Schema + manifest (with content-hash ETag)
- `GET /.decofile` — site content blocks
- `POST /deco/render` — section/page preview in iframe
- `POST /deco/invoke` — loader/action execution

Schema is composed at runtime: `generate-schema.ts` produces section schemas, `composeMeta()` in `src/admin/schema.ts` injects page schemas and framework definitions.

## Migration Guide

Detailed migration playbook from Fresh/Preact/Deno to TanStack Start/React/Workers is available at `.cursor/skills/deco-to-tanstack-migration/`. Covers:

- Import rewrites (Preact → React, @preact/signals → @tanstack/store)
- Deco framework elimination (@deco/deco/*, $fresh/*)
- Commerce type migration
- Platform hook implementation (useCart, useUser, useWishlist)
- Vite configuration
- 18 documented gotchas

## Important Constraints

1. **No compat layers** — replace imports, don't wrap them
2. **AsyncLocalStorage** — `src/cms/loader.ts` uses it; must use namespace import (`import * as asyncHooks`) to avoid breaking Vite client builds
3. **Preview shell** — must include `data-theme="light"` for DaisyUI v4 color variables
4. **Base64 encoding** — `toBase64()` must produce padded output matching `btoa()` — admin uses `btoa()` for definition refs
5. **ETag** — content-based DJB2 hash, not string length
