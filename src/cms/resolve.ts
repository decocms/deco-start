import { loadBlocks, findPageByPath, type Resolvable } from "./loader";
import { getSection } from "./registry";

export type ResolvedSection = {
  component: string;
  props: Record<string, unknown>;
  key: string;
};

export type CommerceLoader = (props: any) => Promise<any>;

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

/**
 * Registry of commerce loaders that can be registered by apps.
 * Sites call registerCommerceLoader() to wire up their platform integrations.
 */
const commerceLoaders: Record<string, CommerceLoader> = {};

export function registerCommerceLoader(key: string, loader: CommerceLoader) {
  commerceLoaders[key] = loader;
}

export function registerCommerceLoaders(loaders: Record<string, CommerceLoader>) {
  Object.assign(commerceLoaders, loaders);
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

async function resolveValue(
  value: unknown,
  routeParams?: Record<string, string>
): Promise<unknown> {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolveValue(item, routeParams)));
  }

  const obj = value as Record<string, unknown>;

  if (!obj.__resolveType) {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      resolved[k] = await resolveValue(v, routeParams);
    }
    return resolved;
  }

  const resolveType = obj.__resolveType as string;

  if (SKIP_RESOLVE_TYPES.has(resolveType)) return null;

  if (resolveType === "website/sections/Rendering/Lazy.tsx") {
    return obj.section ? resolveValue(obj.section, routeParams) : null;
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
    return obj.data ? resolveValue(obj.data, routeParams) : null;
  }

  // Multivariate flags: pick first variant's value (matcher evaluation TBD)
  if (
    resolveType === "website/flags/multivariate.ts" ||
    resolveType === "website/flags/multivariate/section.ts"
  ) {
    const variants = obj.variants as Array<{ value: unknown; rule?: unknown }> | undefined;
    if (variants && variants.length > 0) {
      return resolveValue(variants[0].value, routeParams);
    }
    return null;
  }

  // Check commerce loaders
  const commerceLoader = commerceLoaders[resolveType];
  if (commerceLoader) {
    const { __resolveType, ...loaderProps } = obj;
    const resolvedProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(loaderProps)) {
      resolvedProps[k] = await resolveValue(v, routeParams);
    }
    try {
      return await commerceLoader(resolvedProps);
    } catch (error) {
      console.error(`[CMS] Commerce loader ${resolveType} failed:`, error);
      return null;
    }
  }

  // Named blocks
  const blocks = loadBlocks();
  if (blocks[resolveType]) {
    const referencedBlock = blocks[resolveType] as Record<string, unknown>;
    const { __resolveType: _rt, ...restOverrides } = obj;
    return resolveValue({ ...referencedBlock, ...restOverrides }, routeParams);
  }

  // Unhandled loaders/actions
  if (resolveType.includes("/loaders/") || resolveType.includes("/actions/")) {
    console.warn(`[CMS] Unhandled loader: ${resolveType}`);
    return null;
  }

  // Direct section reference
  const { __resolveType, ...rest } = obj;
  const resolvedProps: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    resolvedProps[k] = await resolveValue(v, routeParams);
  }

  return { __resolveType: resolveType, ...resolvedProps };
}

export async function resolveDecoPage(
  targetPath: string
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

  console.log(
    `[CMS] Matched "${page.name}" (pattern: ${page.path}) for path: ${targetPath}`
  );

  // Resolve sections: may be an array or a multivariate/flag object
  let rawSections: unknown[];
  if (Array.isArray(page.sections)) {
    rawSections = page.sections;
  } else {
    const resolved = await resolveValue(page.sections, params);
    rawSections = Array.isArray(resolved) ? resolved : [];
  }

  const resolvedSections: ResolvedSection[] = [];

  for (const section of rawSections) {
    try {
      const resolved = await resolveValue(section, params);
      if (!resolved || typeof resolved !== "object") continue;

      // resolveValue may return an array (e.g. from nested multivariate)
      const items = Array.isArray(resolved) ? resolved : [resolved];

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

        resolvedSections.push({
          component: resolveType,
          props: props as Record<string, unknown>,
          key: resolveType,
        });
      }
    } catch (e) {
      console.error(`[CMS] Error resolving section:`, e);
    }
  }

  console.log(
    `[CMS] Resolved ${resolvedSections.length} sections for "${page.name}"`
  );

  return {
    name: page.name,
    path: page.path || targetPath,
    params,
    resolvedSections,
  };
}
