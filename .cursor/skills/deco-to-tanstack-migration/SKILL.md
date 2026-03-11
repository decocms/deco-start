---
name: deco-to-tanstack-migration
description: Migrate Deco.cx storefronts from Fresh/Preact to TanStack Start/React on Cloudflare Workers. Phase-based playbook with automation scripts, battle-tested templates, and cross-references to specialized skills. Use when migrating a deco-site, porting Preact components to React, or setting up TanStack Start for a Deco storefront.
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

| Phase | Name | Automation | Related Skill |
|-------|------|-----------|---------------|
| [0](#phase-0--scaffold) | Scaffold & Copy | 100% | — |
| [1](#phase-1--imports--jsx) | Import Rewrites | ~90% | — |
| [2](#phase-2--signals--state) | Signals & State | ~50% | — |
| [3](#phase-3--deco-framework) | Deco Framework Elimination | ~80% | — |
| [4](#phase-4--commerce--types) | Commerce Types & UI | ~70% | deco-apps-vtex-porting |
| [5](#phase-5--platform-hooks) | Platform Hooks | 0% | deco-apps-vtex-porting |
| [6](#phase-6--islands-elimination) | Islands Elimination | ~60% | deco-islands-migration |
| [7](#phase-7--section-registry) | Section Registry & Setup | 0% | deco-async-rendering-site-guide |
| [8](#phase-8--routes--cms) | Routes & CMS | template | deco-tanstack-navigation |
| [9](#phase-9--worker-entry) | Worker Entry & Server | template | deco-edge-caching |
| [10](#phase-10--async-rendering) | Async Rendering & Polish | 0% | deco-async-rendering-site-guide |

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
5. HTML attrs: `for=` → `htmlFor=`, `fetchpriority` → `fetchPriority`, `autocomplete` → `autoComplete`
6. Remove `/** @jsxRuntime automatic */` pragma comments

**Verification**: `grep -r 'from "preact' src/ | wc -l` → 0

**Exit**: Zero preact imports, zero `class=` in JSX

See: `references/imports/README.md`

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

See: `references/signals/README.md`

---

### Phase 3 — Deco Framework

**Entry**: Phase 2 complete

**Actions** (mostly bulk sed):
1. Remove `$fresh/runtime.ts` imports (`asset()` → identity, `IS_BROWSER` → `typeof window !== "undefined"`)
2. `from "deco-sites/SITENAME/"` → `from "~/"`
3. `from "$store/"` → `from "~/"`
4. `from "site/"` → `from "~/"`
5. `SectionProps` → inline type or `import { SectionProps } from "~/types/section"`
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
2. `from "apps/admin/widgets.ts"` → `from "~/types/widgets"` (create local file with string aliases)
3. `from "apps/website/components/Image.tsx"` → `from "~/components/ui/Image"` (create local components)
4. SDK utilities: `~/sdk/useOffer` → `@decocms/apps/commerce/sdk/useOffer`, `~/sdk/format` → `@decocms/apps/commerce/sdk/formatPrice`, etc.

**Verification**: `grep -r 'from "apps/' src/ | wc -l` → 0

**Exit**: Zero `apps/` imports

See: `references/commerce/README.md`

---

### Phase 5 — Platform Hooks

**Entry**: Phase 4 complete

**Actions** (manual implementation):
1. Create `src/hooks/useCart.ts` — module-level singleton + listener pattern
2. Create `src/hooks/useUser.ts`, `src/hooks/useWishlist.ts` (stubs or real)
3. Wire VTEX API calls via `@decocms/apps` invoke functions

**Pattern**: Closure state + `_listeners` Set + `useState` for re-renders. See espacosmart's useCart.ts as template.

**Exit**: Cart add/remove works, no `apps/{platform}/hooks` imports

See: `references/platform-hooks/README.md`, skill `deco-apps-vtex-porting`

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

See: skill `deco-islands-migration`

---

### Phase 7 — Section Registry

**Entry**: Phase 6 complete

**Actions** (critical — build `src/setup.ts`):
1. Register all sections via `registerSections()` with dynamic imports
2. Register critical sections (Header, Footer) via `registerSectionsSync()` + `setResolvedComponent()`
3. Register section loaders via `registerSectionLoaders()` for sections with `export const loader`
4. Register layout sections via `registerLayoutSections()`
5. Register commerce loaders via `registerCommerceLoaders()` with SWR caching
6. Wire `onBeforeResolve()` → `initVtexFromBlocks()` for VTEX config
7. Configure `setAsyncRenderingConfig()` with `alwaysEager` for critical sections
8. Configure admin: `setMetaData()`, `setRenderShell()`, `setInvokeLoaders()`

**Template**: `templates/setup-ts.md`

**Exit**: `setup.ts` compiles, all sections registered

See: skill `deco-async-rendering-site-guide`

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

See: skill `deco-tanstack-navigation`

---

### Phase 9 — Worker Entry

**Entry**: Phase 8 complete

**Actions**:
1. Create `src/server.ts` — **CRITICAL: `import "./setup"` MUST be the first line**
2. Create `src/worker-entry.ts` — same: `import "./setup"` first
3. Wire admin handlers (handleMeta, handleDecofileRead, handleRender)
4. Wire VTEX proxy if needed

**Template**: `templates/worker-entry.md`

**CRITICAL**: Without `import "./setup"` as the first import, server functions in Vite split modules will have empty state (blocks, registry, commerce loaders). This causes 404 on client-side navigation.

**Exit**: `npm run dev` serves pages, admin endpoints work

See: skill `deco-edge-caching`

---

### Phase 10 — Async Rendering

**Entry**: Phase 9 complete (site builds and serves pages)

**Actions**:
1. Identify lazy sections from CMS Lazy wrappers
2. Add `export function LoadingFallback()` to lazy sections
3. Configure `registerCacheableSections()` for SWR on heavy sections
4. Test deferred section loading on scroll

**Exit**: Above-the-fold renders instantly, below-fold loads on scroll

See: skill `deco-async-rendering-site-guide`

---

## Post-Migration Verification

```bash
# 1. Build
npm run build

# 2. Zero old imports
grep -rE 'from "(preact|@preact|@deco/deco|\$fresh|deco-sites/|apps/)' src/ | wc -l
# Expected: 0

# 3. Dev server
npm run dev

# 4. SSR test — load homepage via F5
# 5. Client nav — click links, verify no 404
# 6. Console — no hydration warnings, no missing keys
# 7. Deferred — scroll down, sections load on scroll
# 8. Admin — /deco/meta returns JSON, /live/previews works
```

## Key Principles

1. **No compat layer anywhere** -- not in `@decocms/start`, not in `@decocms/apps`, not in the site repo
2. **Replace, don't wrap** -- change the import to the real thing, don't create a pass-through
3. **Types from the library, UI from the site** -- `Product` type comes from `@decocms/apps/commerce/types`, but the `<Image>` component is site-local
4. **One Vite alias maximum** -- `"~"` -> `"src/"` is the only acceptable alias in a finished migration
5. **`tsconfig.json` mirrors `vite.config.ts`** -- only `"~/*": ["./src/*"]` in paths
6. **Signals don't auto-subscribe in React** -- reading `signal.value` in render creates NO subscription; use `useStore(signal.store)` from `@tanstack/react-store`
7. **Commerce loaders need request context** -- `resolve.ts` must pass URL/path to PLP/PDP loaders for search, categories, sort, and pagination to work
8. **`wrangler.jsonc` main must be a custom worker-entry** -- TanStack Start ignores `export default` in `server.ts`; create a separate `worker-entry.ts` and point wrangler to it
9. **Copy components faithfully, never rewrite** -- `cp` the original file, then only change: `class` → `className`, `for` → `htmlFor`, import paths (`apps/` → `~/`, `$store/` → `~/`), `preact` → `react`. NEVER regenerate, "clean up", or "improve" the component. AI-rewritten components are the #1 source of visual regressions -- the layout, grid classes, responsive variants, and conditional logic must be byte-identical to the original except for the mechanical migration changes
10. **Tailwind v4 logical property hazard** -- mixed `px-*` + `pl-*/pr-*` on the same element breaks the cascade. Replace mixed patterns with consistent longhand (`pl-X pr-X` instead of `px-X`) on those elements only
11. **oklch CSS variables need triplets, not hex** -- sites using `oklch(var(--x))` must store variables as oklch triplets (`100% 0.00 0deg`), not hex values. `oklch(#FFF)` is invalid CSS
12. **Verify ALL imports resolve at runtime, not just build** -- Vite tree-shakes dead imports, so `npm run build` passes even with missing modules. But `registerSections` lazy imports execute at runtime, killing entire sections silently
13. **`import "./setup"` first** — in both `server.ts` and `worker-entry.ts`
14. **globalThis for split modules** — Vite server function split modules need `globalThis.__deco` to share state

## Worker Entry Architecture

The Cloudflare Worker entry point has a strict layering. Admin routes MUST be handled in `createDecoWorkerEntry` (the outermost wrapper), NOT inside TanStack's `createServerEntry`. TanStack Start's Vite build strips custom logic from `createServerEntry` callbacks in production.

```
Request
  └─> createDecoWorkerEntry(serverEntry, { admin: { ... } })
        ├─> tryAdminRoute()             ← FIRST: /live/_meta, /.decofile, /live/previews/*
        ├─> cache purge check            ← __deco_purge_cache
        ├─> static asset bypass          ← /assets/*, favicon, sprites
        ├─> Cloudflare cache (caches.open)
        └─> serverEntry.fetch()          ← TanStack Start handles everything else
```

### Site worker-entry.ts Pattern

```typescript
import "./setup";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
import {
  handleMeta, handleDecofileRead, handleDecofileReload,
  handleRender, corsHeaders,
} from "@decocms/start/admin";

const serverEntry = createServerEntry({
  async fetch(request) {
    return await handler.fetch(request);
  },
});

export default createDecoWorkerEntry(serverEntry, {
  admin: { handleMeta, handleDecofileRead, handleDecofileReload, handleRender, corsHeaders },
});
```

Key rules:
- `./setup` MUST be imported first (registers sections, loaders, meta, render shell)
- Admin handlers are passed as options, NOT imported inside `createDecoWorkerEntry`
- `/live/` and `/.decofile` are in `DEFAULT_BYPASS_PATHS` -- never cached by the edge

### Admin Preview HTML Shell

The preview at `/live/previews/*` renders sections into an HTML shell. This shell MUST match the production `<html>` attributes for CSS frameworks to work:

```typescript
// In setup.ts
setRenderShell({
  css: appCss,          // Vite ?url import of app.css
  fonts: ["https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap"],
  theme: "light",       // -> <html data-theme="light"> (required for DaisyUI v4)
  bodyClass: "bg-base-100 text-base-content",
  lang: "pt-BR",
});
```

Without `data-theme="light"`, DaisyUI v4 theme variables (`--color-primary`, etc.) won't activate in the preview iframe, causing color mismatches vs production.

### Client-Safe vs Server-Only Imports

`@decocms/start` has two admin entry points:
- **`@decocms/start/admin`** -- server-only handlers (handleMeta, handleRender, etc.) -- these may transitively import `node:async_hooks`
- **`@decocms/start/admin/setup`** (re-exported from `@decocms/start/admin`) -- client-safe setup functions (setMetaData, setInvokeLoaders, setRenderShell) -- NO node: imports

The site's `setup.ts` can safely import from `@decocms/start/admin` because it only uses the setup functions. But the barrel export must be structured so Vite tree-shaking doesn't pull server modules into client bundles.

## Admin Self-Hosting Architecture

When a site is self-hosted (deployed to its own Cloudflare Worker), the admin communicates with the storefront via the `productionUrl`:

```
admin.deco.cx
  └─> createContentSiteSDK (when env.platform === "content" OR devContentUrl is set)
        ├─> fetch(productionUrl + "/live/_meta")     ← schema + manifest
        ├─> fetch(productionUrl + "/.decofile")      ← content blocks
        └─> iframe src = productionUrl + "/live/previews/*"  ← section preview
```

### Content URL Resolution Priority

1. `devContentUrl` URL param → saved to `localStorage[deco::devContentUrl::${site}]` → used by Content SDK
2. `devContentUrl` from localStorage → used by Content SDK
3. `site.metadata.selfHosting.productionUrl` (Supabase) → used by Content SDK
4. `https://${site}.deco.site` → fallback

### Environment Platform Gate

The admin only uses `createContentSiteSDK` when:
- `devContentUrl` is set (localStorage or URL param), OR
- The current environment has `platform: "content"`

Setting `productionUrl` in Supabase alone is NOT sufficient. The environment must be "content" platform. This happens when `connectSelfHosting` is called with a `productionUrl` -- it deletes/recreates the staging environment as `platform: "content"`.

For local dev, use the URL param shortcut:
```
https://admin.deco.cx/sites/YOUR_SITE/spaces/...?devContentUrl=http://localhost:5181
```

## Admin / CMS Schema Architecture

The deco admin (deco-cx/deco) communicates with the storefront via:
- `GET /live/_meta` -- returns full JSON Schema + manifest of block types
- `GET /.decofile` -- returns the site's content blocks
- `POST /deco/render` -- renders a section/page with given props in an iframe
- `POST /deco/invoke` -- calls a loader/action and returns JSON

### Schema Composition (`composeMeta`)

The schema generator (`scripts/generate-schema.ts`) only produces section schemas from site TypeScript files. Framework-managed block types (pages) are defined in `src/admin/schema.ts` and injected at runtime via `composeMeta()`.

```
[generate-schema.ts] --> meta.gen.json (sections only, pages: empty)
[setup.ts] --> imports meta.gen.json --> calls setMetaData(metaData)
[setMetaData] --> calls composeMeta() --> injects page schema + merges definitions
[/live/_meta] --> returns composed schema with content-hash ETag
```

Key rules:
- `toBase64()` MUST produce padded Base64 (matching `btoa()`) -- admin uses `btoa()` to construct definition refs
- Page schema uses flat properties (no allOf + @Props indirection) to minimize RJSF resolution steps
- ETag is a content-based DJB2 hash, not string length, for reliable cache invalidation
- The etag is also included in the JSON response body for admin's `metaInfo.value?.etag` cache check

### Admin Local Development

To use the deco admin with a local storefront:
1. Start admin: `cd admin && deno task play` (port 4200)
2. Start storefront: `bun run dev` (port 5181 or wherever it lands)
3. Set `devContentUrl` in admin's browser console: `localStorage.setItem('deco::devContentUrl::YOUR_SITE_NAME', 'http://localhost:PORT')`
4. Navigate to `http://localhost:4200/sites/YOUR_SITE_NAME/spaces/pages`
5. After schema changes: clear admin cache (`localStorage.removeItem('meta::YOUR_SITE_NAME')`) and hard-refresh

## Conductor / AI Bulk Migration Workflow

For sites with 100+ sections and 200+ components, manual file-by-file migration is impractical. The proven workflow:

### Phase 1: Scaffold + Copy (human)
1. Scaffold TanStack Start project
2. `cp -r` the entire `src/` from the original site
3. Set up `vite.config.ts`, `tsconfig.json`, `wrangler.jsonc`, `package.json`
4. Install dependencies

### Phase 2: Mechanical Rewrites (AI/conductor)
Let AI tackle the bulk TypeScript errors in a single pass:

1. **Import rewrites** (safe for bulk `sed`):
   - `from "preact"` → `from "react"`
   - `from "preact/hooks"` → `from "react"`
   - `from "preact/compat"` → `from "react"`
   - `from "@preact/signals"` → `from "~/sdk/signal"`
   - `from "apps/commerce/types"` → `from "@decocms/apps/commerce/types"`
   - `from "$store/"` → `from "~/"`

2. **JSX attribute rewrites** (safe for bulk):
   - `class=` → `className=` (in JSX context)
   - `for=` → `htmlFor=` (on `<label>` elements)
   - `stroke-width` → `strokeWidth`, `fill-rule` → `fillRule` (SVG)
   - Remove `data-fresh-disable-lock`

3. **Type rewrites** (per-file, AI-assisted):
   - `JSX.TargetedEvent<HTMLInputElement>` → `React.ChangeEvent<HTMLInputElement>`
   - `JSX.TargetedMouseEvent` → `React.MouseEvent`
   - `ComponentChildren` → `ReactNode`
   - `SVGAttributes<SVGSVGElement>` → `React.SVGProps<SVGSVGElement>`
   - Create consolidated type files (`~/types/vtex.ts`, `~/types/widgets.ts`)

4. **Signal-to-state** (per-file, needs judgment):
   - `useSignal(x)` → `useState(x)` with setter
   - `.value` reads → direct variable reads
   - `.value =` writes → `setState()` calls
   - Toggle: `x.value = !x.value` → `setX(prev => !prev)`

### Phase 3: Verify (human + AI)
1. `npx tsc --noEmit` — catches remaining type errors
2. `npm run build` — catches import resolution errors
3. `bun run dev` + browser test — catches runtime errors
4. Visual comparison with production — catches layout regressions

### Phase 4: Fix Runtime Issues (human-guided)
This is where gotchas 1-45 apply. The mechanical rewrite gets you to "builds clean" but runtime issues require understanding the architectural differences.

### Key Insight: Never Rewrite, Only Port

The conductor approach that worked (836 errors → 0 across 213 files) treated every file as: **copy the original, apply mechanical changes only**. The failed approach was: "look at the original and rewrite it in React" — this produced components that looked similar in code but rendered completely differently because of subtle grid/flex/responsive differences.

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
| Admin schema composition | `src/admin/schema.ts` in `@decocms/start` |
| Common gotchas (45 items) | `references/gotchas.md` |
| setup.ts template | `templates/setup-ts.md` |
| vite.config.ts template | `templates/vite-config.md` |
| worker-entry template | `templates/worker-entry.md` |
| __root.tsx template | `templates/root-route.md` |
| router.tsx template | `templates/router.md` |
| package.json template | `templates/package-json.md` |

## Related Skills

| Skill | Use When |
|-------|----------|
| deco-apps-vtex-porting | Understanding VTEX loader internals (Phase 4-5) |
| deco-islands-migration | Eliminating islands/ (Phase 6) |
| deco-async-rendering-site-guide | Lazy wrappers, LoadingFallback (Phase 7, 10) |
| deco-tanstack-navigation | Link, prefetch, scroll issues (Phase 8) |
| deco-edge-caching | Worker caching, cache profiles (Phase 9) |
| deco-tanstack-hydration-fixes | Hydration mismatches post-migration |
| deco-tanstack-search | Search page not working |
| deco-typescript-fixes | Bulk TypeScript error resolution |
| deco-start-architecture | Understanding @decocms/start internals |
| deco-tanstack-storefront-patterns | Runtime bugs after migration |
| deco-server-functions-invoke | Server function patterns |
| deco-tanstack-data-flow | Data flow architecture |
