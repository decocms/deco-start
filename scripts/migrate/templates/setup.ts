import type { MigrationContext } from "../types.ts";

export function generateSetup(ctx: MigrationContext): string {
  const isVtex = ctx.platform === "vtex";
  const siteName = ctx.siteName;

  const productionOrigins = [
    `"https://www.${siteName}.com.br"`,
    `"https://${siteName}.com.br"`,
  ];

  return `/**
 * Site setup — orchestrator that wires framework, commerce, and sections.
 *
 * Actual logic lives in focused modules:
 *   setup/commerce-loaders.ts  — COMMERCE_LOADERS map (data fetchers)
 *   setup/section-loaders.ts   — registerSectionLoaders (per-section prop enrichment)
 *
 * Section metadata (eager, sync, layout, cache, LoadingFallback) is declared
 * in each section file and auto-extracted by generate-sections.ts.
 */

import "./cache-config";

import {
  registerCommerceLoaders,
  applySectionConventions,
} from "@decocms/start/cms";
import { createSiteSetup } from "@decocms/start/setup";
import { setInvokeLoaders } from "@decocms/start/admin";${isVtex ? `
import { createInstrumentedFetch } from "@decocms/start/sdk/instrumentedFetch";
import { initVtexFromBlocks, setVtexFetch } from "@decocms/apps/vtex";` : ""}
import { blocks as generatedBlocks } from "./server/cms/blocks.gen";
import { sectionMeta, syncComponents, loadingFallbacks } from "./server/cms/sections.gen";
import { PreviewProviders } from "@decocms/start/hooks";
// @ts-ignore Vite ?url import
import appCss from "./styles/app.css?url";

import { COMMERCE_LOADERS } from "./setup/commerce-loaders";
import "./setup/section-loaders";

// -- Framework setup --
createSiteSetup({
  sections: import.meta.glob("./sections/**/*.tsx") as Record<string, () => Promise<any>>,
  blocks: generatedBlocks,
  meta: () => import("./server/admin/meta.gen.json").then((m) => m.default),
  css: appCss,
  fonts: [],
  productionOrigins: [
    ${productionOrigins.join(",\n    ")},
  ],
  previewWrapper: PreviewProviders,${isVtex ? `
  initPlatform: (blocks) => initVtexFromBlocks(blocks),` : ""}
  onResolveError: (error, resolveType, context) => {
    console.error(\`[CMS-DEBUG] \${context} "\${resolveType}" failed:\`, error);
  },
  onDanglingReference: (resolveType) => {
    console.warn(\`[CMS-DEBUG] Dangling reference: \${resolveType}\`);
    return null;
  },
});
${isVtex ? `
// -- VTEX wiring --
setVtexFetch(createInstrumentedFetch("vtex"));
` : ""}
// -- Convention-driven section registration --
applySectionConventions({
  meta: sectionMeta,
  syncComponents,
  loadingFallbacks,
  sectionGlob: import.meta.glob("./sections/**/*.tsx") as Record<string, () => Promise<any>>,
});

// -- Commerce + invoke --
registerCommerceLoaders(COMMERCE_LOADERS);
setInvokeLoaders(() => COMMERCE_LOADERS);
`;
}
