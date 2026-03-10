import { findPageByPath, loadBlocks } from "./loader";
import { getSection } from "./registry";

export type ResolvedSection = {
  component: string;
  props: Record<string, unknown>;
  key: string;
};

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

const commerceLoaders: Record<string, CommerceLoader> = {};

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
> = {};

export function registerMatcher(
  key: string,
  fn: (rule: Record<string, unknown>, ctx: MatcherContext) => boolean,
) {
  customMatchers[key] = fn;
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

let initCallback: (() => void) | null = null;
let initialized = false;

export function onBeforeResolve(callback: () => void) {
  initCallback = callback;
}

function ensureInitialized() {
  if (!initialized && initCallback) {
    initCallback();
    initialized = true;
  }
}

// ---------------------------------------------------------------------------
// Matcher evaluation
// ---------------------------------------------------------------------------

function evaluateMatcher(rule: Record<string, unknown> | undefined, ctx: MatcherContext): boolean {
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

  switch (resolveType) {
    case "website/matchers/always.ts":
    case "$live/matchers/MatchAlways.ts":
      return true;

    case "website/matchers/never.ts":
      return false;

    case "website/matchers/device.ts": {
      const ua = (ctx.userAgent || "").toLowerCase();
      const isMobile = /mobile|android|iphone|ipad|ipod|webos|blackberry|opera mini|iemobile/i.test(
        ua,
      );
      if (rule.mobile) return isMobile;
      if (rule.desktop) return !isMobile;
      return true;
    }

    case "website/matchers/random.ts": {
      const traffic = typeof rule.traffic === "number" ? rule.traffic : 0.5;
      return Math.random() < traffic;
    }

    default: {
      const customMatcher = customMatchers[resolveType];
      if (customMatcher) {
        try {
          return customMatcher(rule, ctx);
        } catch {
          return false;
        }
      }
      console.warn(`[CMS] Unknown matcher: ${resolveType}, defaulting to false`);
      return false;
    }
  }
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

  // Lazy section wrapper
  if (resolveType === "website/sections/Rendering/Lazy.tsx") {
    return obj.section ? internalResolve(obj.section, childCtx) : null;
  }

  // Request param extraction
  if (resolveType === "website/functions/requestToParam.ts") {
    const paramName = (obj as any).param as string;
    return rctx.routeParams?.[paramName] ?? null;
  }

  // Commerce extension wrappers — unwrap to inner data
  if (
    resolveType === "commerce/loaders/product/extensions/detailsPage.ts" ||
    resolveType === "commerce/loaders/product/extensions/listingPage.ts"
  ) {
    return obj.data ? internalResolve(obj.data, childCtx) : null;
  }

  // Multivariate flags
  if (
    resolveType === "website/flags/multivariate.ts" ||
    resolveType === "website/flags/multivariate/section.ts"
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

export async function resolveDecoPage(
  targetPath: string,
  matcherCtx?: MatcherContext,
): Promise<{
  name: string;
  path: string;
  params: Record<string, string>;
  resolvedSections: ResolvedSection[];
} | null> {
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
    const resolved = await internalResolve(page.sections, rctx);
    rawSections = Array.isArray(resolved) ? resolved : [];
  }

  const sectionResults = await Promise.all(
    rawSections.map(async (section) => {
      try {
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

          const { __resolveType: _, ...props } = obj;
          results.push({
            component: resolveType,
            props: props as Record<string, unknown>,
            key: resolveType,
          });
        }

        return results;
      } catch (e) {
        onResolveError(e, "section", "Section resolution");
        return [];
      }
    }),
  );

  return {
    name: page.name,
    path: page.path || targetPath,
    params,
    resolvedSections: sectionResults.flat(),
  };
}
