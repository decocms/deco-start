import type { MigrationContext } from "../types.ts";

export function generateSetup(ctx: MigrationContext): string {
  // Detect layout sections (Header, Footer, Theme) from source files
  const layoutSections: string[] = [];
  for (const f of ctx.files) {
    if (f.category !== "section" || f.action === "delete") continue;
    const name = f.path.replace(/^sections\//, "").replace(/\.tsx$/, "");
    const lower = name.toLowerCase();
    if (lower.includes("header") || lower.includes("footer") || lower.includes("theme")) {
      layoutSections.push(`site/sections/${name}.tsx`);
    }
  }
  // Also check islands that became sections
  for (const f of ctx.files) {
    if (f.category !== "island") continue;
    const name = f.path.replace(/^islands\//, "").replace(/\.tsx$/, "");
    const lower = name.toLowerCase();
    if (lower.includes("header") || lower.includes("footer") || lower.includes("theme")) {
      layoutSections.push(`site/sections/${name}.tsx`);
    }
  }

  const layoutRegistration = layoutSections.length > 0
    ? `\n// -- Layout Sections (cached across navigations) --
registerLayoutSections([
${layoutSections.map((s) => `  "${s}",`).join("\n")}
]);\n`
    : "";

  const layoutImport = layoutSections.length > 0
    ? "\n  registerLayoutSections," : "";

  return `/**
 * Site setup — registers all sections, loaders and matchers with the CMS.
 *
 * This file is imported by router.tsx at startup.
 * It uses import.meta.glob to lazily discover all section components.
 */
import { blocks as generatedBlocks } from "./server/cms/blocks.gen";
import {
  registerSections,${layoutImport}
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
${layoutRegistration}
// -- Matchers --
registerBuiltinMatchers();
`;
}
