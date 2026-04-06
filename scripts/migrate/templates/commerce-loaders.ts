import type { MigrationContext } from "../types.ts";
import * as fs from "node:fs";
import * as path from "node:path";

function hasLoaderByName(ctx: MigrationContext, name: string): boolean {
  return ctx.loaderInventory.some(
    (l) => l.path.toLowerCase().includes(name.toLowerCase()),
  );
}

function fileExists(ctx: MigrationContext, relPath: string): boolean {
  const full = path.join(ctx.sourceDir, relPath);
  if (fs.existsSync(full)) return true;
  const src = path.join(ctx.sourceDir, "src", relPath);
  return fs.existsSync(src);
}

export function generateCommerceLoaders(ctx: MigrationContext): string {
  const lines: string[] = [];
  const hasSecrets = fileExists(ctx, "utils/secrets.ts") || fileExists(ctx, "src/utils/secrets.ts");
  const hasProductReviews = hasLoaderByName(ctx, "reviews/productReviews");
  const hasBuyTogether = hasLoaderByName(ctx, "product/buyTogether");
  const hasAutocomplete = hasLoaderByName(ctx, "intelligenseSearch") || hasLoaderByName(ctx, "intelligentSearch");
  const hasVtexAuth = hasLoaderByName(ctx, "vtex-auth-loader");
  const hasCollectionPLP = hasLoaderByName(ctx, "productListPageCollection");
  const hasStores = hasLoaderByName(ctx, "stores");
  const hasProductCard = hasLoaderByName(ctx, "Layouts/ProductCard");
  const hasSitename = fileExists(ctx, "utils/sitename.ts") || fileExists(ctx, "src/utils/sitename.ts");

  lines.push(`/**`);
  lines.push(` * Commerce Loaders — data fetchers registered for CMS block resolution.`);
  lines.push(` *`);
  lines.push(` * Standard VTEX loaders come from createVtexCommerceLoaders().`);
  lines.push(` * Auto-generated pass-throughs come from loaders.gen.ts.`);
  lines.push(` * This file only contains entries that need custom wiring`);
  lines.push(` * (cookie injection, secrets, serialization, etc.).`);
  lines.push(` */`);

  if (ctx.platform === "vtex") {
    lines.push(`import { getVtexConfig } from "@decocms/apps/vtex";`);
    lines.push(`import { createVtexCommerceLoaders, createCachedPDPLoader } from "@decocms/apps/vtex/commerceLoaders";`);
    if (hasAutocomplete) {
      lines.push(`import { autocompleteSearch } from "@decocms/apps/vtex/loaders/autocomplete";`);
    }
    lines.push(`import { getAddressByPostalCode } from "@decocms/apps/vtex/loaders/address";`);
    lines.push(`import { createAddressFromRequest, updateAddressFromRequest, deleteAddressFromRequest } from "@decocms/apps/vtex/actions/address";`);
    lines.push(`import { updateProfileFromRequest, newsletterProfileFromRequest, deletePaymentFromRequest, getPasswordLastUpdate } from "@decocms/apps/vtex/actions/profile";`);
    lines.push(`import { createCachedLoader } from "@decocms/start/sdk/cachedLoader";`);

    if (hasVtexAuth) {
      lines.push(`import vtexAuthLoader from "../loaders/vtex-auth-loader";`);
    }
    if (hasProductReviews) {
      lines.push(`import productReviewsLoader from "../loaders/reviews/productReviews";`);
    }
    if (hasBuyTogether) {
      lines.push(`import buyTogetherLoader from "../loaders/product/buyTogether";`);
    }
    if (hasSecrets) {
      lines.push(`import { secrets } from "../utils/secrets";`);
    }
    if (hasSitename && hasCollectionPLP) {
      lines.push(`import { useAccount } from "../utils/sitename";`);
    }

    // Always import siteLoaders — the generate:loaders script creates this file
    lines.push(`import { siteLoaders } from "../server/cms/loaders.gen";`);
    lines.push(``);

    lines.push(`const DOMAIN_RE = /;\\s*domain=[^;]*/gi;`);
    lines.push(``);
    lines.push(`export const vtexLoaders = createVtexCommerceLoaders();`);
    lines.push(`export const cachedPDP = createCachedPDPLoader();`);

    if (hasCollectionPLP) {
      lines.push(`const cachedPLP = vtexLoaders["vtex/loaders/intelligentSearch/productListingPage.ts"];`);
    }
    if (hasAutocomplete) {
      lines.push(`const cachedAutocomplete = createCachedLoader("vtex/autocomplete", autocompleteSearch, "search");`);
    }

    lines.push(``);
    lines.push(``);
  }

  lines.push(`export const COMMERCE_LOADERS: Record<string, (props: any) => Promise<any>> = {`);

  if (ctx.platform === "vtex") {
    lines.push(`  ...vtexLoaders,`);
    lines.push(`  ...siteLoaders,`);
    lines.push(``);

    // Autocomplete aliases
    if (hasAutocomplete) {
      lines.push(`  // Autocomplete search — from @decocms/apps`);
      lines.push(`  "site/loaders/search/intelligenseSearch.ts": cachedAutocomplete,`);
      lines.push(`  "site/loaders/search/intelligenseSearch": cachedAutocomplete,`);
      lines.push(``);
    }

    // Stores pass-through
    if (hasStores) {
      lines.push(`  // Stores pass-through`);
      lines.push(`  "site/loaders/stores.ts": async (props: any) => {`);
      lines.push(`    const result = props.stores ?? props ?? [];`);
      lines.push(`    return Array.isArray(result) ? result : [];`);
      lines.push(`  },`);
      lines.push(``);
    }

    // VTEX address CRUD
    lines.push(`  // VTEX address CRUD — request-aware wrappers from @decocms/apps`);
    lines.push(`  "vtex/actions/address/createAddress": createAddressFromRequest as any,`);
    lines.push(`  "vtex/actions/address/updateAddress": updateAddressFromRequest as any,`);
    lines.push(`  "vtex/actions/address/deleteAddress": deleteAddressFromRequest as any,`);
    lines.push(`  "vtex/loaders/address/getAddressByZIP": async (props: any) => {`);
    lines.push(`    return getAddressByPostalCode(props.countryCode, props.postalCode);`);
    lines.push(`  },`);
    lines.push(``);

    // Auth cookie stripping
    if (hasVtexAuth) {
      lines.push(`  // VTEX auth (Set-Cookie forwarding)`);
      lines.push(`  "site/loaders/vtex-auth-loader": async (props: any) => {`);
      lines.push(`    const result = await vtexAuthLoader(props);`);
      lines.push(`    if (result instanceof Response) {`);
      lines.push(`      const setCookies = result.headers.getSetCookie?.() ?? [];`);
      lines.push(`      const strippedCookies = setCookies.map((c) => c.replace(DOMAIN_RE, ""));`);
      lines.push(`      const body = await result.text();`);
      lines.push(`      const headers = new Headers({ "Content-Type": "application/json" });`);
      lines.push(`      for (const cookie of strippedCookies) {`);
      lines.push(`        headers.append("Set-Cookie", cookie);`);
      lines.push(`      }`);
      lines.push(`      return new Response(body, { status: result.status, headers });`);
      lines.push(`    }`);
      lines.push(`    return result;`);
      lines.push(`  },`);
      lines.push(``);
    }

    // ProductCard dynamic import
    if (hasProductCard) {
      lines.push(`  // CMS-referenced site loaders`);
      lines.push(`  "site/loaders/Layouts/ProductCard.tsx": async (props: any) => {`);
      lines.push(`    const mod = await import("../loaders/Layouts/ProductCard");`);
      lines.push(`    return mod.default(props);`);
      lines.push(`  },`);
    }

    // Reviews with secrets
    if (hasProductReviews) {
      lines.push(`  "site/loaders/reviews/productReviews.ts": async (props: any) => {`);
      lines.push(`    const { account } = getVtexConfig();`);
      lines.push(`    const result = await productReviewsLoader(props, null as any, { account${hasSecrets ? ", ...secrets" : ""} } as any);`);
      lines.push(`    if (!result) return result;`);
      lines.push(`    const { getProductReview: _r, reviewLikeAction: _l, reviewVote: _v, getProductsListReviews: _p, ...serializable } = result as any;`);
      lines.push(`    return serializable;`);
      lines.push(`  },`);
    }

    // BuyTogether with secrets
    if (hasBuyTogether) {
      lines.push(`  "site/loaders/product/buyTogether.ts": async (props: any) => {`);
      lines.push(`    const { account } = getVtexConfig();`);
      lines.push(`    return buyTogetherLoader(props, null as any, { account${hasSecrets ? ", ...secrets" : ""} } as any);`);
      lines.push(`  },`);
    }

    // Collection PLP
    if (hasCollectionPLP && hasSitename) {
      lines.push(``);
      lines.push(`  // Collection PLP`);
      lines.push(`  "site/loaders/search/productListPageCollection.ts": async (props: any) => {`);
      lines.push(`    const url = new URL(props.__pageUrl || props.__pagePath || "/", "https://localhost");`);
      lines.push(`    const { search_collection_urls_cvlb } = await import("../utils/search-collection-url-cvlb");`);
      lines.push(`    const { createBreadcrumbFromPath } = await import("../utils/plpHelpers/plpCollection");`);
      lines.push(`    const { an: accountName } = useAccount();`);
      lines.push(`    const collections = search_collection_urls_cvlb[accountName] ?? [];`);
      lines.push(``);
      lines.push(`    const normalize = (t: string) =>`);
      lines.push(`      t.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase()`);
      lines.push(`        .replace(/[^a-z0-9\\s-]/g, "").replace(/\\s+/g, "-").replace(/-+/g, "-");`);
      lines.push(``);
      lines.push(`    const slug = decodeURIComponent(url.pathname.split("/").pop() ?? "").replace(/-/g, " ");`);
      lines.push(`    const now = Date.now();`);
      lines.push(`    const collection = collections.find((c: any) =>`);
      lines.push(`      normalize(c.name) === normalize(slug) &&`);
      lines.push(`      new Date(c.dateFrom).getTime() <= now &&`);
      lines.push(`      now <= new Date(c.dateTo).getTime()`);
      lines.push(`    );`);
      lines.push(`    if (!collection) return null;`);
      lines.push(``);
      lines.push(`    const collectionId = String(collection.id);`);
      lines.push(`    const response = await cachedPLP({`);
      lines.push(`      ...props,`);
      lines.push(`      selectedFacets: [{ key: "productClusterIds", value: collectionId }],`);
      lines.push(`      __pageUrl: url.toString(),`);
      lines.push(`      __pagePath: url.pathname,`);
      lines.push(`    });`);
      lines.push(`    if (!response) return null;`);
      lines.push(``);
      lines.push(`    return {`);
      lines.push(`      ...response,`);
      lines.push(`      breadcrumb: createBreadcrumbFromPath(url.pathname, url, collection.name) ?? {},`);
      lines.push(`      seo: {`);
      lines.push(`        title: collection.name,`);
      lines.push(`        description: "O melhor site de compras online para sua casa: compre itens de cozinha, móveis para sala e escritório, acessórios de tecnologia e mais. Clique já!",`);
      lines.push(`        noIndexing: false,`);
      lines.push(`        canonical: url.toString(),`);
      lines.push(`      },`);
      lines.push(`    };`);
      lines.push(`  },`);
    }

    lines.push(``);
    // Profile actions
    lines.push(`  // Profile actions — request-aware wrappers from @decocms/apps`);
    lines.push(`  "vtex/actions/profile/updateProfile": updateProfileFromRequest as any,`);
    lines.push(`  "vtex/actions/profile/updateProfile.ts": updateProfileFromRequest as any,`);
    lines.push(`  "vtex/actions/profile/newsletterProfile": newsletterProfileFromRequest as any,`);
    lines.push(`  "vtex/actions/profile/newsletterProfile.ts": newsletterProfileFromRequest as any,`);
    lines.push(`  "vtex/actions/payments/delete": deletePaymentFromRequest as any,`);
    lines.push(`  "vtex/loaders/profile/passwordLastUpdate": getPasswordLastUpdate as any,`);
  }

  lines.push(`};`);

  return lines.join("\n") + "\n";
}
