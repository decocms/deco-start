import type { MigrationContext } from "../types.ts";

export function generateSetup(_ctx: MigrationContext): string {
  return `/**
 * Site setup — registers all sections, loaders and matchers with the CMS.
 *
 * This file is imported by router.tsx at startup.
 * It uses import.meta.glob to lazily discover all section components.
 */
import {
  registerSections,
  loadBlocks,
  setBlocks,
} from "@decocms/start/cms";
import { registerBuiltinMatchers } from "@decocms/start/matchers/builtins";

// -- CMS Blocks --
// Load generated blocks at module level so they're available for resolution.
const blocks = loadBlocks();
setBlocks(blocks);

// -- Section Registry --
// Discovers all .tsx files under src/sections/ and registers them as CMS blocks.
const sectionModules = import.meta.glob("./sections/**/*.tsx");
registerSections(sectionModules);

// -- Matchers --
registerBuiltinMatchers();
`;
}
