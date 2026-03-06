import { AsyncLocalStorage } from "node:async_hooks";

export type Resolvable = {
  __resolveType?: string;
  [key: string]: unknown;
};

export type DecoPage = {
  name: string;
  path?: string;
  sections: Resolvable[] | Resolvable;
  seo?: Record<string, unknown>;
};

let blockData: Record<string, unknown> = {};

const blocksOverrideStorage = new AsyncLocalStorage<Record<string, unknown>>();

/**
 * Set the blocks data. Called by the site at startup with the generated blocks.
 */
export function setBlocks(blocks: Record<string, unknown>) {
  blockData = blocks;
}

/**
 * Load the current blocks. If running inside a `withBlocksOverride` scope
 * (admin preview), the override is merged on top of the base blocks.
 */
export function loadBlocks(): Record<string, unknown> {
  const override = blocksOverrideStorage.getStore();
  if (override) {
    return { ...blockData, ...override };
  }
  return blockData;
}

/**
 * Run a function with a temporary blocks overlay.
 *
 * Used by admin preview: the admin sends a partial decofile (only the
 * blocks that changed), and `loadBlocks()` returns the merged result
 * for the duration of the render. Other concurrent requests are not
 * affected (AsyncLocalStorage is per-request scoped).
 */
export function withBlocksOverride<T>(
  override: Record<string, unknown>,
  fn: () => T,
): T {
  return blocksOverrideStorage.run(override, fn);
}

export function getAllPages(): Array<{ key: string; page: DecoPage }> {
  const blocks = loadBlocks();
  const pages: Array<{ key: string; page: DecoPage; specificity: number }> = [];

  for (const [key, block] of Object.entries(blocks)) {
    if (!key.startsWith("pages-")) continue;
    const page = block as DecoPage;
    if (!page.sections) continue;
    if (!page.path) continue;

    let specificity = 0;
    if (page.path === "/*") specificity = 0;
    else if (page.path.includes(":") || page.path.includes("$")) specificity = 1;
    else specificity = 2;

    pages.push({ key, page, specificity });
  }

  return pages
    .sort((a, b) => b.specificity - a.specificity)
    .map(({ key, page }) => ({ key, page }));
}

function matchPath(
  pattern: string,
  urlPath: string
): Record<string, string> | null {
  if (pattern === "/*") return { _splat: urlPath };

  const patternParts = pattern.split("/").filter(Boolean);
  const urlParts = urlPath.split("/").filter(Boolean);

  if (patternParts.length !== urlParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    const up = urlParts[i];
    if (pp.startsWith(":")) params[pp.slice(1)] = up;
    else if (pp !== up) return null;
  }

  return params;
}

export function findPageByPath(
  targetPath: string
): { page: DecoPage; params: Record<string, string> } | null {
  const allPages = getAllPages();

  for (const { page } of allPages) {
    if (!page.path) continue;
    const params = matchPath(page.path, targetPath);
    if (params !== null) return { page, params };
  }

  return null;
}
