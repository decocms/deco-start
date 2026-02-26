import { loadBlocks, findPageByPath, type Resolvable } from "./loader";
import { getSection } from "./registry";
import { initShopifyFromBlocks } from "../commerce/shopify/init";
import productListLoader from "../commerce/shopify/loaders/ProductList";
import productDetailsPageLoader from "../commerce/shopify/loaders/ProductDetailsPage";
import productListingPageLoader from "../commerce/shopify/loaders/ProductListingPage";

export type ResolvedSection = {
  component: string;
  props: Record<string, unknown>;
  key: string;
};

const SKIP_RESOLVE_TYPES = new Set([
  "Deco",
  "htmx/sections/htmx.tsx",
  "website/sections/Analytics/Analytics.tsx",
  "shopify/loaders/proxy.ts",
  "website/loaders/pages.ts",
  "website/loaders/redirects.ts",
  "commerce/sections/Seo/SeoPDPV2.tsx",
  "commerce/sections/Seo/SeoPLPV2.tsx",
  "website/sections/Seo/SeoV2.tsx",
]);

type CommerceLoader = (props: any) => Promise<any>;

const COMMERCE_LOADERS: Record<string, CommerceLoader> = {
  "shopify/loaders/ProductList.ts": productListLoader,
  "shopify/loaders/ProductDetailsPage.ts": productDetailsPageLoader,
  "shopify/loaders/ProductListingPage.ts": productListingPageLoader,
};

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

  if (SKIP_RESOLVE_TYPES.has(resolveType)) {
    return null;
  }

  // Handle Lazy sections -- unwrap the inner section
  if (resolveType === "website/sections/Rendering/Lazy.tsx") {
    if (obj.section) {
      return resolveValue(obj.section, routeParams);
    }
    return null;
  }

  // Handle "resolved" blocks (data that's already resolved)
  if (resolveType === "resolved") {
    return obj.data ?? null;
  }

  // Handle URL param extraction (e.g. slug from route)
  if (resolveType === "website/functions/requestToParam.ts") {
    const paramName = (obj as any).param as string;
    return routeParams?.[paramName] ?? null;
  }

  // Handle commerce extension loaders (wrapper pattern)
  if (
    resolveType === "commerce/loaders/product/extensions/detailsPage.ts" ||
    resolveType === "commerce/loaders/product/extensions/listingPage.ts"
  ) {
    if (obj.data) {
      return resolveValue(obj.data, routeParams);
    }
    return null;
  }

  // Handle commerce loaders (Shopify, VTEX, etc.)
  const commerceLoader = COMMERCE_LOADERS[resolveType];
  if (commerceLoader) {
    initShopifyFromBlocks();
    const { __resolveType, ...loaderProps } = obj;
    const resolvedProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(loaderProps)) {
      resolvedProps[k] = await resolveValue(v, routeParams);
    }
    try {
      const result = await commerceLoader(resolvedProps);
      return result;
    } catch (error) {
      console.error(`[CMS] Commerce loader ${resolveType} failed:`, error);
      return null;
    }
  }

  // Check if it's a named block (indirect reference)
  const blocks = loadBlocks();
  if (blocks[resolveType]) {
    const referencedBlock = blocks[resolveType] as Record<string, unknown>;
    const { __resolveType: _rt, ...restOverrides } = obj;
    return resolveValue({ ...referencedBlock, ...restOverrides }, routeParams);
  }

  // Check if it's an unresolvable loader/action reference
  if (
    resolveType.includes("/loaders/") ||
    resolveType.includes("/actions/")
  ) {
    console.warn(`[CMS] Unhandled loader: ${resolveType}`);
    return null;
  }

  // Direct section reference -- resolve nested props
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
  const match = findPageByPath(targetPath);
  if (!match) {
    console.warn(`[CMS] No page found for path: ${targetPath}`);
    return null;
  }

  const { page, params } = match;

  console.log(
    `[CMS] Matched "${page.name}" (pattern: ${page.path}) for path: ${targetPath}`
  );

  initShopifyFromBlocks();

  const resolvedSections: ResolvedSection[] = [];

  for (const section of page.sections) {
    try {
      const resolved = await resolveValue(section, params);
      if (!resolved || typeof resolved !== "object") continue;

      const obj = resolved as Record<string, unknown>;
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
