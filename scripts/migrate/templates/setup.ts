import type { MigrationContext } from "../types.ts";

export function generateSetup(_ctx: MigrationContext): string {
  return `/**
 * Site setup — registers all sections, loaders and matchers with the CMS.
 *
 * This file is imported by router.tsx at startup.
 * It uses import.meta.glob to lazily discover all section components.
 */
import { blocks as generatedBlocks } from "./server/cms/blocks.gen";
import {
  registerSections,
  setBlocks,
} from "@decocms/start/cms";
import { registerBuiltinMatchers } from "@decocms/start/matchers/builtins";

// -- CMS Blocks --
// The Vite plugin intercepts the blocks.gen import and injects .deco/blocks/ data.
if (typeof document === "undefined") {
  setBlocks(generatedBlocks);
}

// -- Section Registry --
// CMS blocks reference sections as "site/sections/X.tsx", so we remap the glob keys.
const sectionGlob = import.meta.glob("./sections/**/*.tsx") as Record<string, () => Promise<any>>;
const sections: Record<string, () => Promise<any>> = {};
for (const [path, loader] of Object.entries(sectionGlob)) {
  sections["site/" + path.slice(2)] = loader;
}
registerSections(sections);

// -- Matchers --
registerBuiltinMatchers();
`;
}
