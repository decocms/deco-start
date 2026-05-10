import { djb2Hex } from "../sdk/djb2";
import {
  noopRequestStore,
  type RequestStore,
} from "../runtime/requestStore";

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

// Per-request blocks-override storage. The default no-op implementation keeps
// `withBlocksOverride` callable in client / non-server contexts; host
// environments that need request-scoped isolation (e.g. Cloudflare Workers via
// AsyncLocalStorage) inject a backing store with `setBlocksOverrideStore`.
let blocksOverrideStore: RequestStore<Record<string, unknown>> =
  noopRequestStore as RequestStore<Record<string, unknown>>;

/**
 * Inject the per-request store used by `withBlocksOverride` /
 * `getActiveBlocksOverride`. Pass `undefined` to reset to the no-op default.
 */
export function setBlocksOverrideStore(
  store: RequestStore<Record<string, unknown>> | undefined,
): void {
  blocksOverrideStore =
    store ?? (noopRequestStore as RequestStore<Record<string, unknown>>);
}

/** Returns the active blocks override if inside a `withBlocksOverride` scope. */
export function getActiveBlocksOverride(): Record<string, unknown> | undefined {
  return blocksOverrideStore.get();
}

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

  const override = getActiveBlocksOverride();
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
  return blocksOverrideStore.run(override, fn);
}

// Higher key wins. Compared lexicographically:
//   [literalSegments, paramSegments, hasNoSplat]
// So `/foo/bar` > `/foo/:x` > `/foo/*` > `/*`, and `/my-account/*` > `/*`.
function pathSpecificityKey(path: string): [number, number, number] {
  const parts = path.split("/").filter(Boolean);
  let literals = 0;
  let params = 0;
  let hasSplat = false;
  for (const part of parts) {
    if (part === "*") hasSplat = true;
    else if (part.startsWith(":") || part.startsWith("$")) params++;
    else literals++;
  }
  return [literals, params, hasSplat ? 0 : 1];
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

function matchPath(pattern: string, urlPath: string): Record<string, string> | null {
  if (pattern === "/*") return { _splat: urlPath };

  const patternParts = pattern.split("/").filter(Boolean);
  const urlParts = urlPath.split("/").filter(Boolean);

  // Trailing `*` means "match this prefix and any remaining segments".
  const hasSplat = patternParts[patternParts.length - 1] === "*";
  const fixedLen = hasSplat ? patternParts.length - 1 : patternParts.length;

  if (hasSplat) {
    if (urlParts.length < fixedLen) return null;
  } else if (urlParts.length !== fixedLen) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < fixedLen; i++) {
    const pp = patternParts[i];
    const up = urlParts[i];
    if (pp.startsWith(":")) params[pp.slice(1)] = up;
    else if (pp !== up) return null;
  }

  if (hasSplat) params._splat = urlParts.slice(fixedLen).join("/");

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
