---
name: deco-cms-route-config
description: Configure CMS-driven routes in @decocms/start using cmsRouteConfig, cmsHomeRouteConfig, and admin routes. Covers the catch-all route ($.tsx), homepage route (index.tsx), admin protocol routes (meta, render, invoke), ignoreSearchParams for variant selection, staleTime/gcTime configuration, cache headers, and head/SEO setup. Use when creating a new Deco site, migrating routes from Fresh, or debugging route-level caching issues.
---

# CMS Route Configuration in @decocms/start

Reusable route configuration factories that live in `@decocms/start/routes`. Sites use thin wrappers that delegate to these factories, keeping route files small and consistent across all Deco sites.

## When to Use This Skill

- Setting up routes for a new Deco TanStack storefront
- Migrating Fresh routes to TanStack Start
- Debugging why variant changes trigger server re-fetches
- Configuring cache headers per page type
- Setting up admin protocol routes (meta, render, invoke)
- Understanding the relationship between `loaderDeps`, `staleTime`, and server-side caching

---

## Route Architecture

```
Site Routes (thin wrappers)          Framework (@decocms/start/routes)
─────────────────────────           ──────────────────────────────────
src/routes/$.tsx          ───────→  cmsRouteConfig()
src/routes/index.tsx      ───────→  cmsHomeRouteConfig()
src/routes/deco/meta.ts   ───────→  decoMetaRoute
src/routes/deco/render.ts ───────→  decoRenderRoute
src/routes/deco/invoke.$.ts ─────→  decoInvokeRoute
src/routes/__root.tsx     ×         Site-specific (fonts, theme, CSS)
```

---

## Catch-All CMS Route (`$.tsx`)

The catch-all route handles all CMS-managed pages (PDP, PLP, institutional pages, etc.).

### Site File (minimal)

```typescript
// src/routes/$.tsx
import { createFileRoute, notFound } from "@tanstack/react-router";
import { cmsRouteConfig, NotFoundPage } from "@decocms/start/routes";
import { DecoPageRenderer } from "@decocms/start/hooks";

const config = cmsRouteConfig({
  siteName: "My Store",
  defaultTitle: "My Store - Default Title",
  ignoreSearchParams: ["skuId"],
});

export const Route = createFileRoute("/$")({
  loaderDeps: config.loaderDeps,
  loader: async (ctx) => {
    const page = await config.loader(ctx);
    if (!page) throw notFound();
    return page;
  },
  component: CmsPage,
  notFoundComponent: NotFoundPage,
  staleTime: config.staleTime,
  gcTime: config.gcTime,
  headers: config.headers,
  head: config.head,
});

function CmsPage() {
  const page = Route.useLoaderData();
  return (
    <div>
      <DecoPageRenderer sections={page.resolvedSections} />
    </div>
  );
}
```

### `cmsRouteConfig` Options

```typescript
interface CmsRouteOptions {
  siteName: string;        // Used in page title: "Page Name | siteName"
  defaultTitle: string;    // Fallback title when CMS page has no name
  ignoreSearchParams?: string[];  // Search params excluded from loaderDeps
}
```

### `ignoreSearchParams` — Critical for Variants

`ignoreSearchParams: ["skuId"]` tells TanStack Router that `?skuId` changes should NOT trigger a loader re-fetch:

```typescript
loaderDeps: ({ search }) => {
  const filtered = Object.fromEntries(
    Object.entries(search ?? {}).filter(([k]) => !ignoreSet.has(k)),
  );
  return { search: Object.keys(filtered).length ? filtered : undefined };
},
```

The `loader` only sees `deps.search` (which excludes `skuId`), so it builds the CMS path without `?skuId`:

```typescript
loader: async ({ params, deps }) => {
  const basePath = "/" + (params._splat || "");
  const searchStr = deps.search
    ? "?" + new URLSearchParams(deps.search).toString()
    : "";
  return loadCmsPage({ data: basePath + searchStr });
},
```

### Cache Headers — Dynamic per Page Type

```typescript
headers: ({ loaderData }) => {
  const profile = loaderData?.cacheProfile ?? "listing";
  return cacheHeaders(profile);
},
```

The `cacheProfile` is determined by `detectCacheProfile(basePath)` inside `loadCmsPage`:

| URL Pattern | Profile | Edge TTL |
|-------------|---------|----------|
| `*/p` | product | 5 min |
| `/s`, `?q=` | search | 60s |
| `/cart`, `/checkout` | private | none |
| Everything else | listing | 2 min |

### Head/SEO

```typescript
head: ({ loaderData }) => ({
  meta: [
    { title: loaderData?.pageName
        ? `${loaderData.pageName} | ${siteName}`
        : defaultTitle },
  ],
}),
```

---

## Homepage Route (`index.tsx`)

Hardcoded to `/` path — no params, no deps.

### Site File

```typescript
// src/routes/index.tsx
import { createFileRoute } from "@tanstack/react-router";
import { cmsHomeRouteConfig } from "@decocms/start/routes";
import { DecoPageRenderer } from "@decocms/start/hooks";

const config = cmsHomeRouteConfig({
  defaultTitle: "My Store - Homepage",
});

export const Route = createFileRoute("/")({
  ...config,
  component: HomePage,
});

function HomePage() {
  const page = Route.useLoaderData();
  if (!page) {
    return <div>Loading...</div>;
  }
  return <DecoPageRenderer sections={page.resolvedSections} />;
}
```

### `cmsHomeRouteConfig` Options

```typescript
interface CmsHomeRouteOptions {
  defaultTitle: string;
}
```

---

## Admin Protocol Routes

These routes enable the Deco CMS admin (admin.deco.cx) to communicate with the storefront:

### Meta Route — Schema & Manifest

```typescript
// src/routes/deco/meta.ts
import { createFileRoute } from "@tanstack/react-router";
import { decoMetaRoute } from "@decocms/start/routes";

export const Route = createFileRoute("/deco/meta")({
  ...decoMetaRoute,
});
```

### Render Route — Section Preview

```typescript
// src/routes/deco/render.ts
import { createFileRoute } from "@tanstack/react-router";
import { decoRenderRoute } from "@decocms/start/routes";

export const Route = createFileRoute("/deco/render")({
  ...decoRenderRoute,
});
```

### Invoke Route — Loader/Action Execution

```typescript
// src/routes/deco/invoke.$.ts
import { createFileRoute } from "@tanstack/react-router";
import { decoInvokeRoute } from "@decocms/start/routes";

export const Route = createFileRoute("/deco/invoke/$")({
  ...decoInvokeRoute,
});
```

### Important: Use Spread Operator

Always use `{ ...frameworkRoute }` — NOT `createFileRoute("/path")(frameworkRoute)`:

```typescript
// BAD — "Route cannot have both an 'id' and a 'path' option"
export const Route = createFileRoute("/deco/meta")(decoMetaRoute);

// GOOD — spread into new object
export const Route = createFileRoute("/deco/meta")({ ...decoMetaRoute });
```

TanStack Router injects internal properties (`id`, `path`) that conflict if the config object already has them.

---

## Framework Exports

```typescript
// @decocms/start/routes
export {
  cmsRouteConfig,        // Catch-all CMS route config factory
  cmsHomeRouteConfig,    // Homepage route config factory
  loadCmsPage,           // Server function for CMS page resolution
  loadCmsHomePage,       // Server function for homepage resolution
  type CmsRouteOptions,
  CmsPage,              // Generic CMS page component
  NotFoundPage,         // Generic 404 component
  decoMetaRoute,        // Admin meta route config
  decoRenderRoute,      // Admin render route config
  decoInvokeRoute,      // Admin invoke route config
};
```

Add to `package.json` exports:
```json
{
  "exports": {
    "./routes": "./src/routes/index.ts"
  }
}
```

---

## Common Errors

### `Cannot find module '@decocms/start/routes'`

TypeScript server needs restart after adding new exports to `package.json`. In VSCode/Cursor:
- Cmd+Shift+P → "TypeScript: Restart TS Server"
- Or restart the dev server

### `Route cannot have both an 'id' and a 'path' option`

Use spread: `{ ...decoMetaRoute }` instead of direct assignment.

### `Property 'resolvedSections' does not exist on type 'never'`

TypeScript inference limitation with `createServerFn` + `useLoaderData()`. The `page` could be `null`. Add a null check:

```typescript
function CmsPage() {
  const page = Route.useLoaderData();
  if (!page) return <NotFoundPage />;
  return <DecoPageRenderer sections={page.resolvedSections} />;
}
```

### Root Route (`__root.tsx`) — Keep Site-Specific

The root route contains site-specific elements that should NOT be in the framework:
- HTML lang attribute
- Favicon
- CSS stylesheet imports
- Font loading
- Theme configuration
- QueryClient setup

---

## `staleTime` / `gcTime` Configuration

### Production

Set by `routeCacheDefaults(profile)` based on page type:

| Profile | staleTime | gcTime |
|---------|-----------|--------|
| static | 5 min | 30 min |
| product | 5 min | 30 min |
| listing | 2 min | 10 min |
| search | 60s | 5 min |
| private | 0 | 0 |

### Development

`staleTime: 5_000` (5 seconds) — not zero!

With `staleTime: 0`, TanStack Router re-fetches on every navigation even if `loaderDeps` returns identical deps. This causes:
- Double-fetch on variant changes (despite `ignoreSearchParams`)
- Prefetch + click = 2 server calls

Setting 5s staleTime allows rapid interactions (variant clicks, back/forward) to use cached data while still reflecting changes within a few seconds.

---

## Related Skills

| Skill | Purpose |
|-------|---------|
| `deco-variant-selection-perf` | Variant selection optimization using replaceState |
| `deco-cms-layout-caching` | Layout section caching in CMS resolve |
| `deco-edge-caching` | Cloudflare edge caching with workerEntry |
| `deco-tanstack-storefront-patterns` | General storefront patterns |
| `deco-start-architecture` | Full @decocms/start architecture reference |
