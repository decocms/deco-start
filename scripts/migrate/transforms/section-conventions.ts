import type { TransformResult, SectionMeta } from "../types.ts";

/**
 * Adds section convention exports (sync, eager, layout, cache)
 * to section files based on metadata extracted during analysis.
 *
 * These exports are read by generate-sections.ts in @decocms/start
 * to build the sections.gen.ts registry.
 */

const EAGER_SYNC_SECTIONS = new Set([
  "UtilLinks",
  "DepartamentList",
  "ImageGallery",
  "BannersGrid",
  "Carousel",
  "Tipbar",
  "Live",
]);

const SYNC_SECTIONS = new Set([
  "ProductShelf",
  "ProductShelfTabbed",
  "ProductShelfGroup",
  "ProductShelfTopSort",
  "CouponList",
  "NotFoundChallenge",
  "MountedPDP",
  "BackgroundWrapper",
  "SearchResult",
  "LpCartao",
]);

const LISTING_CACHE_SECTIONS = new Set([
  "ProductShelf",
  "ProductShelfTabbed",
  "ProductShelfGroup",
  "ProductShelfTimedOffers",
]);

const STATIC_CACHE_SECTIONS = new Set([
  "InstagramPosts",
  "Faq",
]);

function getSectionBasename(filePath: string): string {
  return filePath.split("/").pop()?.replace(/\.\w+$/, "") || "";
}

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
  const basename = getSectionBasename(sectionMeta.path);

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
    // Header in golden does NOT have layout=true; only footer+theme do
    if ((sectionMeta.isFooter || sectionMeta.isTheme) && !result.includes("export const layout")) {
      result += "export const layout = true;\n";
      notes.push("Added: export const layout = true");
      changed = true;
    }
  }

  // Known eager+sync sections (non-layout)
  if (EAGER_SYNC_SECTIONS.has(basename)) {
    if (!result.includes("export const eager")) {
      result += "\nexport const eager = true;\n";
      notes.push(`Added: export const eager = true (${basename})`);
      changed = true;
    }
    if (!result.includes("export const sync")) {
      result += "export const sync = true;\n";
      notes.push(`Added: export const sync = true (${basename})`);
      changed = true;
    }
  }

  // Known sync-only sections
  if (SYNC_SECTIONS.has(basename) && !result.includes("export const sync")) {
    result += "\nexport const sync = true;\n";
    notes.push(`Added: export const sync = true (${basename})`);
    changed = true;
  }

  // Listing cache sections
  if (LISTING_CACHE_SECTIONS.has(basename) && !result.includes("export const cache")) {
    result += '\nexport const cache = "listing";\n';
    notes.push(`Added: export const cache = "listing" (${basename})`);
    changed = true;
  }

  // Static cache sections
  if (STATIC_CACHE_SECTIONS.has(basename) && !result.includes("export const cache")) {
    result += '\nexport const cache = "static";\n';
    notes.push(`Added: export const cache = "static" (${basename})`);
    changed = true;
  }

  // Generic: listing sections not already matched above
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

  // Sections that render nested Section children need sync so they're in
  // the syncComponents registry (SectionRenderer resolves the string key).
  const hasNestedSections =
    /children:\s*Section\b/.test(result) || /fallback:\s*Section\b/.test(result);
  if (hasNestedSections && !result.includes("export const sync")) {
    result += "\nexport const sync = true;\n";
    notes.push("Added: export const sync = true (renders nested Section children)");
    changed = true;
  }

  // Re-export sections that wrap PDP/nested content need sync too.
  // Detect: file is a re-export AND the target component renders nested Sections
  const isReExport = /^export\s+\{[^}]*default[^}]*\}\s+from\s+/.test(result.trim());
  if (isReExport && (basename === "MountedPDP" || basename === "NotFoundChallenge")) {
    if (!result.includes("export const sync")) {
      result += "\nexport const sync = true;\n";
      notes.push(`Added: export const sync = true (re-export: ${basename})`);
      changed = true;
    }
  }

  // Don't add LoadingFallback re-exports to thin section files —
  // we can't guarantee the target component exports it.
  // Instead, if it's a listing section, a generic skeleton will be added below.

  // Generate a basic LoadingFallback if the section doesn't have one
  // and it's a listing section (visible skeleton improvement)
  if (sectionMeta.isListing && !sectionMeta.hasLoadingFallback && !result.includes("LoadingFallback")) {
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
