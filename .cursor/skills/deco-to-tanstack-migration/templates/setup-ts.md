# setup.ts Template

Minimal, convention-driven setup. Matches `@decocms/start >= 1.6.2`. Based on the storefront-tanstack Shopify port.

Three framework composers do the work — the site file is short by design:

- `createSiteSetup(options)` — CMS engine + admin protocol + matcher registration
- `applySectionConventions(gen)` — reads `sections.gen.ts` and wires eager/layout/seo/cache/sync sections
- `autoconfigApps(blocks, APP_REGISTRY)` — dual-registers every app's loaders + actions from `@decocms/apps/registry`

```typescript
/**
 * Site setup — orchestrator that wires framework, apps, and sections.
 *
 * App-installed loaders + actions (Shopify, VTEX, Resend, …) are wired via
 * `autoconfigApps(blocks, APP_REGISTRY)` — adding a new app is a one-line
 * entry in `@decocms/apps/registry.ts`, no change needed here.
 *
 * Section-specific prop enrichment lives in `setup/section-loaders.ts`.
 * Section metadata (eager, sync, layout, cache, LoadingFallback) is declared
 * in each section file and auto-extracted by generate-sections.ts.
 */

import "./cache-config";

import {
  registerCommerceLoaders,
  applySectionConventions,
} from "@decocms/start/cms";
import { createSiteSetup } from "@decocms/start/setup";
import { autoconfigApps } from "@decocms/start/apps";
import { createInstrumentedFetch } from "@decocms/start/sdk/instrumentedFetch";
import { initShopifyFromBlocks, setShopifyFetch } from "@decocms/apps/shopify";
import { APP_REGISTRY } from "@decocms/apps/registry";
import { blocks as generatedBlocks } from "./server/cms/blocks.gen";
import {
  sectionMeta,
  syncComponents,
  loadingFallbacks,
} from "./server/cms/sections.gen";
import { PreviewProviders } from "@decocms/start/hooks";
// @ts-ignore Vite ?url import
import appCss from "./styles/app.css?url";

import "./setup/section-loaders";

// -- Framework setup --
createSiteSetup({
  sections: import.meta.glob("./sections/**/*.tsx") as Record<string, () => Promise<any>>,
  blocks: generatedBlocks,
  meta: () => import("./server/admin/meta.gen.json").then((m) => m.default),
  css: appCss,
  fonts: [],
  productionOrigins: [
    "https://www.<SITE>.com.br",
    "https://<SITE>.com.br",
  ],
  previewWrapper: PreviewProviders,
  initPlatform: (blocks) => initShopifyFromBlocks(blocks),  // or initVtexFromBlocks
  onResolveError: (error, resolveType, context) => {
    console.error(`[CMS-DEBUG] ${context} "${resolveType}" failed:`, error);
  },
  onDanglingReference: (resolveType) => {
    console.warn(`[CMS-DEBUG] Dangling reference: ${resolveType}`);
    return null;
  },
});

// -- Platform fetch instrumentation (optional, for observability) --
setShopifyFetch(createInstrumentedFetch("shopify"));

// -- Convention-driven section registration --
applySectionConventions({
  meta: sectionMeta,
  syncComponents,
  loadingFallbacks,
  sectionGlob: import.meta.glob("./sections/**/*.tsx") as Record<string, () => Promise<any>>,
});

// -- Apps: auto-configure from decofile against the @decocms/apps registry --
// Dual-registers into commerce loaders (CMS resolve) + invoke handlers (admin)
// for every configured app. Adding a new app = add an entry in
// @decocms/apps/registry.ts. No change here per app.
await autoconfigApps(generatedBlocks, APP_REGISTRY);

// -- Site-local loaders (not shipped by an app) --
// Register .ts and bare variants — CMS resolver may query either.
registerCommerceLoaders({
  "site/loaders/minicart.ts": async () => (await import("./loaders/minicart")).default(),
  "site/loaders/minicart":    async () => (await import("./loaders/minicart")).default(),
  "site/loaders/user.ts":     async () => (await import("./loaders/user")).default(),
  "site/loaders/user":        async () => (await import("./loaders/user")).default(),
  "site/loaders/wishlist.ts": async () => (await import("./loaders/wishlist")).default(),
  "site/loaders/wishlist":    async () => (await import("./loaders/wishlist")).default(),
});
```

## Section metadata convention

Declare section behavior in the section file, not in setup.ts. `generate-sections.ts` scans `src/sections/**` and emits `src/server/cms/sections.gen.ts`.

```typescript
// src/sections/Header/Header.tsx
export default function Header(props) { /* ... */ }

export const eager = true;    // always render eagerly (bypass Lazy wrappers)
export const sync = true;     // import bundled, not code-split (for first paint)
export const layout = true;   // render as a layout section (header/footer/theme)
```

```typescript
// src/sections/Product/SearchResult.tsx
export const cache = "listing";  // SWR cache profile

export function LoadingFallback() {
  return <div className="animate-pulse h-96 bg-base-200" />;
}
```

```typescript
// src/sections/SEO/SeoPDP.tsx
export const seo = true;  // extract page SEO from this section's output
```

After changes to any `export const <flag>` or `LoadingFallback`, re-run `npm run generate:sections` (or `npm run build`).

## What NOT to put here

- **Section imports** — lazy via Vite glob, sync via `sectionMeta.sync` + `syncComponents`. Zero manual imports needed.
- **App loaders/actions** — `autoconfigApps` registers every entry in `APP_REGISTRY`. Adding Shopify/VTEX/Resend loaders by hand is a bug.
- **alwaysEager arrays** — driven by `export const eager = true` in section files.
- **SEO registration** — driven by `export const seo = true`.
- **Cache profile arrays** — driven by `export const cache = "..."`.
- **`setMetaData` / `setRenderShell` / `setInvokeLoaders` calls** — `createSiteSetup` handles them. Only reach for the low-level APIs if composing a non-standard pipeline.

## Adding a new app (e.g., 4th commerce integration)

1. `@decocms/apps/registry.ts` gets one new entry: `{ blockKey, module, displayName, category, description }`
2. Bump `@decocms/apps` minor version; site installs the bump
3. Add the block in `.deco/blocks/<blockKey>.json` with platform config
4. Nothing else changes — `autoconfigApps` picks it up on next boot

## See also

- `applySectionConventions` source: `@decocms/start/src/cms/applySectionConventions.ts`
- `autoconfigApps` source: `@decocms/start/src/apps/autoconfig.ts`
- Registry source: `@decocms/apps/registry.ts`
- Generate scripts: `@decocms/start/scripts/generate-{blocks,schema,sections,loaders,invoke}.ts`
