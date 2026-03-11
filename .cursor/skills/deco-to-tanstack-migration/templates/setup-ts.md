# setup.ts Template

Annotated template based on espacosmart-storefront (100+ sections, VTEX, async rendering).

```typescript
// ==========================================================================
// 1. CMS BLOCKS & META
// ==========================================================================

import blocksJson from "./server/cms/blocks.gen.ts";
import metaData from "./server/admin/meta.gen.json";
import { setBlocks } from "@decocms/start/cms/loader";
import { setMetaData, setInvokeLoaders, setRenderShell } from "@decocms/start/admin";
import { registerSections, registerSectionsSync, setResolvedComponent } from "@decocms/start/cms/registry";
import { registerSectionLoaders, registerLayoutSections } from "@decocms/start/cms/sectionLoaders";
import { registerCommerceLoaders, setAsyncRenderingConfig, onBeforeResolve } from "@decocms/start/cms/resolve";
import { createCachedLoader } from "@decocms/start/sdk/cachedLoader";
import appCss from "./styles/app.css?url";

// Load CMS blocks (pages, sections, configs) from generated JSON
setBlocks(blocksJson);

// Set admin schema for /live/_meta endpoint
setMetaData(metaData);

// Configure admin preview HTML shell
setRenderShell({
  css: appCss,
  fonts: ["https://fonts.googleapis.com/css2?family=YourFont:wght@400;500;600;700&display=swap"],
  theme: "light",       // data-theme="light" on <html> for DaisyUI
  bodyClass: "bg-base-100 text-base-content",
  lang: "pt-BR",
});

// ==========================================================================
// 2. SECTION REGISTRATION
// ==========================================================================

// Critical sections — above-the-fold, bundled synchronously
import HeaderSection from "./components/header/Header";
import FooterSection from "./sections/Footer/Footer";

const criticalSections: Record<string, any> = {
  "site/sections/Header/Header.tsx": HeaderSection,
  "site/sections/Footer/Footer.tsx": FooterSection,
};

// Register sync components for instant SSR (no Suspense boundary)
for (const [key, mod] of Object.entries(criticalSections)) {
  setResolvedComponent(key, mod.default || mod);
}
registerSectionsSync(criticalSections);

// All sections — lazy-loaded via dynamic import
registerSections({
  "site/sections/Header/Header.tsx": () => import("./sections/Header/Header"),
  "site/sections/Footer/Footer.tsx": () => import("./sections/Footer/Footer"),
  "site/sections/Theme/Theme.tsx": () => import("./sections/Theme/Theme"),
  // ... register ALL sections from src/sections/ here
  // Pattern: "site/sections/Path/Name.tsx": () => import("./sections/Path/Name")
});

// ==========================================================================
// 3. LAYOUT SECTIONS
// ==========================================================================

// Layout sections are always rendered eagerly (never lazy/deferred),
// even if wrapped in Lazy.tsx in the CMS.
registerLayoutSections([
  "site/sections/Header/Header.tsx",
  "site/sections/Footer/Footer.tsx",
  "site/sections/Theme/Theme.tsx",
  "site/sections/Social/WhatsApp.tsx",
]);

// ==========================================================================
// 4. SECTION LOADERS
// ==========================================================================

// Section loaders enrich CMS props with server-side data (e.g., VTEX API calls).
// Only needed for sections that export `const loader`.
registerSectionLoaders({
  "site/sections/Product/ProductShelf.tsx": (props: any, req: Request) =>
    import("./components/product/ProductShelf").then((m) => m.loader(props, req)),
  "site/sections/Product/SearchResult.tsx": (props: any, req: Request) =>
    import("./components/search/SearchResult").then((m) => m.loader(props, req)),
  // ... add for each section that has `export const loader`
});

// ==========================================================================
// 5. COMMERCE LOADERS (VTEX)
// ==========================================================================

import { vtexProductList } from "@decocms/apps/vtex/loaders/productList";
import { vtexProductDetailsPage } from "@decocms/apps/vtex/loaders/productDetailsPage";
import { vtexProductListingPage } from "@decocms/apps/vtex/loaders/productListingPage";
import { vtexSuggestions } from "@decocms/apps/vtex/loaders/suggestions";
import { initVtexFromBlocks } from "@decocms/apps/vtex/setup";

// SWR-cached commerce loaders — avoids re-fetching on every page navigation
const cachedProductList = createCachedLoader("vtex/productList", vtexProductList, {
  policy: "stale-while-revalidate", maxAge: 60_000,
});
const cachedPDP = createCachedLoader("vtex/pdp", vtexProductDetailsPage, {
  policy: "stale-while-revalidate", maxAge: 30_000,
});
const cachedPLP = createCachedLoader("vtex/plp", vtexProductListingPage, {
  policy: "stale-while-revalidate", maxAge: 60_000,
});
const cachedSuggestions = createCachedLoader("vtex/suggestions", vtexSuggestions, {
  policy: "stale-while-revalidate", maxAge: 120_000,
});

// Map CMS __resolveType strings to actual loader functions
registerCommerceLoaders({
  "vtex/loaders/intelligentSearch/productList.ts": cachedProductList,
  "vtex/loaders/intelligentSearch/productListingPage.ts": cachedPLP,
  "vtex/loaders/intelligentSearch/productDetailsPage.ts": cachedPDP,
  "vtex/loaders/intelligentSearch/suggestions.ts": cachedSuggestions,
  // Add passthrough loaders for types that don't need caching:
  // "vtex/loaders/config.ts": (props) => props,
});

// ==========================================================================
// 6. VTEX INITIALIZATION
// ==========================================================================

// onBeforeResolve runs once before the first CMS page resolution.
// initVtexFromBlocks reads VTEX config (account, publicUrl) from CMS blocks.
onBeforeResolve(() => {
  initVtexFromBlocks();
});

// ==========================================================================
// 7. ASYNC RENDERING
// ==========================================================================

// Enable deferred section loading (scroll-triggered).
// Respects CMS Lazy wrappers. Layout sections and alwaysEager are never deferred.
setAsyncRenderingConfig({
  alwaysEager: [
    "site/sections/Header/Header.tsx",
    "site/sections/Footer/Footer.tsx",
    "site/sections/Theme/Theme.tsx",
    "site/sections/Images/Carousel.tsx",
    // Add above-the-fold sections here
  ],
});

// ==========================================================================
// 8. INVOKE LOADERS (for /deco/invoke endpoint)
// ==========================================================================

setInvokeLoaders({
  "vtex/loaders/intelligentSearch/productList.ts": cachedProductList,
  "vtex/loaders/intelligentSearch/suggestions.ts": cachedSuggestions,
  // Used by the admin to preview loader results
});
```

## Key Patterns

1. **Order matters**: blocks → meta → sections → loaders → commerce → async config
2. **Critical sections**: Import synchronously for instant SSR, also register as lazy for client code-splitting
3. **SWR caching**: `createCachedLoader` wraps commerce loaders with stale-while-revalidate
4. **onBeforeResolve**: Deferred initialization — VTEX config is read from CMS blocks at first request
5. **alwaysEager**: Sections that must render on first paint (no deferred loading)
