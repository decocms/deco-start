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

// Higher key wins. Compared lexicographically:
//   [hasNoWildcard, literalSegments, paramSegments]
//
// `hasNoWildcard` is the top key so a literal-only path always beats any
// pattern that contains `*` or `{group}?` — including the empty-parts case
// `/` (literals=0) vs the catch-all `/{prefix/}?*` (literals=0, params=1).
// Without this, the URLPattern fix (#213/#214) inadvertently lets a
// `/{group/}?*` catch-all out-rank an exact `/` home page because the
// `{group` segment counted as a param. See deco-sites/granadobr-tanstack
// where `/` was being routed to the granado PDP/PLP block's NotFound
// fallback.
//
// Order produced:
//   /foo/bar (no wildcard, literals=2) > /foo/:x (no wildcard, lit=1, param=1)
//   /foo (no wildcard) > /{granado/}?*  (has wildcard) > /*
function pathSpecificityKey(path: string): [number, number, number] {
  const parts = path.split("/").filter(Boolean);
  let literals = 0;
  let params = 0;
  let hasWildcard = false;
  for (const part of parts) {
    // A wildcard is any `*`, optional group `{...}?`, or any segment
    // bearing `?` — these all make the pattern match strictly more URLs
    // than a plain literal/`:param`/`:slug([\w-]+)` segment, so they
    // are demoted to "least specific" together regardless of count.
    if (part.includes("*") || /[{}?]/.test(part)) {
      hasWildcard = true;
    } else if (part.startsWith(":") || part.startsWith("$")) {
      params++;
    } else {
      literals++;
    }
  }
  return [hasWildcard ? 0 : 1, literals, params];
}

export function getAllPages(): Array<{ key: string; page: DecoPage }> {
  const blocks = loadBlocks();
  const pages: Array<{ key: string; page: DecoPage; key2: [number, number, number] }> = [];

  for (const [key, block] of Object.entries(blocks)) {
    if (!key.startsWith("pages-")) continue;
    const page = block as DecoPage;
    if (!page.sections) continue;
    if (!page.path) continue;

    pages.push({ key, page, key2: pathSpecificityKey(page.path) });
  }

  return pages
    .sort((a, b) => {
      for (let i = 0; i < a.key2.length; i++) {
        if (a.key2[i] !== b.key2[i]) return b.key2[i] - a.key2[i];
      }
      return 0;
    })
    .map(({ key, page }) => ({ key, page }));
}

/**
 * Match a CMS page path pattern against a URL path.
 *
 * Mirrors the original deco-cx/deco Fresh framework
 * (`runtime/features/render.tsx`) by delegating to the platform's native
 * `URLPattern`. Supports the full URLPattern syntax that the admin emits:
 * `:slug`, `:slug([\w-]+)`, optional groups `{...}?`, and trailing `*`
 * splats. Splats are exposed as the standard numbered groups (`"0"`, `"1"`,
 * …), matching the Fresh shape.
 *
 * Malformed patterns return `null` instead of throwing — bad CMS data must
 * never take down the worker.
 */
export function matchPath(
  pattern: string,
  urlPath: string,
): Record<string, string> | null {
  let result: URLPatternResult | null;
  try {
    result = new URLPattern({ pathname: pattern }).exec({ pathname: urlPath });
  } catch {
    return null;
  }
  if (!result) return null;

  const groups = result.pathname.groups as Record<string, string | undefined>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(groups)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
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
