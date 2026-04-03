import type { TransformResult, SectionMeta } from "../types.ts";

/**
 * Adds section convention exports (sync, eager, layout, cache)
 * to section files based on metadata extracted during analysis.
 *
 * These exports are read by generate-sections.ts in @decocms/start
 * to build the sections.gen.ts registry.
 */
export function transformSectionConventions(
  content: string,
  sectionMeta: SectionMeta | undefined,
): TransformResult {
  if (!sectionMeta) {
    return { content, changed: false, notes: [] };
  }

  const notes: string[] = [];
  let result = content;
  let changed = false;

  // Header, footer, theme → eager + sync + layout
  if (sectionMeta.isHeader || sectionMeta.isFooter || sectionMeta.isTheme) {
    if (!result.includes("export const eager")) {
      result += "\nexport const eager = true;\n";
      notes.push("Added: export const eager = true");
      changed = true;
    }
    if (!result.includes("export const sync")) {
      result += "export const sync = true;\n";
      notes.push("Added: export const sync = true");
      changed = true;
    }
    if (!result.includes("export const layout")) {
      result += "export const layout = true;\n";
      notes.push("Added: export const layout = true");
      changed = true;
    }
  }

  // Listing sections → cache = "listing"
  if (sectionMeta.isListing && !result.includes("export const cache")) {
    result += '\nexport const cache = "listing";\n';
    notes.push('Added: export const cache = "listing"');
    changed = true;
  }

  // Sections with loaders that use device → add sync (needs SSR device detection)
  if (sectionMeta.hasLoader && sectionMeta.loaderUsesDevice && !result.includes("export const sync")) {
    result += "\nexport const sync = true;\n";
    notes.push("Added: export const sync = true (loader uses device)");
    changed = true;
  }

  // Generate a basic LoadingFallback if the section doesn't have one
  // and it's a listing section (visible skeleton improvement)
  if (sectionMeta.isListing && !sectionMeta.hasLoadingFallback) {
    result += `
export function LoadingFallback() {
  return (
    <div className="w-full py-8">
      <div className="container mx-auto px-4">
        <div className="h-6 w-48 bg-base-200 animate-pulse rounded mb-4" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <div className="aspect-square bg-base-200 animate-pulse rounded" />
              <div className="h-4 bg-base-200 animate-pulse rounded w-3/4" />
              <div className="h-4 bg-base-200 animate-pulse rounded w-1/2" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
`;
    notes.push("Added: LoadingFallback skeleton for listing section");
    changed = true;
  }

  return { content: result, changed, notes };
}
