# @decocms/start

[![npm version](https://img.shields.io/npm/v/@decocms/start.svg)](https://www.npmjs.com/package/@decocms/start)
[![license](https://img.shields.io/npm/l/@decocms/start.svg)](https://github.com/decocms/deco-start/blob/main/LICENSE)

Framework layer for [Deco](https://deco.cx) storefronts built on **TanStack Start + React 19 + Cloudflare Workers**.

Provides CMS block resolution, admin protocol handlers, section rendering, schema generation, edge caching, and SDK utilities. This is **not** a storefront — it's the npm package that storefronts depend on.

## Install

```bash
npm install @decocms/start
```

## Architecture

```
@decocms/start        ← Framework (this package)
  └─ @decocms/apps    ← Commerce integrations (VTEX, Shopify)
       └─ site repo   ← UI components, routes, styles
```

### Package Exports

| Import | Purpose |
|--------|---------|
| `@decocms/start` | Barrel export |
| `@decocms/start/cms` | Block loading, page resolution, section registry |
| `@decocms/start/admin` | Admin protocol (meta, decofile, invoke, render, schema) |
| `@decocms/start/hooks` | DecoPageRenderer, LiveControls, LazySection |
| `@decocms/start/routes` | CMS route config, admin routes |
| `@decocms/start/middleware` | Observability, deco state, liveness probe |
| `@decocms/start/sdk/workerEntry` | Cloudflare Worker entry with edge caching |
| `@decocms/start/sdk/cacheHeaders` | URL-to-profile cache detection |
| `@decocms/start/sdk/cachedLoader` | In-flight dedup for loaders |
| `@decocms/start/sdk/useScript` | Inline `<script>` with minification |
| `@decocms/start/sdk/useDevice` | SSR-safe device detection |
| `@decocms/start/sdk/analytics` | Analytics event types |
| `@decocms/start/matchers/*` | Feature flag matchers (PostHog, built-ins) |
| `@decocms/start/types` | Section, App, FnContext type definitions |
| `@decocms/start/scripts/*` | Code generation (blocks, schema, invoke) |

### Worker Entry Request Flow

```
Request → createDecoWorkerEntry()
 ├─ Admin routes (/live/_meta, /.decofile, /deco/render, /deco/invoke)
 ├─ Cache purge check
 ├─ Static asset bypass (/assets/*, favicon)
 ├─ Cloudflare edge cache (profile-based TTLs)
 └─ TanStack Start server entry
```

### Edge Cache Profiles

| URL Pattern | Profile | Edge TTL |
|-------------|---------|----------|
| `/` | static | 1 day |
| `*/p` | product | 5 min |
| `/s`, `?q=` | search | 60s |
| `/cart`, `/checkout` | private | none |
| Everything else | listing | 2 min |

## Peer Dependencies

- `@tanstack/react-start` >= 1.0.0
- `@tanstack/store` >= 0.7.0
- `react` ^19.0.0
- `react-dom` ^19.0.0

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # biome check
npm run check       # typecheck + lint + unused exports
```

This is a library — no dev server. Consumer sites run their own `vite dev`.

## License

MIT
