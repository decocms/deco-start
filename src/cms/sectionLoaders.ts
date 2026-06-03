/**
 * Section Loader Registry
 *
 * Section loaders enrich resolved CMS props with server-side data
 * (e.g., price simulations, device detection) that can't be done
 * at the CMS resolution level.
 *
 * This runs AFTER resolveDecoPage and BEFORE React rendering,
 * inside the TanStack Start server function.
 */

import { getCacheProfile } from "../sdk/cacheHeaders";
import { djb2 } from "../sdk/djb2";
import { withTracing } from "../sdk/observability";
import type { ResolvedSection } from "./resolve";

export type SectionLoaderFn = (
  props: Record<string, unknown>,
  req: Request,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

// globalThis-backed: server function split modules need access
const G = globalThis as any;
if (!G.__deco) G.__deco = {};
if (!G.__deco.sectionLoaderRegistry) G.__deco.sectionLoaderRegistry = new Map();
if (!G.__deco.layoutSections) G.__deco.layoutSections = new Set();
if (!G.__deco.cacheableSections) G.__deco.cacheableSections = new Map();

const loaderRegistry: Map<string, SectionLoaderFn> = G.__deco.sectionLoaderRegistry;

// ---------------------------------------------------------------------------
// Cacheable section loaders — SWR cache for section loader results
// ---------------------------------------------------------------------------

interface CacheableSectionConfig {
  maxAge: number;
}

export type CacheableSectionInput =
  | CacheableSectionConfig
  | import("../sdk/cacheHeaders").CacheProfileName;

function resolveSectionCacheConfig(input: CacheableSectionInput): CacheableSectionConfig {
  if (typeof input === "string") {
    const profile = getCacheProfile(input);
    return { maxAge: profile.loader.fresh };
  }
  return input;
}

const cacheableSections: Map<string, CacheableSectionConfig> = G.__deco.cacheableSections;

interface SectionCacheEntry {
  section: ResolvedSection;
  createdAt: number;
  refreshing: boolean;
}

const sectionLoaderCache = new Map<string, SectionCacheEntry>();
const sectionLoaderInflight = new Map<string, Promise<ResolvedSection>>();
const MAX_SECTION_CACHE_ENTRIES = 200;

function evictSectionCacheIfNeeded() {
  if (sectionLoaderCache.size <= MAX_SECTION_CACHE_ENTRIES) return;
  const oldest = [...sectionLoaderCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  const toDelete = oldest.slice(0, sectionLoaderCache.size - MAX_SECTION_CACHE_ENTRIES);
  for (const [key] of toDelete) sectionLoaderCache.delete(key);
}

function sectionCacheKey(component: string, props: Record<string, unknown>): string {
  return `${component}::${djb2(JSON.stringify(props))}`;
}

/**
 * Register section components whose loader results should be cached.
 * Uses SWR (stale-while-revalidate) semantics: stale results are returned
 * immediately while a background refresh runs.
 *
 * Works for both eager sections (speeds up SSR) and deferred sections
 * (speeds up individual fetch on scroll).
 */
export function registerCacheableSections(configs: Record<string, CacheableSectionInput>): void {
  for (const [key, config] of Object.entries(configs)) {
    cacheableSections.set(key, resolveSectionCacheConfig(config));
  }
}

function runCacheableSectionLoader(
  section: ResolvedSection,
  loader: SectionLoaderFn,
  request: Request,
  config: CacheableSectionConfig,
): Promise<ResolvedSection> {
  const key = sectionCacheKey(section.component, section.props as Record<string, unknown>);

  const existing = sectionLoaderInflight.get(key);
  if (existing) return existing;

  const entry = sectionLoaderCache.get(key);
  const now = Date.now();
  const isStale = entry ? now - entry.createdAt > config.maxAge : true;

  if (entry && !isStale) {
    return Promise.resolve(entry.section);
  }

  if (entry && isStale && !entry.refreshing) {
    entry.refreshing = true;
    void Promise.resolve(loader(section.props as Record<string, unknown>, request))
      .then((enrichedProps) => {
        const enriched = { ...section, props: enrichedProps };
        sectionLoaderCache.set(key, {
          section: enriched,
          createdAt: Date.now(),
          refreshing: false,
        });
      })
      .catch(() => {
        entry.refreshing = false;
      });
    return Promise.resolve(entry.section);
  }

  if (entry) return Promise.resolve(entry.section);

  const promise = (async () => {
    const enrichedProps = await loader(section.props as Record<string, unknown>, request);
    const enriched = { ...section, props: enrichedProps };
    sectionLoaderCache.set(key, {
      section: enriched,
      createdAt: Date.now(),
      refreshing: false,
    });
    evictSectionCacheIfNeeded();
    return enriched;
  })();

  sectionLoaderInflight.set(key, promise);
  promise.finally(() => sectionLoaderInflight.delete(key));
  return promise;
}

/**
 * Register a server-side loader for a specific section.
 * The loader receives the CMS-resolved props and a Request,
 * and returns enriched props.
 */
export function registerSectionLoader(sectionKey: string, loader: SectionLoaderFn): void {
  loaderRegistry.set(sectionKey, loader);
}

/**
 * Register multiple section loaders at once.
 *
 * Dev-only diagnostic: when a request-dependent loader (one built from
 * `withDevice`/`withMobile`/`withSearchParam`, possibly through `compose`)
 * is registered for a section that's also in `layoutSections`, the layout
 * cache will serve the first visitor's variant to every viewer for
 * `LAYOUT_CACHE_TTL` (5 min). We log a loud warning explaining the
 * remediation options. See #206.
 */
export function registerSectionLoaders(loaders: Record<string, SectionLoaderFn>): void {
  for (const [key, loader] of Object.entries(loaders)) {
    loaderRegistry.set(key, loader);
  }
  if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
    for (const [key, loader] of Object.entries(loaders)) {
      const requestDependent =
        (loader as SectionLoaderFn & { __requestDependent?: boolean }).__requestDependent === true;
      if (requestDependent && layoutSections.has(key)) {
        console.warn(
          `[SectionLoaders] "${key}" is registered as a layout section ` +
            `(cached for 5min by component path) but its loader is request-` +
            `dependent (withDevice/withMobile/withSearchParam). The first ` +
            `visitor's variant will be served to all users for 5min. Fix: ` +
            `(1) remove "export const layout = true" from the section, ` +
            `(2) call unregisterLayoutSections(["${key}"]) in setup.ts ` +
            `after applySectionConventions, or (3) move the request-` +
            `dependent logic out of the layout loader.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Layout section cache — sections whose output doesn't change per-page
// (Header, Footer, Theme, etc.) are cached server-side so they aren't
// re-resolved and re-enriched on every navigation.
//
// Uses in-flight deduplication: if two requests try to resolve the same
// layout section concurrently, the second shares the first's Promise.
// ---------------------------------------------------------------------------

const layoutSections: Set<string> = G.__deco.layoutSections;

const LAYOUT_CACHE_TTL = 5 * 60_000; // 5 minutes

interface CachedSection {
  section: ResolvedSection;
  expiresAt: number;
}

const layoutCache = new Map<string, CachedSection>();
const layoutInflight = new Map<string, Promise<ResolvedSection>>();

/**
 * Register section keys that should be cached as layout sections.
 * Layout sections (Header, Footer, etc.) are cached server-side
 * for LAYOUT_CACHE_TTL to avoid redundant enrichment on every navigation.
 *
 * The cache key is the component path only — it does NOT include UA,
 * cookies, or geo. Sections whose loader depends on those signals must
 * not be layout-cached: see {@link unregisterLayoutSections} to opt a
 * section out of the auto-discovery done by `applySectionConventions`.
 */
export function registerLayoutSections(keys: string[]): void {
  for (const key of keys) {
    layoutSections.add(key);
  }
}

/**
 * Remove section keys from the layout cache set. Use this to opt a section
 * out of caching when `applySectionConventions` auto-registered it via
 * `export const layout = true` but the section's loader is in fact request-
 * dependent (Header with `withDevice()`, geo-aware promo, etc.).
 *
 * Call after `applySectionConventions` and before the first request.
 *
 * See #206 for the contamination bug this prevents.
 */
export function unregisterLayoutSections(keys: string[]): void {
  for (const key of keys) {
    layoutSections.delete(key);
  }
}

/** Check if a section key is registered as a layout section. */
export function isLayoutSection(key: string): boolean {
  return layoutSections.has(key);
}

function getCachedLayout(component: string): ResolvedSection | null {
  const entry = layoutCache.get(component);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    layoutCache.delete(component);
    return null;
  }
  return entry.section;
}

function setCachedLayout(component: string, section: ResolvedSection): void {
  layoutCache.set(component, {
    section,
    expiresAt: Date.now() + LAYOUT_CACHE_TTL,
  });
}

/**
 * Run a layout section's loader with in-flight dedup + TTL cache.
 */
function resolveLayoutSection(
  section: ResolvedSection,
  loader: SectionLoaderFn,
  request: Request,
): Promise<ResolvedSection> {
  const key = section.component;

  const cached = getCachedLayout(key);
  if (cached) return Promise.resolve(cached);

  const existing = layoutInflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const enrichedProps = await loader(section.props as Record<string, unknown>, request);
    const enriched = { ...section, props: enrichedProps };
    setCachedLayout(key, enriched);
    return enriched;
  })();

  layoutInflight.set(key, promise);
  promise.finally(() => layoutInflight.delete(key));

  return promise;
}

/**
 * Run registered section loaders against resolved sections.
 * Sections without a registered loader pass through unchanged.
 *
 * Layout sections use in-flight dedup + TTL cache to avoid
 * redundant enrichment across concurrent and sequential requests.
 *
 * Runs all loaders in parallel for performance.
 */
export async function runSectionLoaders(
  sections: ResolvedSection[],
  request: Request,
): Promise<ResolvedSection[]> {
  // Dev warning: detect likely layout sections not registered via registerLayoutSections.
  // Without registration, Header/Footer won't be cached across navigations.
  if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
    for (const s of sections) {
      const key = s.component.toLowerCase();
      if ((key.includes("header") || key.includes("footer")) && !layoutSections.has(s.component)) {
        console.warn(
          `[SectionLoaders] "${s.component}" looks like a layout section but is not in registerLayoutSections(). ` +
            `Add it to registerLayoutSections() in setup.ts for consistent caching across navigations.`,
        );
      }
    }
  }
  return withTracing(
    "deco.section.loaders.batch",
    () => Promise.all(sections.map((section) => runSingleSectionLoader(section, request))),
    { "section.count": sections.length },
  );
}

/**
 * Inject the active request's URL and path into section props so site
 * loaders can read `props.__pageUrl` / `props.__pagePath` without having
 * to derive them from `req.url` themselves.
 *
 * The framework already injects these for commerce loaders (resolve.ts),
 * but section loaders (e.g. category SearchBanner, breadcrumb-aware FAQs)
 * also need to know the active page. Without this, callers had to wrap
 * `loader(...)` themselves in a custom `delegateAfter`-style helper —
 * forgetting it produced silent rendering bugs (empty banners, default
 * fallbacks).
 *
 * Existing values in `props` win — sites that already pre-populated
 * `__pageUrl` (e.g. via a custom mixin) keep their value untouched.
 *
 * Note: this runs only at the point we hand props to the user's loader.
 * The cacheable-section cache key hashes the *original* props (URL-agnostic),
 * so sections registered via `registerCacheableSections` keep sharing a
 * single cache entry across pages.
 */
function injectPageContext(
  props: Record<string, unknown>,
  request: Request,
): Record<string, unknown> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return props;
  }
  const enriched = { ...props } as Record<string, unknown>;
  if (enriched.__pageUrl === undefined) enriched.__pageUrl = request.url;
  if (enriched.__pagePath === undefined) enriched.__pagePath = url.pathname;
  return enriched;
}

/** Wrap a loader so it receives __pageUrl/__pagePath in its props. */
function withPageContext(loader: SectionLoaderFn): SectionLoaderFn {
  return (props, req) => loader(injectPageContext(props, req), req);
}

/**
 * Run a single section's registered loader.
 * Used by both `runSectionLoaders` (batch) and `loadDeferredSection` (individual).
 *
 * Respects three cache tiers:
 * 1. Layout sections (Header/Footer) — 5min TTL + in-flight dedup
 * 2. Cacheable sections (ProductShelf, FAQ) — SWR with configurable maxAge
 * 3. Regular sections — no cache, always fresh
 *
 * After the section's own loader runs, recursively runs loaders for any
 * nested sections found in its resolved props (e.g. wrapper sections with
 * a `sections: Section[]` prop). This eliminates the need for sites to
 * manually walk + invoke `runSingleSectionLoader` on children.
 */
export async function runSingleSectionLoader(
  section: ResolvedSection,
  request: Request,
): Promise<ResolvedSection> {
  return withTracing("deco.section.loader", () => runSingleSectionLoaderImpl(section, request), {
    "deco.section": section.component,
  });
}

async function runSingleSectionLoaderImpl(
  section: ResolvedSection,
  request: Request,
): Promise<ResolvedSection> {
  const loader = loaderRegistry.get(section.component);

  let result: ResolvedSection;

  if (!loader) {
    // No own-loader, but the section may still contain nested sections in
    // its props (CMS-resolved children) that need their loaders run.
    result = section;
  } else {
    // Wrap the loader so __pageUrl/__pagePath are injected at the call site.
    // Cache keys (component name for layout, component+propsHash for cacheable)
    // are computed from the *original* section.props — keeping cache entries
    // URL-agnostic and shared across pages.
    const wrapped = withPageContext(loader);

    if (layoutSections.has(section.component)) {
      try {
        result = await resolveLayoutSection(section, wrapped, request);
      } catch (error) {
        console.error(`[SectionLoader] Error in layout "${section.component}":`, error);
        result = section;
      }
    } else {
      const cacheConfig = cacheableSections.get(section.component);
      if (cacheConfig) {
        try {
          result = await runCacheableSectionLoader(section, wrapped, request, cacheConfig);
        } catch (error) {
          console.error(`[SectionLoader] Error in cacheable "${section.component}":`, error);
          result = section;
        }
      } else {
        try {
          const enrichedProps = await wrapped(section.props as Record<string, unknown>, request);
          result = { ...section, props: enrichedProps };
        } catch (error) {
          console.error(`[SectionLoader] Error in "${section.component}":`, error);
          result = section;
        }
      }
    }
  }

  // Recurse into nested sections AFTER the parent's loader/cache lookup so
  // child sections keep their own cache TTL independent from the parent's.
  // For layout/cacheable parents, this means a 5-min layout cache hit still
  // re-evaluates child sections (whose own caches are usually shorter, e.g.
  // ProductShelf 60s). For leaf sections, `enrichNestedSections` returns
  // the same reference (no allocation, no extra work).
  const props = result.props as Record<string, unknown> | undefined;
  if (props && typeof props === "object") {
    const enrichedProps = await enrichNestedSections(props, request);
    if (enrichedProps !== props) {
      return { ...result, props: enrichedProps };
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Nested section loader support
// ---------------------------------------------------------------------------

/**
 * Type guard: matches the shape produced by `normalizeNestedSections` in
 * resolve.ts — `{ Component: string, props: object }`. This is how the CMS
 * resolver represents nested sections (children of wrapper sections).
 *
 * Note: the `Component` key uses capital C to match the runtime renderer's
 * convention (mirrors deco-cx/deco's Fresh API). Not to be confused with
 * the lowercase `component` on `ResolvedSection`.
 */
function isNestedSection(
  value: unknown,
): value is { Component: string; props: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.Component === "string" &&
    obj.props != null &&
    typeof obj.props === "object" &&
    !Array.isArray(obj.props)
  );
}

/**
 * Walk a props object and run section loaders for any nested sections.
 * Handles direct child sections AND arrays of sections (e.g.
 * `sections: Section[]`, `slides: Slide[]`).
 *
 * Returns the same reference if nothing changed — so leaf sections (the
 * vast majority) incur zero allocation overhead.
 *
 * Concurrency: all nested loader calls run in parallel via Promise.all.
 */
async function enrichNestedSections(
  props: Record<string, unknown>,
  request: Request,
): Promise<Record<string, unknown>> {
  type Pending = {
    key: string;
    index?: number;
    promise: Promise<ResolvedSection>;
  };
  const pending: Pending[] = [];

  for (const [key, value] of Object.entries(props)) {
    if (isNestedSection(value)) {
      pending.push({
        key,
        promise: runSingleSectionLoader(
          {
            component: value.Component,
            props: value.props,
            key: value.Component,
          } as ResolvedSection,
          request,
        ),
      });
      continue;
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (isNestedSection(item)) {
          pending.push({
            key,
            index: i,
            promise: runSingleSectionLoader(
              {
                component: item.Component,
                props: item.props,
                key: item.Component,
              } as ResolvedSection,
              request,
            ),
          });
        }
      }
    }
  }

  if (pending.length === 0) return props;

  const results = await Promise.all(pending.map((p) => p.promise));
  const updated: Record<string, unknown> = { ...props };

  for (let i = 0; i < pending.length; i++) {
    const { key, index } = pending[i];
    const enriched = results[i];
    const nestedValue = { Component: enriched.component, props: enriched.props };

    if (index != null) {
      // Array item — clone the array on first mutation for this key
      const current = updated[key];
      if (current === props[key]) {
        updated[key] = [...(current as unknown[])];
      }
      (updated[key] as unknown[])[index] = nestedValue;
    } else {
      updated[key] = nestedValue;
    }
  }

  return updated;
}
