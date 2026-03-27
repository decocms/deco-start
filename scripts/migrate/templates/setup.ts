import type { MigrationContext } from "../types.ts";

export function generateSetup(_ctx: MigrationContext): string {
  return `/**
 * Site setup — registers all sections, loaders and matchers with the CMS.
 *
 * This file is imported by router.tsx at startup.
 * It uses import.meta.glob to lazily discover all section components.
 */
import { registerSections } from "@decocms/start/cms";
import { registerMatcher } from "@decocms/start/matchers";

// -- Section Registry --
// Discovers all .tsx files under src/sections/ and registers them as CMS blocks.
const sectionModules = import.meta.glob("./sections/**/*.tsx");
registerSections(sectionModules);

// -- Matchers --
// Register any custom matchers here.
// Example: registerMatcher("device", deviceMatcher);

// -- Loader Cache --
// Register cached loaders here if needed.
// Example:
// import { createCachedLoader } from "@decocms/start/loaders";
// registerLoader("productList", createCachedLoader(vtexProductList, { ttl: 60_000 }));

// -- CMS Blocks --
// Load generated blocks at module level so they're available for resolution.
import "./server/cms/blocks.gen";
`;
}
