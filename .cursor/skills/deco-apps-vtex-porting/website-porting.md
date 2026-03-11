# Website Module Porting

How the `website/` app from `deco-cx/apps` maps to `@decocms/start` and the storefront.

## Architecture Split

The original `website/` app is a monolith handling routing, SEO, analytics, images, themes, A/B testing, matchers, and more. In TanStack, these responsibilities are split across three layers:

```
Original (apps/website/)              TanStack Split
════════════════════════              ══════════════
handlers/router.ts              →    TanStack Router (file-based routing)
handlers/proxy.ts               →    @decocms/start/sdk/workerEntry (Cloudflare Worker)
handlers/redirect.ts            →    @decocms/start/sdk/redirects
handlers/sitemap.ts             →    @decocms/start/sdk/sitemap
handlers/fresh.ts               →    Not needed (TanStack replaces Fresh)

loaders/pages.ts                →    @decocms/start/cms/loader (loadBlocks)
loaders/fonts/*                 →    Storefront CSS (Tailwind/Vite handles fonts)
loaders/image/*                 →    Storefront component (Image.tsx)
loaders/redirects.ts            →    @decocms/start/sdk/redirects
loaders/secret.ts               →    process.env / Cloudflare secrets
loaders/asset.ts                →    Vite handles static assets
loaders/environment.ts          →    process.env

components/Analytics.tsx         →    Storefront: ~/components/Analytics.tsx
components/Image.tsx             →    Storefront: ~/components/ui/Image.tsx
components/Video.tsx             →    Storefront: ~/components/ui/Video.tsx
components/Theme.tsx             →    Storefront: ~/components/ui/Theme.tsx
components/_seo/*               →    Storefront: ~/components/Seo.tsx
components/Events.tsx            →    @decocms/apps/commerce/sdk/analytics
components/Clickhouse.tsx        →    Not needed (different observability)

sections/Analytics/*             →    Storefront sections
sections/Rendering/*             →    @decocms/start/hooks/LazySection
sections/Seo/*                   →    Storefront sections

flags/audience.ts                →    @decocms/start/matchers/builtins
matchers/*                       →    @decocms/start/matchers/*
mod.ts                           →    @decocms/start (the framework package itself)
types.ts                         →    @decocms/start/types
```

## What @decocms/start Provides

The `deco-start` package (`@decocms/start`) IS the TanStack equivalent of `website/`:

| Capability | website/ | @decocms/start |
|-----------|----------|----------------|
| CMS page resolution | `handlers/router.ts` | `cms/loader.ts` (loadBlocks) |
| Section rendering | Fresh island hydration | `hooks/DecoPageRenderer.tsx` |
| Lazy loading | Fresh partials | `hooks/LazySection.tsx` |
| Live editing | Fresh middleware | `hooks/LiveControls.tsx` |
| Admin protocol | N/A (Deco runtime) | `admin/` (meta, decofile, invoke, render) |
| Schema generation | `@deco/deco/scripts/bundle` | `scripts/generate-schema.ts` |
| Worker entry | N/A | `sdk/workerEntry.ts` (createDecoWorkerEntry) |
| Edge caching | N/A | `sdk/cacheHeaders.ts`, `sdk/mergeCacheControl.ts` |
| Redirects | `handlers/redirect.ts` | `sdk/redirects.ts` |
| Sitemap | `handlers/sitemap.ts` | `sdk/sitemap.ts` |
| Matchers | `matchers/*` | `matchers/builtins.ts`, `matchers/posthog.ts` |
| Script injection | `@deco/deco/hooks` (useScript) | `sdk/useScript.ts` |
| Signals | `@preact/signals` | `sdk/signal.ts` (TanStack Store wrapper) |
| CSS class helper | N/A | `sdk/clx.ts` |
| Cookie utilities | `../utils/cookie.ts` | `sdk/cookie.ts` |
| Analytics | `components/Events.tsx` | `sdk/analytics.ts` |
| ID generation | N/A | `sdk/useId.ts` |
| CSP | N/A | `sdk/csp.ts` |
| Server timings | N/A | `sdk/serverTimings.ts` |
| Observability | N/A | `middleware/observability.ts` |

## What the Storefront Provides

Each site creates these locally (NOT in a shared package):

### Routing
```
src/routes/
├── __root.tsx        # Root layout (html, head, body)
├── index.tsx         # Homepage
├── $.tsx             # Catch-all (CMS pages, PDP, PLP)
└── deco/             # Admin API routes
    ├── meta.ts
    ├── decofile.ts
    └── render.ts
```

### Components (from website/)
```
src/components/
├── ui/
│   ├── Image.tsx     # From website/components/Image.tsx
│   ├── Video.tsx     # From website/components/Video.tsx
│   └── Theme.tsx     # From website/components/Theme.tsx (usually a stub)
├── Seo.tsx           # From website/components/_seo/*
└── Analytics.tsx     # From website/components/Analytics.tsx
```

### Setup (from website/mod.ts)
```typescript
// src/setup.ts — registers everything
import { setMetaData, setInvokeLoaders, setRenderShell } from "@decocms/start/admin";
import { setBlocks } from "@decocms/start/cms";
import metaData from "./meta.gen.json";
import blocks from "./.deco/blocks/index.ts";

// Register CMS blocks
setBlocks(blocks);

// Register schema for admin
setMetaData(metaData);

// Register loaders for admin invoke
setInvokeLoaders({
  "vtex/loaders/productDetailsPage": (props) => vtexProductDetailsPage(props),
  // ...
});

// Configure preview shell
setRenderShell({
  css: appCss,
  fonts: ["https://fonts.googleapis.com/css2?family=..."],
  theme: "light",
  bodyClass: "bg-base-100 text-base-content",
  lang: "pt-BR",
});
```

## Proxy Handler → Worker Entry

The original `handlers/proxy.ts` is a reverse proxy for VTEX checkout/API. In TanStack, this lives in the Cloudflare Worker entry:

```typescript
// src/worker-entry.ts
import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";

export default createDecoWorkerEntry(serverEntry, {
  admin: { handleMeta, handleDecofileRead, handleRender, corsHeaders },
  // VTEX proxy paths are configured here or in route handlers
});
```

VTEX checkout proxy (`/checkout/*`, `/api/*`) can be handled:
1. As TanStack route handlers (`src/routes/api/$.ts`)
2. In the Worker entry before TanStack handles the request
3. Via Cloudflare Workers routes in `wrangler.jsonc`

## Matchers → Storefront + @decocms/start

Original matchers (device, cookie, date, etc.) are used for audience targeting. In TanStack:

```typescript
// @decocms/start/matchers/builtins.ts provides:
// - device detection
// - cookie matching
// - random percentage
// etc.

// Storefront can extend with custom matchers
```

## SEO

Original: `sections/Seo/*` + `components/_seo/*` provide SEO meta tags via Deco sections.

TanStack: Each route handles its own SEO via TanStack Router's `meta` or a local `<Seo>` component:

```typescript
// src/routes/$.tsx (catch-all)
export const Route = createFileRoute("/$")({
  component: CatchAllPage,
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData?.seo?.title },
      { name: "description", content: loaderData?.seo?.description },
    ],
  }),
});
```

## Summary: What to Port Where

| Original website/ file | Goes to | Layer |
|------------------------|---------|-------|
| `mod.ts` Props | `src/setup.ts` | Storefront |
| `handlers/router.ts` | TanStack file routing | Storefront |
| `handlers/proxy.ts` | Worker entry / route handlers | Storefront |
| `handlers/sitemap.ts` | `@decocms/start/sdk/sitemap` | Framework |
| `handlers/redirect.ts` | `@decocms/start/sdk/redirects` | Framework |
| `loaders/pages.ts` | `@decocms/start/cms/loader` | Framework |
| `matchers/*` | `@decocms/start/matchers/*` | Framework |
| `components/Image.tsx` | `~/components/ui/Image.tsx` | Storefront |
| `components/_seo/*` | `~/components/Seo.tsx` | Storefront |
| `sections/*` | `~/sections/*` | Storefront |
| `flags/*` | `@decocms/start/matchers/*` | Framework |
