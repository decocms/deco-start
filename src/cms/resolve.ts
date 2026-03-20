import { findPageByPath, loadBlocks } from "./loader";
import { getSection } from "./registry";
import { isLayoutSection, runSingleSectionLoader } from "./sectionLoaders";
import { normalizeUrlsInObject } from "../sdk/normalizeUrls";

// globalThis-backed: share state across Vite server function split modules
const G = globalThis as any;
if (!G.__deco) G.__deco = {};
if (!G.__deco.commerceLoaders) G.__deco.commerceLoaders = {};
if (!G.__deco.customMatchers) G.__deco.customMatchers = {};

// ---------------------------------------------------------------------------
// Well-known resolve types — extracted as constants so they're searchable
// and overridable. Consumers migrating from deco-cx/deco may have blocks
// with these __resolveType strings in their CMS JSON.
// ---------------------------------------------------------------------------

/** @internal */
export const WELL_KNOWN_TYPES = {
  LAZY: "website/sections/Rendering/Lazy.tsx",
  DEFERRED: "website/sections/Rendering/Deferred.tsx",
  REQUEST_TO_PARAM: "website/functions/requestToParam.ts",
  COMMERCE_EXT_DETAILS: "commerce/loaders/product/extensions/detailsPage.ts",
  COMMERCE_EXT_LISTING: "commerce/loaders/product/extensions/listingPage.ts",
  MULTIVARIATE: "website/flags/multivariate.ts",
  MULTIVARIATE_SECTION: "website/flags/multivariate/section.ts",
  PAGE: "website/pages/Page.tsx",
} as const;

export type ResolvedSection = {
  component: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: Record<string, any>;
  key: string;
  /** Original position in the raw section list (used by mergeSections). */
  index?: number;
};

// ---------------------------------------------------------------------------
// Deferred section — a placeholder for sections loaded on scroll
// ---------------------------------------------------------------------------

export interface DeferredSection {
  component: string;
  key: string;
  /** Position in the original page section list. */
  index: number;
  /** CMS-resolved props without section-loader enrichment. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawProps: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Async rendering configuration
// ---------------------------------------------------------------------------

export interface AsyncRenderingConfig {
  /**
   * When true, sections wrapped in `website/sections/Rendering/Lazy.tsx`
   * in the CMS are deferred and loaded on scroll. This respects the
   * editor's per-section choices made in the admin.
   * @default true
   */
  respectCmsLazy: boolean;
  /**
   * Fallback threshold: sections at or above this index are rendered
   * eagerly regardless. Only applies to sections NOT wrapped in Lazy.
   * Set to `Infinity` to disable threshold-based deferral entirely
   * (rely only on CMS Lazy wrappers).
   * @default Infinity
   */
  foldThreshold: number;
  /** Section component keys that must always be rendered eagerly. */
  alwaysEager: Set<string>;
}

// Always read from globalThis so split-module copies see updates
function getAsyncConfig(): AsyncRenderingConfig | null {
  return G.__deco.asyncConfig ?? null;
}

/**
 * Enable async section rendering.
 *
 * By default, respects the CMS Lazy wrapper (`website/sections/Rendering/Lazy.tsx`)
 * as the source of truth — sections the editor marked as Lazy are deferred,
 * everything else is eager.
 *
 * Optionally, `foldThreshold` can be used as a fallback for sections NOT
 * wrapped in Lazy (e.g. defer everything below index 3).
 *
 * When not called, all sections are resolved eagerly (backward compatible).
 */
export function setAsyncRenderingConfig(config?: {
  foldThreshold?: number;
  alwaysEager?: string[];
  respectCmsLazy?: boolean;
}): void {
  G.__deco.asyncConfig = {
    respectCmsLazy: config?.respectCmsLazy ?? true,
    foldThreshold: config?.foldThreshold ?? Infinity,
    alwaysEager: new Set(config?.alwaysEager ?? []),
  };
}

/** Read-only access to the current config (null when disabled). */
export function getAsyncRenderingConfig(): AsyncRenderingConfig | null {
  return getAsyncConfig();
}

// ---------------------------------------------------------------------------
// Bot detection — bots always receive fully eager pages for SEO
// ---------------------------------------------------------------------------

const botPatterns: RegExp[] = [
  /bot|crawl|spider|slurp|facebookexternalhit|mediapartners|google|bing|yandex|baidu|duckduck|teoma|ia_archiver|semrush|ahrefs|lighthouse/i,
];

/**
 * Add a custom bot detection regex.
 * Requests matching any bot pattern receive fully eager pages for SEO.
 */
export function registerBotPattern(pattern: RegExp): void {
  botPatterns.push(pattern);
}

function isBot(userAgent?: string): boolean {
  if (!userAgent) return false;
  return botPatterns.some((re) => re.test(userAgent));
}

export type CommerceLoader = (props: any) => Promise<any>;

/**
 * Context passed through the resolution pipeline.
 * Includes HTTP request info for matcher evaluation and per-request memoization.
 */
export interface MatcherContext {
  userAgent?: string;
  url?: string;
  path?: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  request?: Request;
}

/**
 * Internal resolution context with memoization and error tracking.
 * Created once per resolveDecoPage / resolveValue call tree.
 */
interface ResolveContext {
  routeParams?: Record<string, string>;
  matcherCtx: MatcherContext;
  memo: Map<string, unknown>;
  depth: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SKIP_RESOLVE_TYPES = new Set([
  "Deco",
  "htmx/sections/htmx.tsx",
  "website/sections/Analytics/Analytics.tsx",
  "algolia/sections/Analytics/Algolia.tsx",
  "shopify/loaders/proxy.ts",
  "vtex/loaders/proxy.ts",
  "website/loaders/pages.ts",
  "website/loaders/redirects.ts",
  "website/loaders/fonts/googleFonts.ts",
  "commerce/sections/Seo/SeoPDP.tsx",
  "commerce/sections/Seo/SeoPDPV2.tsx",
  "commerce/sections/Seo/SeoPLP.tsx",
  "commerce/sections/Seo/SeoPLPV2.tsx",
  "website/sections/Seo/Seo.tsx",
  "website/sections/Seo/SeoV2.tsx",
  "deco-sites/std/sections/SEO.tsx",
]);

/** Add a __resolveType that should be skipped during resolution. */
export function addSkipResolveType(resolveType: string) {
  SKIP_RESOLVE_TYPES.add(resolveType);
}

const MAX_RESOLVE_DEPTH = 20;

// ---------------------------------------------------------------------------
// Commerce loaders
// ---------------------------------------------------------------------------

const commerceLoaders: Record<string, CommerceLoader> = G.__deco.commerceLoaders;

export function registerCommerceLoader(key: string, loader: CommerceLoader) {
  commerceLoaders[key] = loader;
}

export function registerCommerceLoaders(loaders: Record<string, CommerceLoader>) {
  Object.assign(commerceLoaders, loaders);
}

// ---------------------------------------------------------------------------
// Custom matchers
// ---------------------------------------------------------------------------

const customMatchers: Record<
  string,
  (rule: Record<string, unknown>, ctx: MatcherContext) => boolean
> = G.__deco.customMatchers;

export function registerMatcher(
  key: string,
  fn: (rule: Record<string, unknown>, ctx: MatcherContext) => boolean,
) {
  customMatchers[key] = fn;
}

// ---------------------------------------------------------------------------
// Built-in matchers — registered through the same API as custom matchers
// ---------------------------------------------------------------------------

if (!G.__deco._builtinMatchersRegistered) {
  G.__deco._builtinMatchersRegistered = true;

  const builtinMatchers: Record<string, (rule: Record<string, unknown>, ctx: MatcherContext) => boolean> = {
    "website/matchers/always.ts": () => true,
    "$live/matchers/MatchAlways.ts": () => true,
    "website/matchers/never.ts": () => false,
    "website/matchers/device.ts": (rule, ctx) => {
      const ua = (ctx.userAgent || "").toLowerCase();
      const isMobile = /mobile|android|iphone|ipad|ipod|webos|blackberry|opera mini|iemobile/i.test(ua);
      if (rule.mobile) return isMobile;
      if (rule.desktop) return !isMobile;
      return true;
    },
    "website/matchers/random.ts": (rule) => {
      const traffic = typeof rule.traffic === "number" ? rule.traffic : 0.5;
      return Math.random() < traffic;
    },
    "website/matchers/date.ts": (rule) => {
      const now = Date.now();
      const start = typeof rule.start === "string" ? new Date(rule.start).getTime() : 0;
      const end = typeof rule.end === "string" ? new Date(rule.end).getTime() : Infinity;
      return now >= start && now <= end;
    },
  };

  for (const [key, fn] of Object.entries(builtinMatchers)) {
    // Only register if not already overridden by consumer
    if (!customMatchers[key]) {
      customMatchers[key] = fn;
    }
  }
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

export type ResolveErrorHandler = (error: unknown, resolveType: string, context: string) => void;

let onResolveError: ResolveErrorHandler = (error, resolveType, context) => {
  console.error(`[CMS] ${context} "${resolveType}" failed:`, error);
};

/** Configure a custom error handler for resolution failures. */
export function setResolveErrorHandler(handler: ResolveErrorHandler) {
  onResolveError = handler;
}

// ---------------------------------------------------------------------------
// Dangling reference handling
// ---------------------------------------------------------------------------

export type DanglingReferenceHandler = (resolveType: string) => unknown;

let onDanglingReference: DanglingReferenceHandler = (resolveType) => {
  console.warn(`[CMS] Unhandled resolver: ${resolveType}`);
  return null;
};

/** Configure how unresolvable __resolveType references are handled. */
export function setDanglingReferenceHandler(handler: DanglingReferenceHandler) {
  onDanglingReference = handler;
}

// ---------------------------------------------------------------------------
// Init hook
// ---------------------------------------------------------------------------

export function onBeforeResolve(callback: () => void) {
  G.__deco.initCallback = callback;
}

function ensureInitialized() {
  if (!G.__deco.initialized && G.__deco.initCallback) {
    G.__deco.initCallback();
    G.__deco.initialized = true;
  }
}

// ---------------------------------------------------------------------------
// Matcher evaluation
// ---------------------------------------------------------------------------

export function evaluateMatcher(rule: Record<string, unknown> | undefined, ctx: MatcherContext): boolean {
  if (!rule) return true;

  const resolveType = rule.__resolveType as string | undefined;
  if (!resolveType) return true;

  const blocks = loadBlocks();

  if (blocks[resolveType]) {
    const resolvedRule = blocks[resolveType] as Record<string, unknown>;
    return evaluateMatcher(
      { ...resolvedRule, ...rule, __resolveType: resolvedRule.__resolveType as string },
      ctx,
    );
  }

  const matcher = customMatchers[resolveType];
  if (matcher) {
    try {
      return matcher(rule, ctx);
    } catch {
      return false;
    }
  }

  console.warn(`[CMS] Unknown matcher: ${resolveType}, defaulting to false`);
  return false;
}

// ---------------------------------------------------------------------------
// Select (partial field picking)
// ---------------------------------------------------------------------------

function applySelect(value: unknown, select?: string[]): unknown {
  if (!select || !select.length || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => applySelect(item, select));

  const result: Record<string, unknown> = {};
  for (const key of select) {
    if (key in (value as Record<string, unknown>)) {
      result[key] = (value as Record<string, unknown>)[key];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Core resolution
// ---------------------------------------------------------------------------

async function resolveProps(
  obj: Record<string, unknown>,
  rctx: ResolveContext,
): Promise<Record<string, unknown>> {
  const entries = Object.entries(obj);
  const resolvedEntries = await Promise.all(
    entries.map(async ([k, v]) => [k, await internalResolve(v, rctx)] as const),
  );
  return Object.fromEntries(resolvedEntries);
}

async function internalResolve(value: unknown, rctx: ResolveContext): Promise<unknown> {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => internalResolve(item, rctx)));
  }

  const obj = value as Record<string, unknown>;

  if (!obj.__resolveType) {
    return resolveProps(obj, rctx);
  }

  const resolveType = obj.__resolveType as string;

  if (SKIP_RESOLVE_TYPES.has(resolveType)) return null;

  if (rctx.depth > MAX_RESOLVE_DEPTH) {
    console.error(`[CMS] Max resolution depth (${MAX_RESOLVE_DEPTH}) exceeded at: ${resolveType}`);
    return null;
  }

  const childCtx: ResolveContext = { ...rctx, depth: rctx.depth + 1 };

  // "resolved" short-circuit
  if (resolveType === "resolved") return obj.data ?? null;

  // Lazy section wrapper — unwrap single inner section
  if (resolveType === WELL_KNOWN_TYPES.LAZY) {
    return obj.section ? internalResolve(obj.section, childCtx) : null;
  }

  // Deferred section wrapper (legacy Fresh/HTMX) — unwrap inner sections array
  if (resolveType === WELL_KNOWN_TYPES.DEFERRED) {
    return obj.sections ? internalResolve(obj.sections, childCtx) : null;
  }

  // Request param extraction
  if (resolveType === WELL_KNOWN_TYPES.REQUEST_TO_PARAM) {
    const paramName = (obj as any).param as string;
    return rctx.routeParams?.[paramName] ?? null;
  }

  // Commerce extension wrappers — unwrap to inner data
  if (
    resolveType === WELL_KNOWN_TYPES.COMMERCE_EXT_DETAILS ||
    resolveType === WELL_KNOWN_TYPES.COMMERCE_EXT_LISTING
  ) {
    return obj.data ? internalResolve(obj.data, childCtx) : null;
  }

  // Multivariate flags
  if (
    resolveType === WELL_KNOWN_TYPES.MULTIVARIATE ||
    resolveType === WELL_KNOWN_TYPES.MULTIVARIATE_SECTION
  ) {
    const variants = obj.variants as Array<{ value: unknown; rule?: unknown }> | undefined;
    if (!variants || variants.length === 0) return null;

    for (const variant of variants) {
      const rule = variant.rule as Record<string, unknown> | undefined;
      if (evaluateMatcher(rule, rctx.matcherCtx)) {
        return internalResolve(variant.value, childCtx);
      }
    }
    return null;
  }

  // Commerce loaders
  const commerceLoader = commerceLoaders[resolveType];
  if (commerceLoader) {
    const { __resolveType: _, ...loaderProps } = obj;
    const resolvedProps = await resolveProps(loaderProps, childCtx);

    if (rctx.matcherCtx.path) {
      resolvedProps.__pagePath = rctx.matcherCtx.path;
    }
    if (rctx.matcherCtx.url) {
      resolvedProps.__pageUrl = rctx.matcherCtx.url;
    }

    try {
      return await commerceLoader(resolvedProps);
    } catch (error) {
      onResolveError(error, resolveType, "Commerce loader");
      return null;
    }
  }

  // Named block reference (memoized)
  const blocks = loadBlocks();
  if (blocks[resolveType]) {
    const memoKey = JSON.stringify(obj);
    if (rctx.memo.has(memoKey)) {
      return rctx.memo.get(memoKey);
    }

    const referencedBlock = blocks[resolveType] as Record<string, unknown>;
    const { __resolveType: _rt, ...restOverrides } = obj;
    const resultPromise = internalResolve({ ...referencedBlock, ...restOverrides }, childCtx);
    rctx.memo.set(memoKey, resultPromise);

    const result = await resultPromise;
    rctx.memo.set(memoKey, result);
    return result;
  }

  // Dangling reference — unresolvable __resolveType
  if (resolveType.includes("/loaders/") || resolveType.includes("/actions/")) {
    return onDanglingReference(resolveType);
  }

  // Unknown type — resolve props but preserve __resolveType (it's a section)
  const { __resolveType: _, ...rest } = obj;
  const resolvedRest = await resolveProps(rest, childCtx);
  return { __resolveType: resolveType, ...resolvedRest };
}

// ---------------------------------------------------------------------------
// Nested section normalization
// ---------------------------------------------------------------------------

/**
 * Recursively walks resolved props and converts nested sections
 * from `{ __resolveType: "site/sections/...", ...props }` to
 * `{ component: "site/sections/...", props: {...} }`.
 *
 * This preserves the same `{ Component, props }` shape used by deco-cx/deco (Fresh)
 * so that section code can be ported without API changes. In TanStack, `Component`
 * is the registry key string (not a function ref), and the renderer does the lookup.
 */
function normalizeNestedSections(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map(normalizeNestedSections);
  }

  const obj = value as Record<string, unknown>;
  const rt = obj.__resolveType as string | undefined;

  if (rt && getSection(rt)) {
    const { __resolveType: _, ...rest } = obj;
    const normalizedProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      normalizedProps[k] = normalizeNestedSections(v);
    }
    return { Component: rt, props: normalizedProps };
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = normalizeNestedSections(v);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a value by recursively processing __resolveType references.
 * Supports memoization, commerce loaders, matchers, and flags.
 */
export async function resolveValue(
  value: unknown,
  routeParams?: Record<string, string>,
  matcherCtx?: MatcherContext,
  options?: { select?: string[] },
): Promise<unknown> {
  const rctx: ResolveContext = {
    routeParams,
    matcherCtx: matcherCtx ?? {},
    memo: new Map(),
    depth: 0,
  };
  const result = await internalResolve(value, rctx);
  return options?.select ? applySelect(result, options.select) : result;
}

// ---------------------------------------------------------------------------
// Layout section CMS-resolve cache
// Caches the fully-resolved CMS output for layout sections so that
// commerce loaders (intelligent-search, cross-selling, etc.) inside
// Header/Footer blocks aren't re-executed on every page navigation.
// ---------------------------------------------------------------------------

const RESOLVE_CACHE_TTL = 5 * 60_000;

interface ResolvedSectionsCache {
  sections: ResolvedSection[];
  expiresAt: number;
}

const resolvedLayoutCache = new Map<string, ResolvedSectionsCache>();
const resolvedLayoutInflight = new Map<string, Promise<ResolvedSection[]>>();

function getCachedResolvedLayout(blockKey: string): ResolvedSection[] | null {
  const entry = resolvedLayoutCache.get(blockKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    resolvedLayoutCache.delete(blockKey);
    return null;
  }
  return entry.sections;
}

function setCachedResolvedLayout(blockKey: string, sections: ResolvedSection[]): void {
  resolvedLayoutCache.set(blockKey, {
    sections,
    expiresAt: Date.now() + RESOLVE_CACHE_TTL,
  });
}

/**
 * Resolves a raw section block to ResolvedSection[].
 * Used for both layout and non-layout sections.
 */
async function resolveRawSection(
  section: unknown,
  rctx: ResolveContext,
): Promise<ResolvedSection[]> {
  const resolved = await internalResolve(section, rctx);
  if (!resolved || typeof resolved !== "object") return [];

  const items = Array.isArray(resolved) ? resolved : [resolved];
  const results: ResolvedSection[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (!obj.__resolveType) continue;

    const resolveType = obj.__resolveType as string;
    const sectionLoader = getSection(resolveType);
    if (!sectionLoader) {
      console.warn(`[CMS] No component registered for: ${resolveType}`);
      continue;
    }

    const { __resolveType: _, ...rawProps } = obj;
    const props = normalizeNestedSections(rawProps) as Record<string, unknown>;
    results.push({
      component: resolveType,
      props,
      key: resolveType,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Page-level SEO block resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the page-level `seo` field from the CMS page JSON.
 *
 * The CMS stores SEO config in `page.seo` as a separate field from
 * `page.sections`. This field is typically a SeoV2.tsx block (homepage)
 * or a site SEO section like SEOPDP.tsx wrapped in Lazy (PDP).
 *
 * This function always resolves eagerly — SEO metadata must never be
 * deferred because search engine crawlers need it in the initial HTML.
 * Lazy/Deferred wrappers are unwrapped, block references are followed,
 * and commerce loader refs (e.g. PDP jsonLD) are resolved.
 *
 * Returns a ResolvedSection with the final component key and resolved props,
 * or null if the seo field is absent/unresolvable.
 */
export async function resolvePageSeoBlock(
  seoBlock: Record<string, unknown> | undefined,
  rctx: ResolveContext,
): Promise<ResolvedSection | null> {
  if (!seoBlock || typeof seoBlock !== "object") return null;

  const blocks = loadBlocks();
  let current = seoBlock;

  for (let depth = 0; depth < 10; depth++) {
    const rt = current.__resolveType as string | undefined;
    if (!rt) return null;

    // Lazy wrapper — always unwrap for SEO (never defer)
    if (rt === "website/sections/Rendering/Lazy.tsx") {
      const inner = current.section;
      if (!inner || typeof inner !== "object") return null;
      current = inner as Record<string, unknown>;
      continue;
    }

    // Deferred wrapper — unwrap
    if (rt === "website/sections/Rendering/Deferred.tsx") {
      const inner = current.sections;
      if (!inner || typeof inner !== "object") return null;
      if (Array.isArray(inner) && inner.length === 1 && inner[0] && typeof inner[0] === "object") {
        current = inner[0] as Record<string, unknown>;
        continue;
      }
      return null;
    }

    // Multivariate flag — evaluate matcher and follow matched variant
    if (
      rt === "website/flags/multivariate.ts" ||
      rt === "website/flags/multivariate/section.ts"
    ) {
      const variants = current.variants as Array<{ value: unknown; rule?: unknown }> | undefined;
      if (!variants?.length) return null;
      let matched: unknown = null;
      for (const variant of variants) {
        const rule = variant.rule as Record<string, unknown> | undefined;
        if (evaluateMatcher(rule, rctx.matcherCtx)) {
          matched = variant.value;
          break;
        }
      }
      if (!matched || typeof matched !== "object") return null;
      current = matched as Record<string, unknown>;
      continue;
    }

    // Named block reference — follow the chain
    const block = blocks[rt] as Record<string, unknown> | undefined;
    if (block) {
      const { __resolveType: _, ...overrides } = current;
      current = { ...block, ...overrides };
      continue;
    }

    // Terminal section (site section or framework SEO type).
    // Resolve all nested prop __resolveType refs (commerce loaders, etc.).
    const { __resolveType: _, ...rawProps } = current;
    try {
      const resolvedProps = await resolveProps(rawProps, rctx);
      return {
        component: rt,
        props: resolvedProps as Record<string, unknown>,
        key: `seo:${rt}`,
      };
    } catch (e) {
      onResolveError(e, rt, "Page SEO resolution");
      return null;
    }
  }

  return null;
}

/**
 * Check if a raw CMS section block will produce a layout section.
 * Walks the block reference chain (up to 5 levels) to find the final
 * section component key. Returns the top-level block name for caching.
 *
 * Example: {"__resolveType": "Header - 01"} -> block has
 * __resolveType "site/sections/Header/Header.tsx" -> that's a layout section
 * -> returns "Header - 01" as the cache key.
 */
function isRawSectionLayout(section: unknown): string | null {
  if (!section || typeof section !== "object") return null;
  const obj = section as Record<string, unknown>;
  const topLevelRt = obj.__resolveType as string | undefined;
  if (!topLevelRt) return null;

  if (isLayoutSection(topLevelRt)) return topLevelRt;

  const blocks = loadBlocks();
  let currentRt: string | undefined = topLevelRt;
  for (let i = 0; i < 5; i++) {
    const block = blocks[currentRt] as Record<string, unknown> | undefined;
    if (!block) break;
    currentRt = block.__resolveType as string | undefined;
    if (!currentRt) break;
    if (isLayoutSection(currentRt)) return topLevelRt;
  }

  return null;
}

/**
 * Resolve the final section component key by walking block references,
 * unwrapping Lazy/Deferred wrappers, and evaluating multivariate flags.
 * Returns null if not determinable.
 */
function resolveFinalSectionKey(
  section: unknown,
  matcherCtx?: MatcherContext,
): string | null {
  if (!section || typeof section !== "object") return null;

  const blocks = loadBlocks();
  let current = section as Record<string, unknown>;

  for (let depth = 0; depth < 10; depth++) {
    const rt = current.__resolveType as string | undefined;
    if (!rt) return null;

    // Lazy wrapper — unwrap single inner section
    if (rt === WELL_KNOWN_TYPES.LAZY) {
      const inner = current.section;
      if (!inner || typeof inner !== "object") return null;
      current = inner as Record<string, unknown>;
      continue;
    }

    // Deferred wrapper (legacy) — unwrap first inner section if deterministic
    if (rt === "website/sections/Rendering/Deferred.tsx") {
      const inner = current.sections;
      if (!inner || typeof inner !== "object") return null;
      if (Array.isArray(inner)) {
        if (inner.length === 1 && inner[0] && typeof inner[0] === "object") {
          current = inner[0] as Record<string, unknown>;
          continue;
        }
        return null;
      }
      // sections is an object (e.g. a flag) — follow it
      current = inner as Record<string, unknown>;
      continue;
    }

    if (
      rt === WELL_KNOWN_TYPES.MULTIVARIATE ||
      rt === WELL_KNOWN_TYPES.MULTIVARIATE_SECTION
    ) {
      const variants = current.variants as
        | Array<{ value: unknown; rule?: unknown }>
        | undefined;
      if (!variants?.length) return null;

      let matched: unknown = null;
      for (const variant of variants) {
        const rule = variant.rule as Record<string, unknown> | undefined;
        if (evaluateMatcher(rule, matcherCtx ?? {})) {
          matched = variant.value;
          break;
        }
      }
      if (!matched || typeof matched !== "object") return null;
      current = matched as Record<string, unknown>;
      continue;
    }

    if (getSection(rt)) return rt;

    const block = blocks[rt] as Record<string, unknown> | undefined;
    if (block) {
      const { __resolveType: _, ...overrides } = current;
      current = { ...block, ...overrides };
      continue;
    }

    return rt;
  }

  return null;
}

/**
 * Walk the full wrapper chain (block refs, multivariate flags, Lazy, Deferred)
 * and return true if a deferral wrapper (Lazy.tsx or Deferred.tsx) is found
 * at any level. This is used by shouldDeferSection to determine if the CMS
 * editor intended this section to be deferred.
 */
function isCmsDeferralWrapped(section: unknown, matcherCtx?: MatcherContext): boolean {
  if (!section || typeof section !== "object") return false;

  const blocks = loadBlocks();
  let current = section as Record<string, unknown>;

  for (let depth = 0; depth < 10; depth++) {
    const rt = current.__resolveType as string | undefined;
    if (!rt) return false;

    if (
      rt === WELL_KNOWN_TYPES.LAZY ||
      rt === WELL_KNOWN_TYPES.DEFERRED
    ) {
      return true;
    }

    // Walk through multivariate flags to check the matched variant
    if (
      rt === WELL_KNOWN_TYPES.MULTIVARIATE ||
      rt === WELL_KNOWN_TYPES.MULTIVARIATE_SECTION
    ) {
      const variants = current.variants as
        | Array<{ value: unknown; rule?: unknown }>
        | undefined;
      if (!variants?.length) return false;

      let matched: unknown = null;
      for (const variant of variants) {
        const rule = variant.rule as Record<string, unknown> | undefined;
        if (evaluateMatcher(rule, matcherCtx ?? {})) {
          matched = variant.value;
          break;
        }
      }
      if (!matched || typeof matched !== "object") return false;
      current = matched as Record<string, unknown>;
      continue;
    }

    // Named block reference — follow the chain
    const block = blocks[rt] as Record<string, unknown> | undefined;
    if (block) {
      const { __resolveType: _, ...overrides } = current;
      current = { ...block, ...overrides, __resolveType: block.__resolveType as string };
      continue;
    }

    return false;
  }

  return false;
}

function shouldDeferSection(
  section: unknown,
  flatIndex: number,
  cfg: AsyncRenderingConfig,
  isBotReq: boolean,
  matcherCtx?: MatcherContext,
): boolean {
  if (isBotReq) return false;

  if (!section || typeof section !== "object") return false;
  const obj = section as Record<string, unknown>;
  const rt = obj.__resolveType as string | undefined;
  if (!rt) return false;

  const finalKey = resolveFinalSectionKey(section, matcherCtx);
  if (!finalKey) return false;

  if (cfg.alwaysEager.has(finalKey)) return false;
  if (isLayoutSection(finalKey)) return false;

  // Walk the full wrapper chain (including multivariate flags) to detect
  // Lazy.tsx or Deferred.tsx wrappers at any nesting level.
  if (cfg.respectCmsLazy && isCmsDeferralWrapped(section, matcherCtx)) return true;

  // Fallback: threshold-based deferral for non-Lazy sections
  if (flatIndex >= cfg.foldThreshold) return true;

  return false;
}

/**
 * Follow the block reference chain to find the final section component
 * and collect the CMS props WITHOUT running commerce loaders.
 * Resolves named block references, Lazy/Deferred wrappers, and multivariate flags.
 *
 * For Deferred.tsx with a single inner section, the inner section is returned.
 * For Deferred.tsx with multiple inner sections, returns null (falls back to eager).
 */
function resolveSectionShallow(
  section: unknown,
  matcherCtx?: MatcherContext,
): DeferredSection | null {
  if (!section || typeof section !== "object") return null;

  const blocks = loadBlocks();
  let current = section as Record<string, unknown>;
  const MAX_DEPTH = 10;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const rt = current.__resolveType as string | undefined;
    if (!rt) return null;

    if (SKIP_RESOLVE_TYPES.has(rt)) return null;

    // Lazy wrapper — unwrap to the inner section
    if (rt === WELL_KNOWN_TYPES.LAZY) {
      const inner = current.section;
      if (!inner || typeof inner !== "object") return null;
      current = inner as Record<string, unknown>;
      continue;
    }

    // Deferred wrapper (legacy) — unwrap if it contains a single section
    if (rt === "website/sections/Rendering/Deferred.tsx") {
      const inner = current.sections;
      if (!inner || typeof inner !== "object") return null;
      if (Array.isArray(inner)) {
        if (inner.length === 1 && inner[0] && typeof inner[0] === "object") {
          current = inner[0] as Record<string, unknown>;
          continue;
        }
        // Multiple inner sections can't be represented as a single DeferredSection
        return null;
      }
      // sections is an object (e.g. a flag) — follow it
      current = inner as Record<string, unknown>;
      continue;
    }

    // Multivariate flags — evaluate matchers and continue with matched variant
    if (
      rt === WELL_KNOWN_TYPES.MULTIVARIATE ||
      rt === WELL_KNOWN_TYPES.MULTIVARIATE_SECTION
    ) {
      const variants = current.variants as
        | Array<{ value: unknown; rule?: unknown }>
        | undefined;
      if (!variants?.length) return null;

      let matched: unknown = null;
      for (const variant of variants) {
        const rule = variant.rule as Record<string, unknown> | undefined;
        if (evaluateMatcher(rule, matcherCtx ?? {})) {
          matched = variant.value;
          break;
        }
      }
      if (!matched || typeof matched !== "object") return null;
      current = matched as Record<string, unknown>;
      continue;
    }

    // Check if this is a registered section — we found it
    if (getSection(rt)) {
      const { __resolveType: _, ...rawProps } = current;
      return {
        component: rt,
        key: rt,
        index: -1,
        rawProps: rawProps as Record<string, unknown>,
      };
    }

    // Named block reference — follow the chain
    const block = blocks[rt] as Record<string, unknown> | undefined;
    if (block) {
      const { __resolveType: _rtOuter, ...overrides } = current;
      current = { ...block, ...overrides };
      continue;
    }

    return null;
  }

  return null;
}

/**
 * Resolve outer wrappers (flags, block references) around the sections list
 * to get the raw section array without resolving each individual section.
 * This allows the eager/deferred split to happen before section resolution.
 */
export async function resolveSectionsList(
  value: unknown,
  rctx: ResolveContext,
  depth = 0,
): Promise<unknown[]> {
  if (depth > MAX_RESOLVE_DEPTH) return [];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value;

  const obj = value as Record<string, unknown>;
  const rt = obj.__resolveType as string | undefined;

  // Page-level variant wrapper without __resolveType
  // (CMS admin wraps ALL sections in a variant object with { variants: [...] })
  if (!rt && Array.isArray(obj.variants)) {
    const variants = obj.variants as Array<{ value: unknown; rule?: unknown }>;
    for (const variant of variants) {
      const rule = variant.rule as Record<string, unknown> | undefined;
      if (evaluateMatcher(rule, rctx.matcherCtx)) {
        return resolveSectionsList(variant.value, rctx, depth + 1);
      }
    }
    return [];
  }

  if (!rt) return [];

  // Multivariate flags — evaluate matchers and recurse into matched variant
  if (rt === WELL_KNOWN_TYPES.MULTIVARIATE || rt === WELL_KNOWN_TYPES.MULTIVARIATE_SECTION) {
    const variants = obj.variants as Array<{ value: unknown; rule?: unknown }> | undefined;
    if (!variants?.length) return [];
    for (const variant of variants) {
      const rule = variant.rule as Record<string, unknown> | undefined;
      if (evaluateMatcher(rule, rctx.matcherCtx)) {
        return resolveSectionsList(variant.value, rctx, depth + 1);
      }
    }
    return [];
  }

  // Named block reference — follow the chain
  const blocks = loadBlocks();
  if (blocks[rt]) {
    const referencedBlock = blocks[rt] as Record<string, unknown>;
    const { __resolveType: _rtOuter, ...restOverrides } = obj;
    return resolveSectionsList({ ...referencedBlock, ...restOverrides }, rctx, depth + 1);
  }

  // Resolved — unwrap
  if (rt === "resolved") {
    const data = obj.data;
    if (Array.isArray(data)) return data;
    return [];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Page-level SEO — extracted from registered SEO sections after resolution
// ---------------------------------------------------------------------------

export interface PageSeo {
  title?: string;
  description?: string;
  canonical?: string;
  image?: string;
  noIndexing?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jsonLDs?: Record<string, any>[];
  /** Open Graph type — "website" (default), "product", etc. */
  type?: string;
}

const seoSectionKeys: Set<string> = G.__deco.seoSections ?? (G.__deco.seoSections = new Set());

/**
 * Register section component keys whose resolved props contribute page-level
 * SEO metadata (title, description, canonical, image, jsonLDs, noIndexing).
 *
 * After section loaders run, the framework scans these sections and extracts
 * their SEO fields into `DecoPageResult.seo`, which `cmsRouteConfig` uses
 * to generate `<head>` metadata (meta tags, OG, canonical, robots).
 *
 * JSON-LD structured data stays in the section props for the section
 * component to render as `<script type="application/ld+json">`.
 */
export function registerSeoSections(keys: string[]): void {
  for (const k of keys) seoSectionKeys.add(k);
}

/** Check if a section key is registered as an SEO section. */
export function isSeoSection(key: string): boolean {
  return seoSectionKeys.has(key);
}

/**
 * Pick standard SEO fields from a props object.
 * Works for both framework SEO types (SeoV2) and site SEO sections (SEOPDP).
 */
export function extractSeoFromProps(props: Record<string, unknown>): PageSeo {
  const seo: PageSeo = {};
  if (props.title) seo.title = props.title as string;
  if (props.description) seo.description = props.description as string;
  if (props.canonical) seo.canonical = props.canonical as string;
  if (props.image) seo.image = props.image as string;
  if (props.noIndexing !== undefined) seo.noIndexing = props.noIndexing as boolean;
  if (props.type) seo.type = props.type as string;
  if (Array.isArray(props.jsonLDs) && props.jsonLDs.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seo.jsonLDs = props.jsonLDs as Record<string, any>[];
  }
  return seo;
}

/**
 * Extract SEO metadata from resolved sections registered via
 * `registerSeoSections`. Later sections override earlier ones
 * (e.g., a PDP SEO section overrides a generic page SEO).
 */
export function extractSeoFromSections(sections: ResolvedSection[]): PageSeo {
  const seo: PageSeo = {};
  for (const section of sections) {
    if (!seoSectionKeys.has(section.component)) continue;
    const extracted = extractSeoFromProps(section.props);
    if (extracted.jsonLDs) {
      extracted.jsonLDs = [...(seo.jsonLDs ?? []), ...extracted.jsonLDs];
    }
    Object.assign(seo, extracted);
  }
  return seo;
}

export interface DecoPageResult {
  name: string;
  path: string;
  params: Record<string, string>;
  resolvedSections: ResolvedSection[];
  deferredSections: DeferredSection[];
  /**
   * Resolved SEO block from the page-level `seo` field in the CMS JSON.
   * Contains the section component key and resolved props (with commerce
   * loader data already fetched). Needs section loader enrichment in
   * cmsRoute before SEO fields can be extracted.
   */
  seoSection?: ResolvedSection | null;
}

export async function resolveDecoPage(
  targetPath: string,
  matcherCtx?: MatcherContext,
): Promise<DecoPageResult | null> {
  ensureInitialized();

  const match = findPageByPath(targetPath);
  if (!match) {
    console.warn(`[CMS] No page found for path: ${targetPath}`);
    return null;
  }

  const { page, params } = match;
  const ctx: MatcherContext = { ...matcherCtx, path: targetPath };
  const rctx: ResolveContext = { routeParams: params, matcherCtx: ctx, memo: new Map(), depth: 0 };

  let rawSections: unknown[];
  if (Array.isArray(page.sections)) {
    rawSections = page.sections;
  } else {
    // Resolve outer flag/wrapper to get the section array
    // without recursively resolving each individual section.
    const resolved = await resolveSectionsList(page.sections, rctx);
    rawSections = resolved;
  }

  const isBotReq = isBot(matcherCtx?.userAgent);
  const currentAsyncConfig = getAsyncConfig();
  const useAsync = currentAsyncConfig !== null && !isBotReq;

  const eagerResults: (ResolvedSection[] | Promise<ResolvedSection[]>)[] = [];
  const deferredSections: DeferredSection[] = [];
  let flatIndex = 0;

  for (const section of rawSections) {
    const currentFlatIndex = flatIndex;

    const shouldDefer =
      useAsync && shouldDeferSection(section, currentFlatIndex, currentAsyncConfig!, isBotReq, ctx);

    if (shouldDefer) {
      let deferredOk = false;
      try {
        const deferred = resolveSectionShallow(section, ctx);
        if (deferred) {
          deferred.index = currentFlatIndex;
          deferredSections.push(deferred);
          deferredOk = true;
        }
      } catch (e) {
        onResolveError(e, "section", "Deferred section resolution");
      }

      if (!deferredOk) {
        // Shallow resolution failed — fall back to eager resolution
        const idx = currentFlatIndex;
        eagerResults.push(
          resolveRawSection(section, rctx).then((sections) => {
            for (const s of sections) s.index = idx;
            return sections;
          }),
        );
      }
      flatIndex++;
    } else {
      // Eager: full resolution (existing logic)
      const promise = (async (): Promise<ResolvedSection[]> => {
        try {
          const layoutKey = isRawSectionLayout(section);

          if (layoutKey) {
            const cached = getCachedResolvedLayout(layoutKey);
            if (cached) return cached;

            const inflight = resolvedLayoutInflight.get(layoutKey);
            if (inflight) return inflight;

            const p = resolveRawSection(section, rctx).then((results) => {
              setCachedResolvedLayout(layoutKey, results);
              return results;
            });
            resolvedLayoutInflight.set(layoutKey, p);
            p.finally(() => resolvedLayoutInflight.delete(layoutKey));
            return p;
          }

          return resolveRawSection(section, rctx);
        } catch (e) {
          onResolveError(e, "section", "Section resolution");
          return [];
        }
      })();

      const idx = currentFlatIndex;
      eagerResults.push(promise.then((sections) => {
        for (const s of sections) s.index = idx;
        return sections;
      }));
      flatIndex++;
    }
  }

  const allResults = await Promise.all(eagerResults);

  // Resolve page-level SEO block (page.seo field) — always eager.
  // Runs after sections to benefit from memoized commerce loader results.
  let seoSection: ResolvedSection | null = null;
  if (page.seo) {
    try {
      seoSection = await resolvePageSeoBlock(
        page.seo as Record<string, unknown>,
        rctx,
      );
    } catch (e) {
      onResolveError(e, "page.seo", "Page SEO block resolution");
    }
  }

  return {
    name: page.name,
    path: page.path || targetPath,
    params,
    resolvedSections: allResults.flat(),
    deferredSections,
    seoSection,
  };
}

/**
 * Resolve a raw sections array into ResolvedSection[] with the same
 * optimizations as resolveDecoPage: parallel resolution, layout caching,
 * in-flight dedup, and memoization.
 *
 * Unlike resolveDecoPage, this does NOT look up a page by path — the
 * caller provides the raw section array directly. Used by the admin
 * preview renderer where page data comes from the POST body.
 *
 * All sections are resolved eagerly (no deferred/async split) since
 * admin previews need the full rendered output.
 */
export async function resolvePageSections(
  rawSectionsInput: unknown,
  matcherCtx?: MatcherContext,
): Promise<ResolvedSection[]> {
  ensureInitialized();

  const ctx: MatcherContext = matcherCtx ?? {};
  const rctx: ResolveContext = { matcherCtx: ctx, memo: new Map(), depth: 0 };

  let rawSections: unknown[];
  if (Array.isArray(rawSectionsInput)) {
    rawSections = rawSectionsInput;
  } else {
    rawSections = await resolveSectionsList(rawSectionsInput, rctx);
  }

  const eagerResults: Promise<ResolvedSection[]>[] = [];

  for (const section of rawSections) {
    const promise = (async (): Promise<ResolvedSection[]> => {
      try {
        const layoutKey = isRawSectionLayout(section);

        if (layoutKey) {
          const cached = getCachedResolvedLayout(layoutKey);
          if (cached) return cached;

          const inflight = resolvedLayoutInflight.get(layoutKey);
          if (inflight) return inflight;

          const p = resolveRawSection(section, rctx).then((results) => {
            setCachedResolvedLayout(layoutKey, results);
            return results;
          });
          resolvedLayoutInflight.set(layoutKey, p);
          p.finally(() => resolvedLayoutInflight.delete(layoutKey));
          return p;
        }

        return resolveRawSection(section, rctx);
      } catch (e) {
        onResolveError(e, "section", "Preview section resolution");
        return [];
      }
    })();

    eagerResults.push(promise);
  }

  const allResults = await Promise.all(eagerResults);
  return allResults.flat();
}

/**
 * Resolve a single deferred section's raw props into a fully resolved section.
 * Called by the loadDeferredSection server function when a section scrolls into view.
 *
 * This runs the full resolution pipeline on the raw CMS props:
 * - Resolves nested __resolveType references (commerce loaders, block refs, flags)
 * - Normalizes nested sections to { Component, props } shape
 *
 * After this, the section goes through runSingleSectionLoader for final enrichment.
 */
export async function resolveDeferredSection(
  component: string,
  rawProps: Record<string, unknown>,
  pagePath: string,
  matcherCtx?: MatcherContext,
): Promise<ResolvedSection | null> {
  ensureInitialized();

  const ctx: MatcherContext = { ...matcherCtx, path: pagePath };
  const rctx: ResolveContext = {
    matcherCtx: ctx,
    memo: new Map(),
    depth: 0,
  };

  const resolvedProps = await resolveProps(rawProps, rctx);
  const normalizedProps = normalizeNestedSections(resolvedProps) as Record<string, unknown>;

  return {
    component,
    props: normalizedProps,
    key: component,
  };
}

/**
 * Resolve AND enrich a deferred section in one call.
 * Combines CMS prop resolution (resolveDeferredSection) with section loader
 * enrichment (runSingleSectionLoader) and URL normalization.
 *
 * Used by the route loader to create streaming promises for TanStack's
 * native deferred data pattern — each deferred section becomes an unawaited
 * promise that TanStack streams via SSR.
 */
export async function resolveDeferredSectionFull(
  ds: DeferredSection,
  pagePath: string,
  request: Request,
  matcherCtx?: MatcherContext,
): Promise<ResolvedSection | null> {
  const section = await resolveDeferredSection(
    ds.component,
    ds.rawProps,
    pagePath,
    matcherCtx,
  );
  if (!section) return null;
  section.index = ds.index;
  const enriched = await runSingleSectionLoader(section, request);
  return normalizeUrlsInObject(enriched);
}
