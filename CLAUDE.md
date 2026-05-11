# CLAUDE.md

Guidance for AI assistants working with `@decocms/start`.

## Project Overview

`@decocms/start` is the framework layer for Deco storefronts built on **TanStack Start + React 19 + Cloudflare Workers**. It provides CMS block resolution, admin protocol handlers, section rendering, schema generation, and edge caching infrastructure.

**Not a storefront itself** — this is the npm package that storefronts depend on.

## Migration tooling policy (constitutional)

This repo also hosts the migration scripts + skills that move Deco storefronts from Fresh/Deno to TanStack Start. The work is governed by signed-off architectural decisions (D1–D5) and a strict priority order — see [`.cursor/rules/migration-tooling-policy.mdc`](./.cursor/rules/migration-tooling-policy.mdc) (always-loaded) and [`MIGRATION_TOOLING_PLAN.md`](./MIGRATION_TOOLING_PLAN.md) (full record). Defer to the plan when in doubt.

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
├── core/             # framework-agnostic. NO @tanstack/* / next/* / node:async_hooks.
│   ├── cms/          # Block loading, page resolution, registry, loadCmsPagePure
│   ├── sdk/          # Plain utilities (clx, signal, http, cookie, …)
│   ├── admin/        # Admin protocol handlers (Web API only)
│   ├── matchers/     # PostHog, built-in feature flag matchers
│   ├── types/        # FnContext, Section, MatcherContext, widgets
│   └── runtime/      # RequestStore interface (noop default)
├── tanstack/         # TanStack Start adapter (today's behavior)
│   ├── routes/       # createServerFn-wrapped loaders
│   ├── hooks/        # DecoPageRenderer, LiveControls, LazySection, …
│   ├── middleware/   # observability (ALS), decoState, hydrationContext
│   ├── sdk/          # workerEntry, router, requestContext (TanStack-coupled)
│   ├── apps/         # commerce app autoconfig
│   ├── daemon/       # dev tooling (tunnel, watch)
│   ├── vite/         # Vite plugin
│   ├── runtime/      # AlsRequestStore implementation
│   └── setup.ts      # installTanStackRuntime + legacy setup exports
├── next/             # Next.js App Router adapter
│   ├── loadCmsPage.ts
│   ├── ctx.ts
│   ├── adminRoute.ts
│   ├── DecoPage.tsx
│   └── client.ts
└── index.ts          # top-level barrel; re-exports core only
```

## Import Tiers (constitutional)

The package has three tiers, each enforced by a per-directory `biome.json` `noRestrictedImports` config and the post-build `scripts/check-tier-boundaries.ts`:

1. **`/core`**: No imports from `@tanstack/*`, `next`, `next/*`, top-level `node:async_hooks`. Pure functions; explicit-pass context.
2. **`/tanstack`**: Today's behavior. May use `@tanstack/*`, `node:async_hooks`. May import from `core/`. May NOT import from `next/`.
3. **`/next`**: Next.js (App Router) adapter. May use `next`. May import from `core/`. May NOT import from `tanstack/` or `@tanstack/*`.

When adding new files, place them in the lowest-coupling tier that satisfies their dependencies. If you reach for `@tanstack/react-start/server` inside `core/`, stop — accept the value as a function argument or use the `RequestStore` interface in `core/runtime/`.

## Build pipeline

Source `.ts` is compiled via `tsup` (JS) + `tsc` (declarations) to `dist/`. `package.json` exports point at `./dist/<path>.{js,cjs,d.ts}`. Source `.ts` files do NOT ship to npm. Run `bun run build` locally to produce `dist/`.

## Release pipeline

Two channels via semantic-release. The decision tree for which one to target lives in [`.agents/skills/decocms-start-release-workflow/SKILL.md`](./.agents/skills/decocms-start-release-workflow/SKILL.md) — read it before opening a PR.

- **`main` → `@decocms/start@latest`** (e.g. `5.2.0`). Default for all consumers via `^` ranges. Routine fixes go here.
- **`next` → `@decocms/start@next`** (e.g. `5.2.0-next.3`). Opt-in via `bun add @decocms/start@next`. Use for risky / behavior-changing / breaking work that benefits from a customer validating first. Promote to stable by opening a PR `next` → `main`.

Hard rules: never push directly to `main` or `next`; never run `npm publish` locally; never include the canonical GitHub-Actions CI-skip token (the one documented at `.github/workflows/release.yml:3-21`) in a PR title or body targeting either branch — it silently suppresses the release workflow.

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

Detailed migration playbook from Fresh/Preact/Deno to TanStack Start/React/Workers is available at `.agents/skills/deco-to-tanstack-migration/` (the canonical location — also surfaced as a Cursor skill via the `.agents/` skills root). Covers:

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
