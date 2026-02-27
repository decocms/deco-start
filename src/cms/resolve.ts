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

async function resolveProps(
  obj: Record<string, unknown>,
  routeParams?: Record<string, string>
): Promise<Record<string, unknown>> {
  const entries = Object.entries(obj);
  const resolvedEntries = await Promise.all(
    entries.map(async ([k, v]) => [k, await resolveValue(v, routeParams)] as const)
  );
  return Object.fromEntries(resolvedEntries);
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
    return resolveProps(obj, routeParams);
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

  const commerceLoader = commerceLoaders[resolveType];
  if (commerceLoader) {
    const { __resolveType, ...loaderProps } = obj;
    const resolvedProps = await resolveProps(loaderProps, routeParams);
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
    return resolveValue({ ...referencedBlock, ...restOverrides }, routeParams);
  }

  if (resolveType.includes("/loaders/") || resolveType.includes("/actions/")) {
    console.warn(`[CMS] Unhandled loader: ${resolveType}`);
    return null;
  }

  const { __resolveType, ...rest } = obj;
  const resolvedRest = await resolveProps(rest, routeParams);
  return { __resolveType: resolveType, ...resolvedRest };
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

  let rawSections: unknown[];
  if (Array.isArray(page.sections)) {
    rawSections = page.sections;
  } else {
    const resolved = await resolveValue(page.sections, params);
    rawSections = Array.isArray(resolved) ? resolved : [];
  }

  // Resolve ALL sections in parallel
  const sectionResults = await Promise.all(
    rawSections.map(async (section) => {
      try {
        const resolved = await resolveValue(section, params);
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
    })
  );

  const resolvedSections = sectionResults.flat();

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
