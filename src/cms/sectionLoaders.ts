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

const loaderRegistry: Map<string, SectionLoaderFn> = G.__deco.sectionLoaderRegistry;

// ---------------------------------------------------------------------------
// Cacheable section loaders — SWR cache for section loader results
// ---------------------------------------------------------------------------

interface CacheableSectionConfig {
  maxAge: number;
}

const cacheableSections = new Map<string, CacheableSectionConfig>();

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

function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

function sectionCacheKey(component: string, props: Record<string, unknown>): string {
  return `${component}::${djb2Hash(JSON.stringify(props))}`;
}

/**
 * Register section components whose loader results should be cached.
 * Uses SWR (stale-while-revalidate) semantics: stale results are returned
 * immediately while a background refresh runs.
 *
 * Works for both eager sections (speeds up SSR) and deferred sections
 * (speeds up individual fetch on scroll).
 */
export function registerCacheableSections(configs: Record<string, CacheableSectionConfig>): void {
  for (const [key, config] of Object.entries(configs)) {
    cacheableSections.set(key, config);
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
 */
export function registerSectionLoaders(loaders: Record<string, SectionLoaderFn>): void {
  for (const [key, loader] of Object.entries(loaders)) {
    loaderRegistry.set(key, loader);
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
 */
export function registerLayoutSections(keys: string[]): void {
  for (const key of keys) {
    layoutSections.add(key);
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
  return Promise.all(sections.map((section) => runSingleSectionLoader(section, request)));
}

/**
 * Run a single section's registered loader.
 * Used by both `runSectionLoaders` (batch) and `loadDeferredSection` (individual).
 *
 * Respects three cache tiers:
 * 1. Layout sections (Header/Footer) — 5min TTL + in-flight dedup
 * 2. Cacheable sections (ProductShelf, FAQ) — SWR with configurable maxAge
 * 3. Regular sections — no cache, always fresh
 */
export async function runSingleSectionLoader(
  section: ResolvedSection,
  request: Request,
): Promise<ResolvedSection> {
  const loader = loaderRegistry.get(section.component);
  if (!loader) return section;

  if (layoutSections.has(section.component)) {
    try {
      return await resolveLayoutSection(section, loader, request);
    } catch (error) {
      console.error(`[SectionLoader] Error in layout "${section.component}":`, error);
      return section;
    }
  }

  const cacheConfig = cacheableSections.get(section.component);
  if (cacheConfig) {
    try {
      return await runCacheableSectionLoader(section, loader, request, cacheConfig);
    } catch (error) {
      console.error(`[SectionLoader] Error in cacheable "${section.component}":`, error);
      return section;
    }
  }

  try {
    const enrichedProps = await loader(section.props as Record<string, unknown>, request);
    return { ...section, props: enrichedProps };
  } catch (error) {
    console.error(`[SectionLoader] Error in "${section.component}":`, error);
    return section;
  }
}
