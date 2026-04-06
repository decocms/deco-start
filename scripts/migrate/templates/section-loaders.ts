import type { MigrationContext, SectionMeta } from "../types.ts";
import * as fs from "node:fs";
import * as path from "node:path";

const ACCOUNT_LOADER_MAP: Record<string, string> = {
  personaldata: "personalData",
  myorders: "orders",
  myordersdata: "orders",
  orders: "orders",
  cards: "cards",
  payments: "cards",
  addresses: "addresses",
  auth: "authentication",
  authentication: "authentication",
  authenticationpage: "authentication",
  login: "authentication",
  myinsurances: "loggedIn",
  privacypolice: "loggedIn",
};

function getAccountLoaderName(sectionBasename: string): string {
  const key = sectionBasename.toLowerCase().replace(/[^a-z]/g, "");
  return ACCOUNT_LOADER_MAP[key] || "loggedIn";
}

function sectionExists(ctx: MigrationContext, sectionPath: string): boolean {
  const full = path.join(ctx.sourceDir, "src", sectionPath);
  if (fs.existsSync(full)) return true;
  const root = path.join(ctx.sourceDir, sectionPath);
  return fs.existsSync(root);
}

function loaderExists(ctx: MigrationContext, loaderPath: string): boolean {
  const full = path.join(ctx.sourceDir, "src", loaderPath);
  if (fs.existsSync(full)) return true;
  const root = path.join(ctx.sourceDir, loaderPath);
  return fs.existsSync(root);
}

export function generateSectionLoaders(ctx: MigrationContext): string {
  const lines: string[] = [];
  const isVtex = ctx.platform === "vtex";
  const hasAccountSections = isVtex && ctx.sectionMetas.some((m) => m.isAccountSection);
  const hasWishlistSection = sectionExists(ctx, "sections/Wishlist.tsx");
  const hasInstagramSection = sectionExists(ctx, "sections/Social/InstagramPosts.tsx");
  const hasCategoryBanner = sectionExists(ctx, "sections/Category/CategoryBanner.tsx");
  const hasBackgroundWrapper = sectionExists(ctx, "sections/LpContent/BackgroundWrapper.tsx");
  const hasProductReviews = sectionExists(ctx, "sections/Product/ProductReviews.tsx");
  const hasProductDescription = sectionExists(ctx, "sections/Product/ProductDescription.tsx");
  const hasProductFaq = sectionExists(ctx, "sections/Product/ProductFaq.tsx");
  const hasSearchResult = sectionExists(ctx, "sections/Product/SearchResult.tsx");
  const hasPrivacyPolice = sectionExists(ctx, "sections/Account/PrivacyPolice.tsx");
  const hasSEOPDP = sectionExists(ctx, "sections/SEOPDP.tsx");
  const hasCallCenter = sectionExists(ctx, "sections/CallCenter.tsx");
  const hasIsEvents = sectionExists(ctx, "sections/Analytics/IsEvents.tsx");
  const hasWishlistLoaders = loaderExists(ctx, "loaders/Wishlist/get-wishlist-list.ts");
  const hasProductReviewsLoader = loaderExists(ctx, "loaders/reviews/productReviews.ts");

  lines.push(`/**`);
  lines.push(` * Section Loaders — server-side prop enrichment for CMS sections.`);
  lines.push(` *`);
  lines.push(` * Each entry receives CMS-resolved props + Request, returns enriched props.`);
  lines.push(` * Simple patterns (device, mobile) use framework mixins.`);
  lines.push(` * Complex logic (SearchResult, PDP fallback, Wishlist) is inline.`);
  lines.push(` */`);
  lines.push(`import {`);
  lines.push(`  registerSectionLoaders,`);
  if (hasBackgroundWrapper) lines.push(`  runSingleSectionLoader,`);
  lines.push(`  withDevice,`);
  lines.push(`  withMobile,`);
  lines.push(`  withSearchParam,`);
  lines.push(`  compose,`);
  lines.push(`} from "@decocms/start/cms";`);

  if (hasSearchResult) {
    lines.push(`import { detectDevice } from "@decocms/start/sdk/useDevice";`);
  }

  if (isVtex) {
    lines.push(`import { getVtexConfig } from "@decocms/apps/vtex";`);
    if (hasWishlistSection && hasWishlistLoaders) {
      lines.push(`import { getUser } from "@decocms/apps/vtex/loaders/user";`);
      lines.push(`import { getVtexCookies } from "@decocms/apps/vtex/utils/cookies";`);
    }
  }

  if (hasAccountSections) {
    lines.push(`import { vtexAccountLoaders } from "@decocms/apps/vtex/utils/accountLoaders";`);
  }

  if (hasProductReviewsLoader && (hasProductReviews || hasSearchResult)) {
    lines.push(`import productReviewsLoader from "../loaders/reviews/productReviews";`);
  }

  if (hasWishlistLoaders && hasWishlistSection) {
    lines.push(`import getWishlistList from "../loaders/Wishlist/get-wishlist-list";`);
    lines.push(`import getWishlistItems from "../loaders/Wishlist/get-wishlist-items";`);
  }

  // Check for secrets file
  const hasSecrets = loaderExists(ctx, "utils/secrets.ts") || loaderExists(ctx, "src/utils/secrets.ts");
  if (hasSecrets && (hasProductReviews || hasProductReviewsLoader)) {
    lines.push(`import { secrets } from "../utils/secrets";`);
  }

  // Import cachedPDP for PDP fallbacks
  const needsCachedPDP = hasProductDescription || hasProductFaq || hasProductReviews;
  if (isVtex && needsCachedPDP) {
    lines.push(`import { cachedPDP } from "./commerce-loaders";`);
  }

  lines.push(``);

  const entries: string[] = [];

  // ---------- Headers ----------
  for (const meta of ctx.sectionMetas) {
    if (!meta.isHeader || !meta.hasLoader) continue;
    const sectionKey = `site/${meta.path}`;
    entries.push(`  // Header: device + search param`);
    entries.push(`  "${sectionKey}": async (props, req) => ({`);
    entries.push(`    ...(await compose(withDevice(), withSearchParam())(props, req)),`);
    entries.push(`    userName: "",`);
    entries.push(`  }),`);
  }

  // ---------- Device/mobile sections ----------
  for (const meta of ctx.sectionMetas) {
    if (meta.isHeader || meta.isAccountSection || meta.isStatusOnly) continue;
    // Skip sections with no loader AND no device needs
    if (!meta.hasLoader && !meta.loaderUsesDevice) continue;
    const sectionKey = `site/${meta.path}`;
    const basename = meta.path.split("/").pop()?.replace(/\.\w+$/, "") || "";

    // Skip sections handled specially below
    const specialSections = [
      "BackgroundWrapper", "CategoryBanner", "SearchResult",
      "ProductDescription", "ProductFaq", "ProductReviews",
      "SEOPDP", "CallCenter", "IsEvents", "Wishlist", "PrivacyPolice",
      "InstagramPosts",
    ];
    if (specialSections.includes(basename)) continue;

    if (meta.loaderUsesDevice && meta.loaderUsesUrl) {
      const deviceMixin = meta.usesMobileBoolean ? "withMobile()" : "withDevice()";
      entries.push(`  "${sectionKey}": compose(${deviceMixin}, withSearchParam()),`);
    } else if (meta.loaderUsesDevice) {
      if (meta.usesMobileBoolean) {
        entries.push(`  "${sectionKey}": withMobile(),`);
      } else {
        entries.push(`  "${sectionKey}": withDevice(),`);
      }
    } else if (meta.loaderUsesUrl) {
      entries.push(`  "${sectionKey}": withSearchParam(),`);
    } else if (meta.hasLoader) {
      const importPath = `~/` + meta.path.replace(/\.tsx?$/, "");
      entries.push(`  "${sectionKey}": async (props: any, req: Request) => {`);
      entries.push(`    const mod = await import("${importPath}");`);
      entries.push(`    if (typeof mod.loader === "function") return mod.loader(props, req);`);
      entries.push(`    return props;`);
      entries.push(`  },`);
    }
  }

  // ---------- BackgroundWrapper: nested section resolution ----------
  if (hasBackgroundWrapper) {
    entries.push(``);
    entries.push(`  // BackgroundWrapper: resolve nested sections`);
    entries.push(`  "site/sections/LpContent/BackgroundWrapper.tsx": async (props, req) => {`);
    entries.push(`    const sections = (props as any).sections ?? [];`);
    entries.push(`    const enrichedSections = await Promise.all(`);
    entries.push(`      sections.map(async (s: any) => {`);
    entries.push(`        const component = s.Component ?? s.component;`);
    entries.push(`        if (!component) return s;`);
    entries.push(`        const result = await runSingleSectionLoader({ component, props: s.props ?? {}, key: component, originalIndex: 0 } as any, req);`);
    entries.push(`        return { ...s, props: result.props };`);
    entries.push(`      }),`);
    entries.push(`    );`);
    entries.push(`    return { ...withMobile()(props, req), sections: enrichedSections };`);
    entries.push(`  },`);
  }

  // ---------- CategoryBanner: URLPattern matcher ----------
  if (hasCategoryBanner) {
    entries.push(``);
    entries.push(`  // CategoryBanner: match URL against banner patterns`);
    entries.push(`  "site/sections/Category/CategoryBanner.tsx": (props, req) => {`);
    entries.push(`    const banners = (props as any).banners ?? [];`);
    entries.push(`    const banner = banners.find(({ matcher }: { matcher: string }) => {`);
    entries.push(`      try {`);
    entries.push(`        return new URLPattern({ pathname: matcher }).test(req.url);`);
    entries.push(`      } catch {`);
    entries.push(`        return false;`);
    entries.push(`      }`);
    entries.push(`    });`);
    entries.push(`    return { ...props, banner };`);
    entries.push(`  },`);
  }

  // ---------- PDP fallbacks ----------
  if (isVtex && needsCachedPDP) {
    entries.push(``);
    entries.push(`  // PDP fallbacks — when CMS resolver fails to resolve nested __resolveType chain`);

    if (hasProductDescription) {
      entries.push(`  "site/sections/Product/ProductDescription.tsx": async (props: any, req) => {`);
      entries.push(`    if (props.page?.product) return props;`);
      entries.push(`    const url = new URL(req.url);`);
      entries.push(`    const page = await cachedPDP({ __pagePath: url.pathname });`);
      entries.push(`    return { ...props, page };`);
      entries.push(`  },`);
    }

    if (hasProductFaq) {
      entries.push(`  "site/sections/Product/ProductFaq.tsx": async (props: any, req) => {`);
      entries.push(`    if (props.page?.product) return props;`);
      entries.push(`    const url = new URL(req.url);`);
      entries.push(`    const page = await cachedPDP({ __pagePath: url.pathname });`);
      entries.push(`    return { ...props, page };`);
      entries.push(`  },`);
    }

    if (hasProductReviews && hasProductReviewsLoader) {
      entries.push(`  "site/sections/Product/ProductReviews.tsx": async (props: any, req) => {`);
      entries.push(`    if (props.page?.reviews) return props;`);
      entries.push(`    const url = new URL(req.url);`);
      entries.push(`    const pdpPage = await cachedPDP({ __pagePath: url.pathname });`);
      entries.push(`    if (!pdpPage) return props;`);
      entries.push(`    const { account } = getVtexConfig();`);
      entries.push(`    const result = await productReviewsLoader(`);
      entries.push(`      { product: pdpPage },`);
      entries.push(`      null as any,`);
      entries.push(`      { account${hasSecrets ? ", ...secrets" : ""} } as any,`);
      entries.push(`    );`);
      entries.push(`    if (!result) return props;`);
      entries.push(`    const { getProductReview: _r, reviewLikeAction: _l, reviewVote: _v, getProductsListReviews: _p, ...serializable } = result as any;`);
      entries.push(`    return { ...props, page: serializable };`);
      entries.push(`  },`);
    }
  }

  // ---------- SearchResult ----------
  if (hasSearchResult) {
    entries.push(``);
    entries.push(`  // SearchResult: URL parsing + device + SEO text + sponsored info`);
    entries.push(`  "site/sections/Product/SearchResult.tsx": (props: any, req) => {`);
    entries.push(`    const url = new URL(req.url);`);
    entries.push(`    const currentSearchTerm = url.searchParams.get("q") || null;`);
    entries.push(`    const pathname = url.pathname;`);
    entries.push(`    const page = props?.page;`);
    entries.push(`    const device = detectDevice(req.headers.get("user-agent") ?? "");`);
    entries.push(``);
    entries.push(`    const seoTexts = [...(props.seoTexts || []), ...(page?.seoTexts || [])];`);
    entries.push(`    const sortedSeoTexts = seoTexts?.sort(`);
    entries.push(`      (a: any, b: any) => (b.route?.split("/")?.length ?? 0) - (a.route?.split("/")?.length ?? 0),`);
    entries.push(`    );`);
    entries.push(`    const seoText = sortedSeoTexts?.find(`);
    entries.push(`      (st: any) =>`);
    entries.push(`        pathname === st.route?.split("?")[0] ||`);
    entries.push(`        pathname === st.route?.split("?")[0]?.replace(",", "-"),`);
    entries.push(`    ) || { title: "", text: "", route: "", bottomText: "" };`);
    entries.push(``);
    entries.push(`    let sponsoredInfo: {`);
    entries.push(`      pageType: string | undefined;`);
    entries.push(`      category: string | null;`);
    entries.push(`      query: string | null;`);
    entries.push(`      device: string;`);
    entries.push(`    } | null = null;`);
    entries.push(`    if (props.enableSponsoredBanner) {`);
    entries.push(`      try {`);
    entries.push(`        const pageType = page?.pageInfo?.pageTypes?.[0];`);
    entries.push(`        let category: string | null = null;`);
    entries.push(`        let query: string | null = null;`);
    entries.push(`        if (pageType === "Department") {`);
    entries.push(`          category = page?.breadcrumb?.itemListElement?.[0]?.name || null;`);
    entries.push(`        } else if (pageType === "Search") {`);
    entries.push(`          query = currentSearchTerm;`);
    entries.push(`        }`);
    entries.push(`        if (category || query) {`);
    entries.push(`          sponsoredInfo = { pageType, category, query, device };`);
    entries.push(`        }`);
    entries.push(`      } catch {`);
    entries.push(`        sponsoredInfo = null;`);
    entries.push(`      }`);
    entries.push(`    }`);
    entries.push(``);
    entries.push(`    return {`);
    entries.push(`      ...props,`);
    entries.push(`      sponsoredInfo,`);
    entries.push(`      seoText,`);
    entries.push(`      device,`);
    entries.push(`      page: page ? { ...page, products: page.products ?? [] } : page,`);
    entries.push(`      currentSearchTerm,`);
    entries.push(`      ...(!page?.products?.length && { notFoundPage: props.notFoundPage }),`);
    entries.push(`    };`);
    entries.push(`  },`);
  }

  // ---------- SEO + analytics delegation ----------
  if (hasSEOPDP) {
    entries.push(``);
    entries.push(`  "site/sections/SEOPDP.tsx": async (props: any, _req) => {`);
    entries.push(`    const mod = await import("../sections/SEOPDP");`);
    entries.push(`    const result = mod.loader(props, _req, { seo: {} } as any);`);
    entries.push(`    return result ?? props;`);
    entries.push(`  },`);
  }

  if (hasCallCenter) {
    entries.push(`  "site/sections/CallCenter.tsx": (props: any, req) => {`);
    entries.push(`    const url = new URL(req.url);`);
    entries.push(`    return { ...props, pathname: url.pathname };`);
    entries.push(`  },`);
  }

  if (hasIsEvents) {
    entries.push(`  "site/sections/Analytics/IsEvents.tsx": async (props: any, req) => {`);
    entries.push(`    const mod = await import("../sections/Analytics/IsEvents");`);
    entries.push(`    return mod.loader(props, req) as unknown as Record<string, unknown>;`);
    entries.push(`  },`);
  }

  // ---------- Account sections ----------
  if (isVtex && hasAccountSections) {
    entries.push(``);
    entries.push(`  // Account sections — via @decocms/apps factory`);

    for (const meta of ctx.sectionMetas) {
      if (!meta.isAccountSection) continue;
      const sectionKey = `site/${meta.path}`;
      const basename = meta.path.split("/").pop()?.replace(/\.\w+$/, "") || "";
      const loaderName = getAccountLoaderName(basename);

      if (basename === "PersonalData") {
        entries.push(`  "${sectionKey}": vtexAccountLoaders.personalData({`);
        entries.push(`    extraProfileFields: ["isNewsletterOptIn", "cartAbandoned"],`);
        entries.push(`    mapProfile: (p) => ({`);
        entries.push(`      "@id": p.userId ?? p.id,`);
        entries.push(`      email: p.email,`);
        entries.push(`      givenName: p.firstName ?? null,`);
        entries.push(`      familyName: p.lastName ?? null,`);
        entries.push(`      taxID: p.document,`);
        entries.push(`      gender: p.gender,`);
        entries.push(`      telephone: p.homePhone,`);
        entries.push(`      birthDate: p.birthDate,`);
        entries.push(`      corporateName: p.corporateName,`);
        entries.push(`      tradeName: p.tradeName,`);
        entries.push(`      corporateDocument: p.corporateDocument,`);
        entries.push(`      businessPhone: p.businessPhone,`);
        entries.push(`      stateRegistration: p.stateRegistration,`);
        entries.push(`      isCorporate: p.isCorporate,`);
        entries.push(`      customFields: p.customFields,`);
        entries.push(`    }),`);
        entries.push(`  }),`);
      } else {
        entries.push(`  "${sectionKey}": vtexAccountLoaders.${loaderName}(),`);
      }
    }
  }

  // ---------- Wishlist ----------
  if (isVtex && hasWishlistSection && hasWishlistLoaders) {
    entries.push(``);
    entries.push(`  // Wishlist`);
    entries.push(`  "site/sections/Wishlist.tsx": async (props: any, req) => {`);
    entries.push(`    const cookie = getVtexCookies(req);`);
    entries.push(`    try {`);
    entries.push(`      const userData = await getUser(cookie);`);
    entries.push(`      const userId = userData?.email ? (userData.email as string) : "";`);
    entries.push(`      if (!userId) return { ...props, wishlist: null };`);
    entries.push(``);
    entries.push(`      const listResponse = await getWishlistList({ userId });`);
    entries.push(`      if (listResponse && typeof listResponse === "object" && "data" in (listResponse as any)) {`);
    entries.push(`        const { data } = listResponse as { data: { id: string; title: string }[] };`);
    entries.push(`        if (data?.length > 0) {`);
    entries.push(`          const firstList = data[0];`);
    entries.push(`          const itemsResponse = await getWishlistItems({ listId: firstList.id, userId });`);
    entries.push(`          if (itemsResponse && typeof itemsResponse === "object" && "data" in (itemsResponse as any)) {`);
    entries.push(`            const { data: itemsData } = itemsResponse as any;`);
    entries.push(`            return {`);
    entries.push(`              ...props,`);
    entries.push(`              wishlist: {`);
    entries.push(`                title: itemsData.title as string,`);
    entries.push(`                products: itemsData.products ?? [],`);
    entries.push(`                id: firstList.id,`);
    entries.push(`                userId,`);
    entries.push(`              },`);
    entries.push(`            };`);
    entries.push(`          }`);
    entries.push(`          return { ...props, wishlist: { title: firstList.title, products: [], id: firstList.id, userId } };`);
    entries.push(`        }`);
    entries.push(`      }`);
    entries.push(`      return { ...props, wishlist: null };`);
    entries.push(`    } catch (err) {`);
    entries.push(`      console.error("[Wishlist SectionLoader] Error:", err);`);
    entries.push(`      return { ...props, wishlist: null };`);
    entries.push(`    }`);
    entries.push(`  },`);
  }

  // ---------- Privacy cookie check ----------
  if (isVtex && hasPrivacyPolice) {
    entries.push(``);
    const vtexAccount = ctx.vtexAccount || "casaevideonewio";
    entries.push(`  "site/sections/Account/PrivacyPolice.tsx": (props: any, req) => {`);
    entries.push(`    const cookies = req.headers.get("cookie") ?? "";`);
    entries.push(`    const logged = cookies.includes("VtexIdclientAutCookie_${vtexAccount}");`);
    entries.push(`    return { ...props, logged };`);
    entries.push(`  },`);
  }

  // ---------- Instagram ----------
  if (hasInstagramSection) {
    entries.push(``);
    entries.push(`  // Social`);
    entries.push(`  "site/sections/Social/InstagramPosts.tsx": async (props: any, _req) => {`);
    entries.push(`    const { facebookToken, layout, title, description } = props;`);
    entries.push(`    if (!facebookToken) return props;`);
    entries.push(`    try {`);
    entries.push(`      const fields = "media_url,media_type,permalink";`);
    entries.push("      const apiUrl = `https://graph.instagram.com/me/media?access_token=${facebookToken}&fields=${fields}`;");
    entries.push(`      const { data } = (await fetch(apiUrl).then((r) => r.json())) as { data: any[] };`);
    entries.push(`      return {`);
    entries.push(`        data: (data || []).slice(0, layout?.numberOfPosts ?? 12),`);
    entries.push(`        title,`);
    entries.push(`        description,`);
    entries.push(`        layout,`);
    entries.push(`      };`);
    entries.push(`    } catch (err) {`);
    entries.push(`      console.error("[InstagramPosts] loader error:", err);`);
    entries.push(`      return props;`);
    entries.push(`    }`);
    entries.push(`  },`);
  }

  lines.push(`registerSectionLoaders({`);
  lines.push(entries.join("\n"));
  lines.push(`});`);

  return lines.join("\n") + "\n";
}
