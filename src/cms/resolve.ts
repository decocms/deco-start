import { findPageByPath, loadBlocks, type Resolvable } from "./loader";
import { getSection } from "./registry";

export type ResolvedSection = {
  component: string;
  props: Record<string, unknown>;
  key: string;
};

export type CommerceLoader = (props: any) => Promise<any>;

/**
 * Context passed through the resolution pipeline for matcher evaluation.
 * Consumers provide this from the incoming HTTP request.
 */
export interface MatcherContext {
  userAgent?: string;
  url?: string;
  path?: string;
  cookies?: Record<string, string>;
}

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

const commerceLoaders: Record<string, CommerceLoader> = {};

export function registerCommerceLoader(key: string, loader: CommerceLoader) {
  commerceLoaders[key] = loader;
}

export function registerCommerceLoaders(loaders: Record<string, CommerceLoader>) {
  Object.assign(commerceLoaders, loaders);
}

const customMatchers: Record<
  string,
  (rule: Record<string, unknown>, ctx: MatcherContext) => boolean
> = {};

/**
 * Register custom site-level matchers (e.g. "site/matchers/utm.ts").
 */
export function registerMatcher(
  key: string,
  fn: (rule: Record<string, unknown>, ctx: MatcherContext) => boolean,
) {
  customMatchers[key] = fn;
}

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

/**
 * Evaluate a matcher rule object against the current request context.
 * Returns true if the variant should be selected.
 */
function evaluateMatcher(rule: Record<string, unknown> | undefined, ctx: MatcherContext): boolean {
  if (!rule) return true;

  const resolveType = rule.__resolveType as string | undefined;
  if (!resolveType) return true;

  const blocks = loadBlocks();

  // If the rule references a named block (e.g. "Mobile", "Desktop"), resolve it first
  if (blocks[resolveType]) {
    const resolvedRule = blocks[resolveType] as Record<string, unknown>;
    return evaluateMatcher(
      { ...resolvedRule, ...rule, __resolveType: resolvedRule.__resolveType as string },
      ctx,
    );
  }

  switch (resolveType) {
    case "website/matchers/always.ts":
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
      // Deterministic on server: default to the majority branch
      return Math.random() < traffic;
    }

    case "site/matchers/utm.ts": {
      const conditions = rule.conditions as string[] | undefined;
      if (!conditions || conditions.length === 0) return false;
      const currentPath = ctx.path || "";
      const currentUrl = ctx.url || "";
      return conditions.some((c) => currentPath === c || currentUrl.includes(c));
    }

    default: {
      // Check custom registered matchers
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

async function resolveProps(
  obj: Record<string, unknown>,
  routeParams?: Record<string, string>,
  matcherCtx?: MatcherContext,
): Promise<Record<string, unknown>> {
  const entries = Object.entries(obj);
  const resolvedEntries = await Promise.all(
    entries.map(async ([k, v]) => [k, await resolveValue(v, routeParams, matcherCtx)] as const),
  );
  return Object.fromEntries(resolvedEntries);
}

export async function resolveValue(
  value: unknown,
  routeParams?: Record<string, string>,
  matcherCtx?: MatcherContext,
): Promise<unknown> {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolveValue(item, routeParams, matcherCtx)));
  }

  const obj = value as Record<string, unknown>;

  if (!obj.__resolveType) {
    return resolveProps(obj, routeParams, matcherCtx);
  }

  const resolveType = obj.__resolveType as string;

  if (SKIP_RESOLVE_TYPES.has(resolveType)) return null;

  if (resolveType === "website/sections/Rendering/Lazy.tsx") {
    return obj.section ? resolveValue(obj.section, routeParams, matcherCtx) : null;
  }

  if (resolveType === "resolved") return obj.data ?? null;

  if (resolveType === "website/functions/requestToParam.ts") {
    const paramName = (obj as any).param as string;
    return routeParams?.[paramName] ?? null;
  }

  if (
    resolveType === "commerce/loaders/product/extensions/detailsPage.ts" ||
    resolveType === "commerce/loaders/product/extensions/listingPage.ts"
  ) {
    return obj.data ? resolveValue(obj.data, routeParams, matcherCtx) : null;
  }

  if (
    resolveType === "website/flags/multivariate.ts" ||
    resolveType === "website/flags/multivariate/section.ts"
  ) {
    const variants = obj.variants as Array<{ value: unknown; rule?: unknown }> | undefined;
    if (!variants || variants.length === 0) return null;

    const ctx = matcherCtx ?? {};
    for (const variant of variants) {
      const rule = variant.rule as Record<string, unknown> | undefined;
      if (evaluateMatcher(rule, ctx)) {
        return resolveValue(variant.value, routeParams, matcherCtx);
      }
    }

    return null;
  }

  const commerceLoader = commerceLoaders[resolveType];
  if (commerceLoader) {
    const { __resolveType, ...loaderProps } = obj;
    const resolvedProps = await resolveProps(loaderProps, routeParams, matcherCtx);
    if (matcherCtx?.path) {
      (resolvedProps as Record<string, unknown>).__pagePath = matcherCtx.path;
    }
    if (matcherCtx?.url) {
      (resolvedProps as Record<string, unknown>).__pageUrl = matcherCtx.url;
    }
    try {
      return await commerceLoader(resolvedProps);
    } catch (error) {
      console.error(`[CMS] Commerce loader ${resolveType} failed:`, error);
      return null;
    }
  }

  const blocks = loadBlocks();
  if (blocks[resolveType]) {
    const referencedBlock = blocks[resolveType] as Record<string, unknown>;
    const { __resolveType: _rt, ...restOverrides } = obj;
    return resolveValue({ ...referencedBlock, ...restOverrides }, routeParams, matcherCtx);
  }

  if (resolveType.includes("/loaders/") || resolveType.includes("/actions/")) {
    console.warn(`[CMS] Unhandled loader: ${resolveType}`);
    return null;
  }

  const { __resolveType, ...rest } = obj;
  const resolvedRest = await resolveProps(rest, routeParams, matcherCtx);
  return { __resolveType: resolveType, ...resolvedRest };
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

  console.log(`[CMS] Matched "${page.name}" (pattern: ${page.path}) for path: ${targetPath}`);

  let rawSections: unknown[];
  if (Array.isArray(page.sections)) {
    rawSections = page.sections;
  } else {
    const resolved = await resolveValue(page.sections, params, ctx);
    rawSections = Array.isArray(resolved) ? resolved : [];
  }

  const sectionResults = await Promise.all(
    rawSections.map(async (section) => {
      try {
        const resolved = await resolveValue(section, params, ctx);
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
        console.error(`[CMS] Error resolving section:`, e);
        return [];
      }
    }),
  );

  const resolvedSections = sectionResults.flat();

  console.log(`[CMS] Resolved ${resolvedSections.length} sections for "${page.name}"`);

  return {
    name: page.name,
    path: page.path || targetPath,
    params,
    resolvedSections,
  };
}
