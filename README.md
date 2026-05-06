# @decocms/start

[![npm version](https://img.shields.io/npm/v/@decocms/start.svg)](https://www.npmjs.com/package/@decocms/start)
[![license](https://img.shields.io/npm/l/@decocms/start.svg)](https://github.com/decocms/deco-start/blob/main/LICENSE)

Framework layer for [deco.cx](https://deco.cx) storefronts on **TanStack Start + React 19 + Cloudflare Workers**.

`@decocms/start` is the npm package that storefronts depend on. It provides the CMS bridge, admin protocol, section registry, schema generation, edge caching, the Vite plugin, and a small SDK. It is **not** itself a storefront — it is what storefronts build on top of.

📖 **[Read the full documentation →](https://docs.deco.cx/v2/en/getting-started/overview)**

---

## What's in the box

```
┌─────────────────────────────────────────────────┐
│   Site repo (your storefront)                    │  ← Components, sections, routes
├─────────────────────────────────────────────────┤
│   @decocms/apps  (commerce integrations)         │  ← VTEX, Shopify, Resend
├─────────────────────────────────────────────────┤
│   @decocms/start  (framework — this package)     │  ← CMS bridge, admin, caching
└─────────────────────────────────────────────────┘
              ↓ runs on ↓
   TanStack Start  +  React 19  +  Cloudflare Workers
```

`@decocms/start` exports cover four surfaces:

- **Worker entry** — `createDecoWorkerEntry` wraps your Cloudflare Worker with admin routes, edge cache, and asset bypass.
- **CMS bridge** — `loadCmsPage`, `resolveDecoPage`, `registerSectionLoaders`, `registerLayoutSections`.
- **Admin protocol** — `handleMeta`, `handleDecofile`, `handleRender`, `handleInvoke`.
- **SDK** — `createCachedLoader`, `createInstrumentedFetch`, `createInvoke`, `decoVitePlugin`, plus utilities (cookies, redirects, sitemap, A/B testing).

Full export reference: [docs.deco.cx/v2/en/reference/package-exports](https://docs.deco.cx/v2/en/reference/package-exports).

---

## Hello, World

A minimal v2 storefront has six files. Here they are.

### `package.json`

```jsonc
{
  "name": "my-store",
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@decocms/start": "^2.28.0",
    "@decocms/apps": "^1.11.0",
    "@tanstack/react-start": "^1.166.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "vite": "^6.0.0",
    "wrangler": "^4.72.0"
  }
}
```

### `vite.config.ts`

```ts
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import decoVitePlugin from "@decocms/start/vite";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({ server: { entry: "server" } }),
    react({ babel: { plugins: ["babel-plugin-react-compiler"] } }),
    decoVitePlugin(),
  ],
  resolve: {
    alias: { "~": "/src" },
    deduplicate: ["react", "react-dom", "@decocms/start", "@decocms/apps"],
  },
});
```

### `wrangler.jsonc`

```jsonc
{
  "name": "my-store",
  "main": "./src/worker-entry.ts",
  "compatibility_date": "2026-02-14",
  "compatibility_flags": [
    "nodejs_compat",
    "no_handle_cross_request_promise_resolution"
  ],
  "assets": { "directory": "./dist/client" }
}
```

### `src/setup.ts`

```ts
import { createSiteSetup } from "@decocms/start/setup";
import { applySectionConventions } from "@decocms/start/cms";

import blocks from "./server/cms/blocks.gen";
import sectionsGen from "./server/cms/sections.gen";
import meta from "./server/cms/meta.gen.json";

createSiteSetup({
  sections: import.meta.glob("./sections/**/*.tsx", { eager: true }),
  blocks,
  meta: () => meta,
  productionOrigins: ["https://my-store.com"],
});

applySectionConventions(sectionsGen);
```

### `src/worker-entry.ts`

```ts
import "./setup";   // MUST be first

import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
import {
  handleMeta,
  handleDecofile,
  handleRender,
  handleInvoke,
} from "@decocms/start/admin";
import serverEntry from "./server";

export default createDecoWorkerEntry(serverEntry, {
  admin: { handleMeta, handleDecofile, handleRender, handleInvoke },
});
```

### `src/routes/$.tsx`

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { cmsRouteConfig } from "@decocms/start/routes";

export const Route = createFileRoute("/$")(
  cmsRouteConfig({ siteName: "my-store" }),
);
```

That is the entire skeleton. `npm install`, `npm run dev`, point `admin.deco.cx` at it, and you have a working CMS-driven site.

For commerce integrations (VTEX, Shopify) see [`@decocms/apps`](https://www.npmjs.com/package/@decocms/apps).

---

## Migrating from Fresh / Preact / Deno

`@decocms/start` ships an Agent Skill that handles the migration for you. It works with Claude Code, Cursor, Codex, and any tool that supports skills.

```bash
npx skills add decocms/deco-start
```

Then, in your editor, point at your Fresh storefront and prompt:

> migrate this project to TanStack Start

The skill runs the migration script, walks you through `MIGRATION_REPORT.md`, fixes typecheck/build errors interactively, and shows the diff before committing.

### Or run the script directly

```bash
# from inside the v1 storefront directory
npx -p @decocms/start deco-migrate
```

The script runs seven phases (analyze → scaffold → transform → cleanup → report → verify → bootstrap), produces `MIGRATION_REPORT.md` with manual TODOs, and gets you to "compiles clean, builds clean".

Full migration playbook: [docs.deco.cx/v2/en/migration/overview](https://docs.deco.cx/v2/en/migration/overview).

---

## Documentation

The full v2 docs live at **[docs.deco.cx/v2](https://docs.deco.cx/v2/en/getting-started/overview)**:

- [Getting started](https://docs.deco.cx/v2/en/getting-started/overview) — install paths, project structure, stack overview.
- [Concepts](https://docs.deco.cx/v2/en/concepts/sections) — sections, loaders, blocks, routes, deferred rendering.
- [Framework reference](https://docs.deco.cx/v2/en/framework/overview) — every export of `@decocms/start`, page by page.
- [Migration](https://docs.deco.cx/v2/en/migration/overview) — v1 → v2 playbook + script + skill.
- [Case studies](https://docs.deco.cx/v2/en/case-studies/overview) — three production stores end-to-end.

---

## Peer dependencies

```json
{
  "@tanstack/react-start": ">=1.0.0",
  "@tanstack/store": ">=0.7.0",
  "@tanstack/react-query": ">=5.0.0",
  "react": "^19.0.0",
  "react-dom": "^19.0.0",
  "vite": ">=6.0.0"
}
```

OpenTelemetry is optional but recommended: `@microlabs/otel-cf-workers >=1.0.0-rc.0`, `@opentelemetry/api >=1.9.0`.

---

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # biome check
npm run check       # typecheck + lint + unused exports
```

This is a library — there is no dev server here. Consumer storefronts run their own `vite dev`.

Contributing? See `CLAUDE.md` for the architectural decisions, and `MIGRATION_TOOLING_PLAN.md` for the append-only history of the migration tooling.

---

## License

MIT
