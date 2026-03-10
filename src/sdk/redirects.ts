/**
 * CMS-managed redirect system.
 *
 * Loads redirect definitions from .deco/blocks/ and provides
 * fast path matching for use in TanStack Start middleware.
 *
 * Supports:
 * - Exact path matches (/old-page -> /new-page)
 * - Glob patterns (/old/* -> /new/*)
 * - Permanent (301) and temporary (302) redirects
 * - CSV import for bulk redirects
 *
 * @example
 * ```ts
 * // In TanStack Start middleware
 * import { loadRedirects, matchRedirect } from "@decocms/start/sdk/redirects";
 * import { loadBlocks } from "@decocms/start/cms";
 *
 * const redirects = loadRedirects(loadBlocks());
 *
 * const middleware = createMiddleware().server(async ({ next, request }) => {
 *   const url = new URL(request.url);
 *   const redirect = matchRedirect(url.pathname, redirects);
 *   if (redirect) {
 *     return new Response(null, {
 *       status: redirect.status,
 *       headers: { Location: redirect.to },
 *     });
 *   }
 *   return next();
 * });
 * ```
 */

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export interface Redirect {
  from: string;
  to: string;
  status: 301 | 302;
}

export interface RedirectMap {
  /** Exact match redirects for O(1) lookup. */
  exact: Map<string, Redirect>;
  /** Glob/prefix redirects checked sequentially (few in practice). */
  patterns: Array<{ prefix: string; redirect: Redirect }>;
}

// -------------------------------------------------------------------------
// Loading from CMS blocks
// -------------------------------------------------------------------------

interface BlockRedirectEntry {
  from: string;
  to: string;
  type?: "permanent" | "temporary";
}

const REDIRECT_RESOLVE_TYPES = new Set([
  "website/loaders/redirect.ts",
  "website/loaders/redirects.ts",
  "website/loaders/redirectsFromCsv.ts",
  "deco-sites/std/loaders/x/redirects.ts",
]);

/**
 * Load all redirect definitions from CMS blocks.
 *
 * Scans the blocks for known redirect resolve types and builds
 * a fast-lookup redirect map.
 */
export function loadRedirects(blocks: Record<string, unknown>): RedirectMap {
  const exact = new Map<string, Redirect>();
  const patterns: Array<{ prefix: string; redirect: Redirect }> = [];

  for (const [_key, block] of Object.entries(blocks)) {
    if (!block || typeof block !== "object") continue;
    const obj = block as Record<string, unknown>;
    const resolveType = obj.__resolveType as string | undefined;

    if (!resolveType || !REDIRECT_RESOLVE_TYPES.has(resolveType)) continue;

    const entries = (obj.redirects ?? obj.redirect) as
      | BlockRedirectEntry[]
      | BlockRedirectEntry
      | undefined;

    if (!entries) continue;

    const list = Array.isArray(entries) ? entries : [entries];

    for (const entry of list) {
      if (!entry.from || !entry.to) continue;

      const redirect: Redirect = {
        from: normalizePath(entry.from),
        to: entry.to,
        status: entry.type === "permanent" ? 301 : 302,
      };

      if (redirect.from.includes("*")) {
        const prefix = redirect.from.replace(/\*+$/, "");
        patterns.push({ prefix, redirect });
      } else {
        exact.set(redirect.from, redirect);
      }
    }
  }

  return { exact, patterns };
}

// -------------------------------------------------------------------------
// CSV import
// -------------------------------------------------------------------------

/**
 * Parse a CSV string into redirect entries.
 *
 * Expected format: `from,to[,type]` (one per line).
 * Lines starting with # are comments. Empty lines are skipped.
 * Type is "permanent" (301) or "temporary" (302, default).
 */
export function parseRedirectsCsv(csv: string): Redirect[] {
  const redirects: Redirect[] = [];
  const lines = csv.split("\n");

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 2) continue;

    const [from, to, type] = parts;
    if (!from || !to) continue;

    redirects.push({
      from: normalizePath(from),
      to,
      status: type === "permanent" || type === "301" ? 301 : 302,
    });
  }

  return redirects;
}

/**
 * Add parsed redirects to an existing redirect map.
 */
export function addRedirects(map: RedirectMap, redirects: Redirect[]): void {
  for (const redirect of redirects) {
    if (redirect.from.includes("*")) {
      const prefix = redirect.from.replace(/\*+$/, "");
      map.patterns.push({ prefix, redirect });
    } else {
      map.exact.set(redirect.from, redirect);
    }
  }
}

// -------------------------------------------------------------------------
// Matching
// -------------------------------------------------------------------------

/**
 * Find a redirect matching the given path.
 *
 * Checks exact matches first (O(1)), then glob patterns (O(n), but
 * typically few patterns exist).
 */
export function matchRedirect(pathname: string, map: RedirectMap): Redirect | null {
  const normalized = normalizePath(pathname);

  const exactMatch = map.exact.get(normalized);
  if (exactMatch) return exactMatch;

  for (const { prefix, redirect } of map.patterns) {
    if (normalized.startsWith(prefix)) {
      const suffix = normalized.slice(prefix.length);
      const to = redirect.to.includes("*") ? redirect.to.replace("*", suffix) : redirect.to;
      return { ...redirect, to };
    }
  }

  return null;
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function normalizePath(path: string): string {
  let p = path.trim();

  // If the "from" is a full URL, extract just the pathname
  if (p.startsWith("http://") || p.startsWith("https://")) {
    try {
      p = new URL(p).pathname;
    } catch {
      // malformed URL, keep as-is and try the prefix fallback
      const slashIdx = p.indexOf("/", p.indexOf("//") + 2);
      p = slashIdx >= 0 ? p.slice(slashIdx) : p;
    }
  }

  if (!p.startsWith("/")) {
    p = "/" + p;
  }
  if (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }
  return p.toLowerCase();
}
