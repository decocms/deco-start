import { blocks as generatedBlocks } from "./blocks.gen";

export type Resolvable = {
  __resolveType?: string;
  [key: string]: unknown;
};

export type DecoPage = {
  name: string;
  path?: string;
  sections: Resolvable[];
  seo?: Record<string, unknown>;
};

export function loadBlocks(): Record<string, unknown> {
  return generatedBlocks;
}

/**
 * Get all CMS page definitions, sorted by specificity (most specific first).
 * Exact paths come first, then parameterized, then wildcards.
 */
export function getAllPages(): Array<{ key: string; page: DecoPage }> {
  const blocks = loadBlocks();
  const pages: Array<{ key: string; page: DecoPage; specificity: number }> = [];

  for (const [key, block] of Object.entries(blocks)) {
    if (!key.startsWith("pages-")) continue;
    const page = block as DecoPage;
    if (!page.sections || !Array.isArray(page.sections)) continue;
    if (!page.path) continue;

    let specificity = 0;
    if (page.path === "/*") {
      specificity = 0;
    } else if (page.path.includes(":") || page.path.includes("$")) {
      specificity = 1;
    } else {
      specificity = 2;
    }

    pages.push({ key, page, specificity });
  }

  return pages
    .sort((a, b) => b.specificity - a.specificity)
    .map(({ key, page }) => ({ key, page }));
}

/**
 * Match a URL path against a CMS page path pattern.
 * Supports:
 *   /exact/path     → exact match
 *   /products/:slug → named parameter capture
 *   /*              → wildcard catch-all
 */
function matchPath(
  pattern: string,
  urlPath: string
): Record<string, string> | null {
  if (pattern === "/*") {
    return { _splat: urlPath };
  }

  const patternParts = pattern.split("/").filter(Boolean);
  const urlParts = urlPath.split("/").filter(Boolean);

  if (patternParts.length !== urlParts.length) return null;

  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    const up = urlParts[i];

    if (pp.startsWith(":")) {
      params[pp.slice(1)] = up;
    } else if (pp !== up) {
      return null;
    }
  }

  return params;
}

/**
 * Find a CMS page block that matches the given URL path.
 * Returns the matched page and extracted route parameters.
 */
export function findPageByPath(
  targetPath: string
): { page: DecoPage; params: Record<string, string> } | null {
  const allPages = getAllPages();

  for (const { page } of allPages) {
    if (!page.path) continue;
    const params = matchPath(page.path, targetPath);
    if (params !== null) {
      return { page, params };
    }
  }

  return null;
}
