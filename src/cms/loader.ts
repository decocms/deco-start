import * as asyncHooks from "node:async_hooks";
import { djb2Hex } from "../sdk/djb2";

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

// globalThis-backed storage: TanStack Start server function split modules
// may get isolated module instances. globalThis ensures shared state.
const G = globalThis as any;
if (!G.__deco) G.__deco = {};

let blockData: Record<string, unknown> = G.__deco.blockData ?? {};
let revision: string | null = G.__deco.revision ?? null;

interface ALSLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}

// AsyncLocalStorage might not be available in client builds (Vite replaces
// node:async_hooks with an empty shim). The namespace import avoids Rollup's
// named-export validation, and the runtime check prevents construction errors.
const ALS = (asyncHooks as any).AsyncLocalStorage;
const blocksOverrideStorage: ALSLike<Record<string, unknown>> = ALS
  ? new ALS()
  : { getStore: () => undefined, run: (_s: any, fn: any) => fn() };

// ---------------------------------------------------------------------------
// Change listeners
// ---------------------------------------------------------------------------

type ChangeListener = (blocks: Record<string, unknown>, revision: string) => void;
const changeListeners: ChangeListener[] = [];

/** Register a callback invoked whenever setBlocks() changes the decofile. */
export function onChange(listener: ChangeListener) {
  changeListeners.push(listener);
  return () => {
    const idx = changeListeners.indexOf(listener);
    if (idx >= 0) changeListeners.splice(idx, 1);
  };
}

// ---------------------------------------------------------------------------
// Revision hashing
// ---------------------------------------------------------------------------

function computeRevision(blocks: Record<string, unknown>): string {
  return djb2Hex(JSON.stringify(blocks));
}

// ---------------------------------------------------------------------------
// Block management
// ---------------------------------------------------------------------------

/**
 * Set the blocks data. Called at startup with generated blocks,
 * and by the admin on hot-reload.
 * Notifies all onChange listeners and updates the revision.
 */
export function setBlocks(blocks: Record<string, unknown>) {
  blockData = blocks;
  revision = computeRevision(blocks);

  // Persist to globalThis so other module instances see them
  G.__deco.blockData = blockData;
  G.__deco.revision = revision;

  for (const listener of [...changeListeners]) {
    try {
      listener(blocks, revision);
    } catch (e) {
      console.error("[CMS] onChange listener error:", e);
    }
  }
}

/**
 * Load the current blocks. If running inside a `withBlocksOverride` scope
 * (admin preview), the override is merged on top of the base blocks.
 */
export function loadBlocks(): Record<string, unknown> {
  // Re-sync from globalThis in case setBlocks was called in another module instance
  if (G.__deco.blockData && G.__deco.blockData !== blockData) {
    blockData = G.__deco.blockData;
    revision = G.__deco.revision ?? null;
  }

  const override = blocksOverrideStorage.getStore();
  if (override) {
    const merged = { ...blockData };
    for (const [key, value] of Object.entries(override)) {
      if (value === null || value === undefined) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
    return merged;
  }
  return blockData;
}

/** Get the current decofile revision hash. Changes on each setBlocks(). */
export function getRevision(): string | null {
  return revision;
}

/**
 * Run a function with a temporary blocks overlay.
 *
 * Used by admin preview: the admin sends a partial decofile (only the
 * blocks that changed), and `loadBlocks()` returns the merged result
 * for the duration of the render. Other concurrent requests are not
 * affected (AsyncLocalStorage is per-request scoped).
 */
export function withBlocksOverride<T>(override: Record<string, unknown>, fn: () => T): T {
  return blocksOverrideStorage.run(override, fn);
}

/**
 * Normalize a CMS page path so downstream consumers (sitemap, resolve
 * results, exact-match comparisons) see a single canonical form.
 *
 * Admin editors occasionally save paths like `/foo/bar/` with a trailing
 * slash. The TanStack catch-all route redirects `/foo/bar/` → `/foo/bar`
 * before matching, so a page registered under the slashed form would be
 * unreachable without normalization. Returns `/` unchanged (the home is
 * the one path that *should* end in a slash).
 */
export function normalizePagePath(path: string): string {
  if (!path || path === "/") return path;
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

export function getAllPages(): Array<{ key: string; page: DecoPage }> {
  const blocks = loadBlocks();
  const pages: Array<{ key: string; page: DecoPage; specificity: number }> = [];

  for (const [key, block] of Object.entries(blocks)) {
    if (!key.startsWith("pages-")) continue;
    const page = block as DecoPage;
    if (!page.sections) continue;
    if (!page.path) continue;

    const normalizedPath = normalizePagePath(page.path);
    const normalizedPage: DecoPage =
      normalizedPath === page.path ? page : { ...page, path: normalizedPath };

    let specificity = 0;
    if (normalizedPath === "/*") specificity = 0;
    else if (normalizedPath.includes(":") || normalizedPath.includes("$")) specificity = 1;
    else specificity = 2;

    pages.push({ key, page: normalizedPage, specificity });
  }

  return pages
    .sort((a, b) => b.specificity - a.specificity)
    .map(({ key, page }) => ({ key, page }));
}

function matchPath(pattern: string, urlPath: string): Record<string, string> | null {
  if (pattern === "/*") return { _splat: urlPath };

  const normalizedPattern = normalizePagePath(pattern);
  const normalizedUrl = normalizePagePath(urlPath);

  const patternParts = normalizedPattern.split("/").filter(Boolean);
  const urlParts = normalizedUrl.split("/").filter(Boolean);

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

/**
 * Extract the site-wide SEO config from the "Site" app block.
 *
 * In the original deco-cx/deco framework this is `ctx.seo` — the app-level
 * SEO configuration that provides fallback title, description, and templates
 * when page-level seo blocks don't supply them.
 */
export function getSiteSeo(): {
  title?: string;
  description?: string;
  titleTemplate?: string;
  descriptionTemplate?: string;
  image?: string;
  favicon?: string;
  themeColor?: string;
  noIndexing?: boolean;
} {
  const blocks = loadBlocks();
  const site = blocks["Site"] as Record<string, unknown> | undefined;
  if (!site) return {};
  const seo = site.seo as Record<string, unknown> | undefined;
  if (!seo) return {};
  return seo as ReturnType<typeof getSiteSeo>;
}

export function findPageByPath(
  targetPath: string,
): { page: DecoPage; params: Record<string, string>; blockKey: string } | null {
  const allPages = getAllPages();

  for (const { key, page } of allPages) {
    if (!page.path) continue;
    const params = matchPath(page.path, targetPath);
    if (params !== null) return { page, params, blockKey: key };
  }

  return null;
}
