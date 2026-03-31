---
name: deco-to-tanstack-migration
description: Consolidated migration skill for Deco storefronts. Phase-based playbook for Fresh/Preact/Deno to TanStack Start/React/Cloudflare Workers. Covers all phases from scaffold to async rendering, plus post-migration patterns, hydration fixes, navigation, search, matchers, and islands elimination. Single entry point — all deep-dive content in references/.
---

# Deco-to-TanStack-Start Migration Playbook

Phase-based playbook for converting `deco-sites/*` storefronts from Fresh/Preact/Deno to TanStack Start/React/Cloudflare Workers. Battle-tested on espacosmart-storefront (100+ sections, VTEX, async rendering).

## Architecture Boundaries

| Layer | npm Package | Purpose | Must NOT Contain |
|-------|-------------|---------|-----------------|
| **@decocms/start** | `@decocms/start` | CMS resolution, DecoPageRenderer, worker entry, sdk (useScript, signal, clx) | Preact shims, widget types, site-specific maps |
| **@decocms/apps** | `@decocms/apps` | VTEX/Shopify loaders, commerce types, commerce sdk (useOffer, formatPrice, analytics) | Passthrough HTML components, Preact/Fresh refs |
| **Site repo** | (not published) | All UI: components, hooks, types, routes, styles | No compat/ layer, no aliases beyond `~` |

### Architecture Map

| Old Stack | New Stack |
|-----------|-----------|
| Deno + Fresh | Node + TanStack Start |
| Preact + Islands | React 19 + React Compiler |
| @preact/signals | @tanstack/store + @tanstack/react-store |
| Deco CMS runtime | Static JSON blocks via @decocms/start |
| $fresh/runtime.ts | Inlined (asset() removed, IS_BROWSER inlined) |
| @deco/deco/* | @decocms/start/sdk/* or inline stubs |
| apps/commerce/types | @decocms/apps/commerce/types |
| apps/website/components/* | ~/components/ui/* (local React) |
| apps/{platform}/hooks/* | ~/hooks/useCart (real implementation) |
| ~/sdk/useOffer | @decocms/apps/commerce/sdk/useOffer |
| ~/sdk/useScript | @decocms/start/sdk/useScript |
| ~/sdk/signal | @decocms/start/sdk/signal |

## Migration Phases

Each phase has entry/exit criteria. Follow in order. Automation % indicates how much can be done with bulk sed/grep.

| Phase | Name | Automation | Reference |
|-------|------|-----------|-----------|
| [0](#phase-0--scaffold) | Scaffold & Copy | 100% | `templates/` |
| [1](#phase-1--imports--jsx) | Import Rewrites | ~90% | `references/imports/` |
| [2](#phase-2--signals--state) | Signals & State | ~50% | `references/signals/` |
| [3](#phase-3--deco-framework) | Deco Framework Elimination | ~80% | `references/deco-framework/` |
| [4](#phase-4--commerce--types) | Commerce Types & UI | ~70% | `references/commerce/` |
| [5](#phase-5--platform-hooks) | Platform Hooks | 0% | `references/platform-hooks/` |
| [6](#phase-6--islands-elimination) | Islands Elimination | ~60% | `references/islands.md` |
| [7](#phase-7--section-registry) | Section Registry & Setup | 0% | `references/async-rendering.md` |
| [8](#phase-8--routes--cms) | Routes & CMS | template | `references/navigation.md` |
| [9](#phase-9--worker-entry) | Worker Entry & Server | template | `references/worker-cloudflare.md` |
| [10](#phase-10--matchers) | Matchers | ~40% | `references/matchers.md` |
| [11](#phase-11--async-rendering) | Async Rendering & Polish | 0% | `references/async-rendering.md` |
| [12](#phase-12--search) | Search | 0% | `references/search.md` |

---

### Phase 0 — Scaffold

**Entry**: Source site accessible, @decocms/start + @decocms/apps published

**Actions**:
1. Create TanStack Start project
2. Copy `src/components/`, `src/sections/`, `src/islands/`, `src/hooks/`, `src/sdk/`, `src/loaders/` from source
3. Copy `.deco/blocks/` (CMS content)
4. Copy `static/` assets
5. Create `package.json` — see `templates/package-json.md`
6. Create `vite.config.ts` — see `templates/vite-config.md`
7. `npm install`

**Exit**: Empty project builds with `npm run build`

---

### Phase 1 — Imports & JSX

**Entry**: Source files copied to `src/`

**Actions** (bulk sed — see `references/codemod-commands.md`):
1. Preact → React: `from "preact/hooks"` → `from "react"`, etc.
2. `ComponentChildren` → `ReactNode`
3. `class=` → `className=` in JSX
4. SVG attrs: `stroke-width` → `strokeWidth`, `fill-rule` → `fillRule`, etc.
5. HTML attrs: `for=` → `htmlFor=`, `fetchpriority` → `fetchPriority`
6. Remove `/** @jsxRuntime automatic */` pragma comments

**Verification**: `grep -r 'from "preact' src/ | wc -l` → 0

**Exit**: Zero preact imports, zero `class=` in JSX

See: `references/imports/README.md`, `references/jsx-migration.md`

---

### Phase 2 — Signals & State

**Entry**: Phase 1 complete

**Actions**:
1. Bulk: `from "@preact/signals"` → `from "@decocms/start/sdk/signal"` (module-level signals)
2. Manual: `useSignal(val)` → `useState(val)` (component hooks)
3. Manual: `useComputed(() => expr)` → `useMemo(() => expr, [deps])` (component hooks)
4. For global reactive state: use `signal()` from `@decocms/start/sdk/signal` + `useStore()` from `@tanstack/react-store`

**Verification**: `grep -r '@preact/signals' src/ | wc -l` → 0

**Exit**: Zero @preact/signals imports

See: `references/signals/README.md`, `references/react-signals-state.md`

---

### Phase 3 — Deco Framework

**Entry**: Phase 2 complete

**Actions** (mostly bulk sed):
1. Remove `$fresh/runtime.ts` imports (`asset()` → identity, `IS_BROWSER` → `typeof window !== "undefined"`)
2. `from "deco-sites/SITENAME/"` → `from "~/"`
3. `from "$store/"` → `from "~/"`
4. `from "site/"` → `from "~/"`
5. `SectionProps` → inline type
6. `useScript` → `from "@decocms/start/sdk/useScript"`
7. `clx` → `from "@decocms/start/sdk/clx"`

**Verification**: `grep -rE 'from "(@deco/deco|\$fresh|deco-sites/)' src/ | wc -l` → 0

**Exit**: Zero @deco/deco, $fresh, deco-sites/ imports

See: `references/deco-framework/README.md`

---

### Phase 4 — Commerce & Types

**Entry**: Phase 3 complete

**Actions**:
1. `from "apps/commerce/types.ts"` → `from "@decocms/apps/commerce/types"`
2. `from "apps/admin/widgets.ts"` → `from "~/types/widgets"` (create local file)
3. `from "apps/website/components/Image.tsx"` → `from "~/components/ui/Image"` (create local)
4. SDK utilities: `~/sdk/useOffer` → `@decocms/apps/commerce/sdk/useOffer`, etc.

**Verification**: `grep -r 'from "apps/' src/ | wc -l` → 0

**Exit**: Zero `apps/` imports

See: `references/commerce/README.md`, `references/vtex-commerce.md`

---

### Phase 5 — Platform Hooks

**Entry**: Phase 4 complete

**Actions** (manual implementation):
1. Create `src/hooks/useCart.ts` — module-level singleton + listener pattern
2. Create `src/hooks/useUser.ts`, `src/hooks/useWishlist.ts` (stubs or real)
3. Wire VTEX API calls via `@decocms/apps` invoke functions

**Exit**: Cart add/remove works, no `apps/{platform}/hooks` imports

See: `references/platform-hooks/README.md`

---

### Phase 6 — Islands Elimination

**Entry**: Phase 5 complete

**Actions**:
1. Audit `src/islands/` — categorize each file:
   - **Wrapper**: just re-exports from `components/` → delete, repoint imports
   - **Standalone**: has real logic → move to `src/components/`
2. Update all imports pointing to `islands/` to point to `components/`
3. Delete `src/islands/` directory

**Verification**: `ls src/islands/ 2>/dev/null` → directory not found

**Exit**: No islands/ directory

See: `references/islands.md`

---

### Phase 7 — Section Registry

**Entry**: Phase 6 complete

**Actions** (critical — build `src/setup.ts`):
1. Register all sections via `registerSections()` with dynamic imports
2. Register critical sections (Header, Footer) via `registerSectionsSync()` + `setResolvedComponent()`
3. Register section loaders via `registerSectionLoaders()`
4. Register layout sections via `registerLayoutSections()`
5. Register commerce loaders via `registerCommerceLoaders()` with SWR caching
6. Wire `onBeforeResolve()` → `initVtexFromBlocks()` for VTEX config
7. Configure `setAsyncRenderingConfig()` with `alwaysEager` for critical sections
8. Configure admin: `setMetaData()`, `setRenderShell()`, `setInvokeLoaders()`

**Template**: `templates/setup-ts.md`

**Exit**: `setup.ts` compiles, all sections registered

See: `references/async-rendering.md` (Part 2: Site Implementation)

---

### Phase 8 — Routes & CMS

**Entry**: Phase 7 complete

**Actions**:
1. Create `src/router.tsx` with scroll restoration
2. Create `src/routes/__root.tsx` with QueryClient, LiveControls, NavigationProgress, analytics
3. Create `src/routes/index.tsx` using `cmsHomeRouteConfig()`
4. Create `src/routes/$.tsx` using `cmsRouteConfig()`

**Templates**: `templates/root-route.md`, `templates/router.md`

**Exit**: Routes compile, CMS pages resolve

See: `references/navigation.md`

---

### Phase 9 — Worker Entry

**Entry**: Phase 8 complete

**Actions**:
1. Create `src/server.ts` — **CRITICAL: `import "./setup"` MUST be the first line**
2. Create `src/worker-entry.ts` — same: `import "./setup"` first
3. Wire admin handlers (handleMeta, handleDecofileRead, handleRender)
4. Wire VTEX proxy if needed

**Template**: `templates/worker-entry.md`

**CRITICAL**: Without `import "./setup"` as the first import, server functions in Vite split modules will have empty state. This causes 404 on client-side navigation.

**Exit**: `npm run dev` serves pages, admin endpoints work

See: `references/worker-cloudflare.md`

---

### Phase 10 — Matchers

**Entry**: Phase 9 complete

**Actions**:
1. Audit existing matchers (check `src/matchers/`, `src/sdk/matcher*`)
2. Migrate MatchContext → MatcherContext (different shape)
3. Register matchers in `setup.ts` via `registerMatcher()`
4. Wire CF geo cookie injection if using location matchers

**Exit**: All matchers registered, flags/variants work

See: `references/matchers.md`

---

### Phase 11 — Async Rendering

**Entry**: Phase 10 complete (site builds and serves pages)

**Actions**:
1. Identify lazy sections from CMS Lazy wrappers
2. Add `export function LoadingFallback()` to lazy sections
3. Configure `registerCacheableSections()` for SWR on heavy sections
4. Test deferred section loading on scroll

**Exit**: Above-the-fold renders instantly, below-fold loads on scroll

See: `references/async-rendering.md`

---

### Phase 12 — Search

**Entry**: Phase 11 complete

**Actions**:
1. Wire search route with `loaderDeps` for URL params (`q`, `sort`, `page`, filters)
2. Configure VTEX Intelligent Search loader
3. Wire SearchBar autocomplete via server function
4. Test filter toggling, pagination, sort

**Exit**: Search page works end-to-end

See: `references/search.md`

---

## Post-Migration

| Problem | Reference |
|---------|-----------|
| Hydration mismatches, flash-of-white, CLS | `references/hydration-fixes.md` |
| Runtime bugs, nested sections, VTEX resilience | `references/storefront-patterns.md` |
| CSS / Tailwind / DaisyUI issues | `references/css-styling.md` |
| Admin / CMS integration issues | `references/admin-cms.md` |
| React hooks patterns | `references/react-hooks-patterns.md` |
| All indexed gotchas | `references/gotchas.md` |

## Key Principles

1. **No compat layer anywhere** -- not in `@decocms/start`, not in `@decocms/apps`, not in the site repo
2. **Replace, don't wrap** -- change the import to the real thing, don't create a pass-through
3. **Types from the library, UI from the site** -- `Product` type comes from `@decocms/apps/commerce/types`, but the `<Image>` component is site-local
4. **One Vite alias maximum** -- `"~"` -> `"src/"` is the only acceptable alias
5. **`tsconfig.json` mirrors `vite.config.ts`** -- only `"~/*": ["./src/*"]` in paths
6. **Signals don't auto-subscribe in React** -- reading `signal.value` in render creates NO subscription; use `useStore(signal.store)` from `@tanstack/react-store`
7. **Commerce loaders need request context** -- `resolve.ts` must pass URL/path to PLP/PDP loaders
8. **`wrangler.jsonc` main must be a custom worker-entry** -- TanStack Start ignores `export default` in `server.ts`
9. **Copy components faithfully, never rewrite** -- `cp` the original, then only change mechanical things (class→className, imports). NEVER regenerate or "improve" — AI-rewritten components are the #1 source of visual regressions
10. **Tailwind v4 logical property hazard** -- mixed `px-*` + `pl-*/pr-*` on the same element breaks the cascade
11. **oklch CSS variables need triplets, not hex** -- `oklch(var(--x))` must store variables as oklch triplets
12. **Verify ALL imports resolve at runtime, not just build** -- Vite tree-shakes dead imports, so `npm run build` passes even with missing modules
13. **`import "./setup"` first** — in both `server.ts` and `worker-entry.ts`
14. **globalThis for split modules** — Vite server function split modules need `globalThis.__deco` to share state

## Worker Entry Architecture

Admin routes MUST be handled in `createDecoWorkerEntry` (the outermost wrapper), NOT inside TanStack's `createServerEntry`. Vite strips custom logic from `createServerEntry` in production.

```
Request
  └─> createDecoWorkerEntry(serverEntry, { admin: { ... } })
        ├─> tryAdminRoute()             ← FIRST: /live/_meta, /.decofile, /live/previews/*
        ├─> cache purge check            ← __deco_purge_cache
        ├─> static asset bypass          ← /assets/*, favicon, sprites
        ├─> Cloudflare cache (caches.open)
        └─> serverEntry.fetch()          ← TanStack Start handles everything else
```

Key rules:
- `./setup` MUST be imported first
- Admin handlers passed as options, NOT imported inside `createDecoWorkerEntry`
- `/live/` and `/.decofile` are in `DEFAULT_BYPASS_PATHS` -- never cached

## Conductor / AI Bulk Migration Workflow

For sites with 100+ sections:

1. **Scaffold + Copy** (human): scaffold project, `cp -r src/`, set up config files
2. **Mechanical Rewrites** (AI/conductor): bulk import rewrites, JSX attr rewrites, type rewrites, signal-to-state — see `references/codemod-commands.md`
3. **Verify** (human + AI): `npx tsc --noEmit`, `npm run build`, `npm run dev` + browser test, visual comparison
4. **Fix Runtime Issues** (human-guided): gotchas and architectural differences

**Key Insight**: The approach that worked (836 errors → 0 across 213 files) treated every file as: copy the original, apply mechanical changes only. Never "rewrite in React".

## Reference Index

| Topic | Path |
|-------|------|
| Preact → React imports | `references/imports/` |
| Signals → TanStack Store | `references/signals/` |
| Deco framework elimination | `references/deco-framework/` |
| Commerce & widget types | `references/commerce/` |
| Platform hooks (VTEX) | `references/platform-hooks/` |
| Vite configuration | `references/vite-config/` |
| Automation commands | `references/codemod-commands.md` |
| Islands elimination | `references/islands.md` |
| Navigation & routing | `references/navigation.md` |
| Search implementation | `references/search.md` |
| Matchers (architecture + migration) | `references/matchers.md` |
| Async rendering (architecture + site guide) | `references/async-rendering.md` |
| Hydration fixes | `references/hydration-fixes.md` |
| Runtime storefront patterns | `references/storefront-patterns.md` |
| Admin / CMS integration | `references/admin-cms.md` |
| Gotchas index | `references/gotchas.md` |
| React hooks patterns | `references/react-hooks-patterns.md` |
| React signals & state | `references/react-signals-state.md` |
| JSX migration differences | `references/jsx-migration.md` |
| VTEX commerce gotchas | `references/vtex-commerce.md` |
| Worker / Cloudflare / build | `references/worker-cloudflare.md` |
| CSS / Tailwind / DaisyUI | `references/css-styling.md` |
| setup.ts template | `templates/setup-ts.md` |
| vite.config.ts template | `templates/vite-config.md` |
| worker-entry template | `templates/worker-entry.md` |
| __root.tsx template | `templates/root-route.md` |
| router.tsx template | `templates/router.md` |
| package.json template | `templates/package-json.md` |
