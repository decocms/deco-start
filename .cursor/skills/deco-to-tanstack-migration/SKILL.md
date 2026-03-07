---
name: deco-to-tanstack-migration
description: Migrate Deco.cx storefronts from Fresh/Preact to TanStack Start/React on Cloudflare Workers. Covers import rewrites, signal-to-store conversion, architecture boundaries between @decocms/start, @decocms/apps, and site repos. Use when migrating a deco-site, porting Preact components to React, replacing @preact/signals, or setting up TanStack Start for a Deco storefront.
---

# Deco-to-TanStack-Start Migration

Playbook for converting a `deco-sites/*` storefront from Fresh/Preact/Deno to TanStack Start/React/Cloudflare Workers.

## Architecture Boundaries

| Layer | npm Package | Purpose | Must NOT Contain |
|-------|-------------|---------|-----------------|
| **@decocms/start** | `@decocms/start` | CMS block resolution, section rendering, DecoPageRenderer, LiveControls, schema generation, **worker entry** (`createDecoWorkerEntry`), **framework sdk** (`useScript`, `signal`, `clx`) | Preact shims, widget types, site-specific section maps |
| **@decocms/apps** | `@decocms/apps` | VTEX/Shopify loaders (actual API calls), commerce type definitions, `mapProductToAnalyticsItem`, `parseRange`, **commerce sdk** (`useOffer`, `formatPrice`, `relative`, `analytics`, `useVariantPossibilities`) | Passthrough HTML components (Image, Picture), hook stubs that do nothing, Preact/Fresh references |
| **Site repo** | (not published) | Everything UI: components, hooks with real logic, site-specific types, routes, styles, contexts | Nothing under `compat/`, no Vite alias hacks beyond `~` -> `src/` |

### What Belongs Where

```
@decocms/start (framework)
├── src/cms/          # Block loading, page resolution, section registry
│   └── loader.ts     # loadBlocks, setBlocks, AsyncLocalStorage for per-request overrides
├── src/admin/        # Admin protocol: meta, decofile, invoke, render, schema composition
│   ├── meta.ts       # setMetaData() calls composeMeta() at startup; /deco/meta handler
│   ├── schema.ts     # MetaResponse type, composeMeta(), framework block schemas (pages)
│   ├── render.ts     # /live/previews/* for section + page preview (HTML shell)
│   ├── setup.ts      # Client-safe setup (setMetaData, setInvokeLoaders, setRenderShell)
│   ├── decofile.ts   # /.decofile read/reload
│   ├── invoke.ts     # /deco/invoke for loader/action calls
│   ├── cors.ts       # CORS + admin origin validation
│   └── liveControls.ts # Admin iframe bridge postMessage script
├── src/sdk/
│   ├── workerEntry.ts # createDecoWorkerEntry: outermost Cloudflare Worker wrapper
│   ├── useScript.ts, signal.ts, clx.ts, cachedLoader.ts, instrumentedFetch.ts
│   └── ...
├── src/hooks/        # DecoPageRenderer (uses registry, NOT hardcoded map), LiveControls
├── src/types/        # FnContext, App, AppContext, Section, SectionProps, Resolved
└── scripts/          # generate-blocks.ts, generate-schema.ts

@decocms/apps (commerce)
├── commerce/types/   # Product, AnalyticsItem, BreadcrumbList, Filter, etc.
├── commerce/utils/   # mapProductToAnalyticsItem, parseRange, formatRange
├── commerce/sdk/     # useOffer, useVariantPossibilities, formatPrice, relative, analytics
├── vtex/             # Client, loaders (actual VTEX API calls)
└── shopify/          # Client, loaders (actual Shopify API calls)

site repo (UI + business logic)
├── src/components/   # All UI components (Image, Picture, Seo, Theme, etc.)
├── src/hooks/        # useCart (real VTEX implementation), useUser, useWishlist
├── src/types/        # widgets.ts (string aliases), vtex.ts (OrderFormItem, etc.)
├── src/sdk/          # Site-specific contexts, usePlatform, useUI, useSuggestions
├── src/sections/     # All CMS-renderable sections
├── src/routes/       # TanStack Router routes
└── src/lib/          # Server functions (vtex-cart-server.ts)
```

## Architecture Map

| Old Stack | New Stack |
|-----------|-----------|
| Deno + Fresh | Node + TanStack Start |
| Preact + Islands | React 19 + React Compiler |
| @preact/signals | @tanstack/store + @tanstack/react-store |
| Deco CMS runtime | Static JSON blocks loaded via loaders |
| $fresh/runtime.ts | Inlined (`asset()` removed, `IS_BROWSER` inlined) |
| @deco/deco/* | Inline type stubs or `@decocms/start/sdk/*` |
| apps/admin/widgets | ~/types/widgets (string aliases) |
| apps/commerce/types | `@decocms/apps/commerce/types` |
| apps/commerce/utils/* | `@decocms/apps/commerce/utils/*` |
| apps/website/components/* | ~/components/ui/* (local React components) |
| apps/{platform}/hooks/* | ~/hooks/useCart (real), ~/hooks/useUser, ~/hooks/useWishlist |
| ~/sdk/useOffer | `@decocms/apps/commerce/sdk/useOffer` |
| ~/sdk/useVariantPossiblities | `@decocms/apps/commerce/sdk/useVariantPossibilities` |
| ~/sdk/format (formatPrice) | `@decocms/apps/commerce/sdk/formatPrice` |
| ~/sdk/url (relative) | `@decocms/apps/commerce/sdk/url` |
| ~/sdk/analytics (sendEvent) | `@decocms/apps/commerce/sdk/analytics` |
| ~/sdk/useScript | `@decocms/start/sdk/useScript` |
| ~/sdk/signal | `@decocms/start/sdk/signal` |
| ~/sdk/clx | `@decocms/start/sdk/clx` |

## Migration Decision Tree

```
What are you migrating?
├─ Preact imports (preact, preact/hooks, preact/compat)
│  └─ references/imports/
├─ @preact/signals (useSignal, useComputed, signal)
│  └─ references/signals/
├─ Deco framework (@deco/deco/*, $fresh/runtime.ts)
│  └─ references/deco-framework/
├─ Commerce types & widget types
│  └─ references/commerce/
├─ Platform hooks (useCart, useUser, useWishlist)
│  └─ references/platform-hooks/
├─ Vite config & alias setup
│  └─ references/vite-config/
└─ Full migration (all of the above)
   └─ Follow steps below in order
```

## Quick Start (Full Migration)

1. **Scaffold**: `npm create @tanstack/app@latest -- --template cloudflare-workers`
2. **Copy source**: Move `src/` from deco-site
3. **Configure Vite**: See `references/vite-config/`
4. **Install deps**: `npm install @decocms/start @decocms/apps @tanstack/store @tanstack/react-store`
5. **Link local libs** (if not published): `cd apps-start && npm link && cd ../deco-start && npm link && cd ../my-store && npm link @decocms/apps @decocms/start`
6. **Rewrite imports** (parallelizable):
   - Preact -> React: `references/imports/`
   - Signals -> TanStack Store: `references/signals/`
   - Deco framework -> inline: `references/deco-framework/`
   - Commerce/widget types -> @decocms/apps + local: `references/commerce/`
   - SDK utilities -> packages: `~/sdk/useOffer` -> `@decocms/apps/commerce/sdk/useOffer`, `~/sdk/useScript` -> `@decocms/start/sdk/useScript`, etc.
7. **Create local UI components**: Image.tsx, Picture.tsx, Seo.tsx, Theme.tsx in `~/components/ui/`
8. **Implement platform hooks**: `references/platform-hooks/`
9. **Build & verify**: `npm run build`
10. **Final audit**: Zero `from "apps/"`, `from "$store/"`, `from "preact"`, `from "@preact"`, `from "@deco/deco"`, `from "~/sdk/useOffer"`, `from "~/sdk/format"` etc. -- all sdk utilities should come from packages

## Key Principles

1. **No compat layer anywhere** -- not in `@decocms/start`, not in `@decocms/apps`, not in the site repo
2. **Replace, don't wrap** -- change the import to the real thing, don't create a pass-through
3. **Types from the library, UI from the site** -- `Product` type comes from `@decocms/apps/commerce/types`, but the `<Image>` component is site-local
4. **One Vite alias maximum** -- `"~"` -> `"src/"` is the only acceptable alias in a finished migration
5. **`tsconfig.json` mirrors `vite.config.ts`** -- only `"~/*": ["./src/*"]` in paths

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

## Reference Index

| Topic | Path |
|-------|------|
| Preact -> React imports | `references/imports/` |
| Signals -> TanStack Store | `references/signals/` |
| Deco framework elimination | `references/deco-framework/` |
| Commerce & widget types | `references/commerce/` |
| Platform hooks (VTEX, etc) | `references/platform-hooks/` |
| Vite configuration | `references/vite-config/` |
| Admin schema composition | `src/admin/schema.ts` in `@decocms/start` |
| Common gotchas | `references/gotchas.md` |
