/**
 * Site Globals Wrapper
 *
 * Opt-in helper that merges sections declared in the CMS `Site` block
 * (`site.theme + site.global + site.pageSections`) into every page's
 * `resolvedSections` array.
 *
 * Without this wrapper, only `site.seo` is consumed by `cmsRouteConfig` —
 * the rest of the Site block is dormant CMS data. Sites that declare
 * theme/analytics/wishlist/help-button blocks at the site level (rather
 * than per-page) can opt in here to have them rendered automatically.
 *
 * @example Site's `src/routes/$.tsx`:
 * ```ts
 * import { createFileRoute, notFound } from "@tanstack/react-router";
 * import { cmsRouteConfig, withSiteGlobals } from "@decocms/start/routes";
 *
 * export const Route = createFileRoute("/$")({
 *   ...withSiteGlobals(cmsRouteConfig({
 *     siteName: "Bagaggio",
 *     defaultTitle: "Bagaggio",
 *   })),
 *   component: ...,
 * });
 * ```
 */

import type { ResolvedSection } from "../core/cms";
import { loadBlocks, onChange, resolvePageSections } from "../core/cms";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Loader output additions when `withSiteGlobals` is applied. */
export interface SiteGlobalsLoaderData {
  /**
   * Raw refs (before resolution) declared in `site.theme`, `site.global`, and
   * `site.pageSections`. Includes refs for sections that don't resolve into
   * the section tree (`SKIP_RESOLVE_TYPES`) — useful for sites that need to
   * read site-level data (analytics IDs, manifest config, etc.) outside the
   * normal section render path.
   *
   * Ordering: `theme`, then `global`, then `pageSections`.
   */
  rawRefs: unknown[];
}

interface SiteBlock {
  theme?: unknown;
  global?: unknown[];
  pageSections?: unknown[];
}

interface CacheEntry {
  resolvedSections: ResolvedSection[];
  rawRefs: unknown[];
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Globals resolution (cached, with onChange invalidation)
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const cacheTtlMs = DEFAULT_CACHE_TTL_MS;

let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry> | null = null;

onChange(() => {
  cache = null;
  inflight = null;
});

function readSiteBlock(): SiteBlock | null {
  const blocks = loadBlocks();
  // Block keys vary by site convention — try both common cases.
  const site = (blocks.site ?? blocks.Site) as SiteBlock | undefined;
  return site ?? null;
}

function gatherSectionRefs(site: SiteBlock): unknown[] {
  const refs: unknown[] = [];
  if (site.theme) refs.push(site.theme);
  if (Array.isArray(site.global)) refs.push(...site.global);
  if (Array.isArray(site.pageSections)) refs.push(...site.pageSections);
  return refs;
}

const EMPTY_ENTRY: CacheEntry = {
  resolvedSections: [],
  rawRefs: [],
  expiresAt: Number.POSITIVE_INFINITY, // empty entries don't need refresh
};

/**
 * Resolve `site.theme + site.global + site.pageSections` into a list of
 * `ResolvedSection`s, with in-flight dedup and 5-minute SWR caching.
 *
 * Cache is invalidated by `onChange()` from the CMS loader, so admin edits
 * and decofile reloads are reflected on the next request.
 *
 * Exposed as a util so sites can call it directly if they need globals
 * outside the route loader path (rare).
 */
export async function resolveSiteGlobals(): Promise<{
  resolvedSections: ResolvedSection[];
  rawRefs: unknown[];
}> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache;
  if (inflight) return inflight;

  const site = readSiteBlock();
  if (!site) return EMPTY_ENTRY;

  const rawRefs = gatherSectionRefs(site);
  if (rawRefs.length === 0) return EMPTY_ENTRY;

  inflight = (async () => {
    try {
      const resolvedSections = await resolvePageSections(rawRefs);
      const entry: CacheEntry = {
        resolvedSections,
        rawRefs,
        expiresAt: Date.now() + cacheTtlMs,
      };
      cache = entry;
      return entry;
    } catch (err) {
      console.error("[site-globals] failed to resolve:", err);
      // Don't cache failures — let the next request retry.
      return { resolvedSections: [], rawRefs, expiresAt: 0 };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

// ---------------------------------------------------------------------------
// Dedupe — collapse global/pageSection components that also exist on the page
// ---------------------------------------------------------------------------

/**
 * Filter `globals` to remove sections whose `component` already appears in
 * `existing` (page-level sections). Page sections take precedence — globals
 * that conflict are dropped.
 *
 * This collapses the common case where a section like `Session` is declared
 * both in `site.global` and in a page's section list, which would otherwise
 * render twice.
 */
function dedupeGlobals(globals: ResolvedSection[], existing: ResolvedSection[]): ResolvedSection[] {
  if (globals.length === 0) return [];
  const seenComponents = new Set<string>();
  for (const s of existing) {
    if (typeof s.component === "string") seenComponents.add(s.component);
  }
  const result: ResolvedSection[] = [];
  for (const s of globals) {
    if (typeof s.component === "string") {
      if (seenComponents.has(s.component)) continue;
      seenComponents.add(s.component); // also dedupe within globals (e.g. Session in both site.global AND site.pageSections)
    }
    result.push(s);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Loader wrapper
// ---------------------------------------------------------------------------

type AnyLoader = (...args: any[]) => Promise<any>;

function wrapLoader<L extends AnyLoader>(loader: L): L {
  const wrapped: AnyLoader = async (...args: Parameters<L>) => {
    const [page, globals] = await Promise.all([loader(...args), resolveSiteGlobals()]);
    if (!page) return page;

    const existing: ResolvedSection[] =
      (page as { resolvedSections?: ResolvedSection[] }).resolvedSections ?? [];
    const merged = [...dedupeGlobals(globals.resolvedSections, existing), ...existing];

    return {
      ...page,
      resolvedSections: merged,
      siteGlobals: { rawRefs: globals.rawRefs } satisfies SiteGlobalsLoaderData,
    };
  };
  return wrapped as L;
}

// ---------------------------------------------------------------------------
// Public wrapper API
// ---------------------------------------------------------------------------

/**
 * Wrap a route config (from `cmsRouteConfig` or `cmsHomeRouteConfig`) so
 * that its loader merges site globals into `resolvedSections` and exposes
 * the raw site-block refs as `loaderData.siteGlobals.rawRefs`.
 *
 * Sites that don't declare `site.theme/site.global/site.pageSections` in
 * the CMS see no behavior change (the wrapper short-circuits).
 *
 * Ordering: globals render BEFORE page sections (theme injects CSS first,
 * fixed-position helpers mount as asides, etc.). Within globals, ordering
 * is `theme → global → pageSections`.
 */
export function withSiteGlobals<T extends { loader: AnyLoader }>(routeConfig: T): T {
  return {
    ...routeConfig,
    loader: wrapLoader(routeConfig.loader),
  };
}

// ---------------------------------------------------------------------------
// Test-only resets (not exported in public types — used by withSiteGlobals.test.ts)
// ---------------------------------------------------------------------------

/** @internal */
export function __resetSiteGlobalsCache() {
  cache = null;
  inflight = null;
}
