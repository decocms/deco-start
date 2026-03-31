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

## Migrating from Fresh/Preact/Deno

`@decocms/start` includes an Agent Skill that handles migration for you. It works with Claude Code, Cursor, Codex, and other AI coding tools. Install the skill, open your Fresh storefront, and tell the AI to migrate:

```bash
npx skills add decocms/deco-start
```

Then open your project in any supported tool and say:

> migrate this project to TanStack Start

The skill handles compatibility checking, import rewrites, config generation, section registry setup, and worker entry creation. It knows what `@decocms/start` supports and will flag anything that needs manual attention.

### Or run the script manually

```bash
# From your Fresh site directory (nothing to install beforehand):
npx -p @decocms/start deco-migrate
```

**Options:**

| Flag | Description |
|------|-------------|
| `--source <dir>` | Source directory (default: current directory) |
| `--dry-run` | Preview changes without writing files |
| `--verbose` | Show detailed output |
| `--help`, `-h` | Show help message |

The script runs 7 phases automatically:

1. **Analyze** — scan source, detect Preact/Fresh/Deco patterns
2. **Scaffold** — generate `vite.config.ts`, `wrangler.jsonc`, routes, `setup.ts`, worker entry
3. **Transform** — rewrite imports (70+ rules), JSX attrs, Fresh APIs, Deno-isms, Tailwind v3→v4
4. **Cleanup** — delete `islands/`, old routes, `deno.json`, move `static/` → `public/`
5. **Report** — generate `MIGRATION_REPORT.md` with manual review items
6. **Verify** — 18+ smoke tests (zero old imports, scaffolded files exist)
7. **Bootstrap** — `npm install`, generate CMS blocks, generate routes

Your existing `src/sections/`, `src/components/`, and `.deco/blocks/` work as-is. The script gets you to "builds clean with zero old imports" — manual work starts at platform hooks (`useCart`) and runtime tuning.

### Agent Skills

Skills live in [`.agents/skills/`](.agents/skills/) and provide deep context to AI coding tools:

| Skill | What it covers |
|-------|---------------|
| `deco-to-tanstack-migration` | Full 12-phase migration playbook with 22 reference docs and 6 templates |
| `deco-migrate-script` | How the automated `scripts/migrate.ts` works, how to extend it |

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
