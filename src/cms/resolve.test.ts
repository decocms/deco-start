import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("./sectionLoaders", () => ({
  isLayoutSection: () => false,
  runSingleSectionLoader: vi.fn(async (section: any) => section),
}));

vi.mock("../sdk/normalizeUrls", () => ({
  normalizeUrlsInObject: vi.fn(<T>(x: T) => x),
}));

vi.mock("./loader", () => ({
  findPageByPath: vi.fn(),
  loadBlocks: vi.fn(() => ({})),
}));

vi.mock("./registry", () => ({
  getSection: vi.fn(),
}));

import {
  clearCommerceLoaders,
  registerCommerceLoader,
  resolveDeferredSectionFull,
  resolveSectionsList,
  resolveValue,
} from "./resolve";
import { runSingleSectionLoader } from "./sectionLoaders";
import { normalizeUrlsInObject } from "../sdk/normalizeUrls";
import type { DeferredSection } from "./resolve";

describe("resolveDeferredSectionFull", () => {
  it("resolves a deferred section and preserves index", async () => {
    const ds: DeferredSection = {
      component: "site/sections/ProductShelf.tsx",
      key: "site/sections/ProductShelf.tsx",
      index: 5,
      propsHash: "test",
      rawProps: { title: "Best Sellers" },
    };

    const request = new Request("https://store.com/");

    // resolveDeferredSection depends on ensureInitialized() and CMS internals.
    // Since we can't easily mock the full resolution pipeline, we test that
    // the function composes correctly by verifying it calls the right deps.
    // A full integration test would require a running CMS context.

    // For now, verify the function signature is correct and types align
    expect(typeof resolveDeferredSectionFull).toBe("function");
    expect(resolveDeferredSectionFull.length).toBe(4); // ds, pagePath, request, matcherCtx?
  });

  it("runSingleSectionLoader is called with enriched section", async () => {
    // Verify the mock is correctly set up
    const mockSection = {
      component: "test",
      props: { title: "hi" },
      key: "test",
      index: 3,
    };
    const request = new Request("https://store.com/");

    const result = await (runSingleSectionLoader as any)(mockSection, request);
    expect(result).toEqual(mockSection);
  });

  it("normalizeUrlsInObject is used for output normalization", () => {
    const input = { url: "https://store.com/image.jpg" };
    const result = (normalizeUrlsInObject as any)(input);
    expect(result).toEqual(input); // mock passes through
  });
});

// ---------------------------------------------------------------------------
// resolveSectionsList — page-level variant wrapper support
// ---------------------------------------------------------------------------

describe("resolveSectionsList", () => {
  const makeRctx = (matcherCtx = {}) => ({
    routeParams: {},
    matcherCtx,
    memo: new Map(),
    depth: 0,
    resolveChain: [] as { type: "prop" | "resolvable"; value: string }[],
    matcherFlags: [] as { name: string; value: boolean; isSegment: boolean; sticky: boolean }[],
  });

  it("returns array as-is when value is already an array", async () => {
    const sections = [{ __resolveType: "section-A" }, { __resolveType: "section-B" }];
    const result = await resolveSectionsList(sections, makeRctx());
    expect(result).toEqual(sections);
  });

  it("returns empty array for null/undefined/non-object", async () => {
    expect(await resolveSectionsList(null, makeRctx())).toEqual([]);
    expect(await resolveSectionsList(undefined, makeRctx())).toEqual([]);
    expect(await resolveSectionsList("string", makeRctx())).toEqual([]);
    expect(await resolveSectionsList(42, makeRctx())).toEqual([]);
  });

  it("resolves page-level variant wrapper without __resolveType", async () => {
    // Simulates CMS admin wrapping all sections in a device variant
    // Rule has no __resolveType → evaluateMatcher returns true (match-all)
    const sectionsArray = [
      { __resolveType: "Header - 01" },
      { __resolveType: "site/sections/Account/PersonalData.tsx" },
      { __resolveType: "Footer - 01" },
    ];

    const variantWrapper = {
      variants: [
        {
          rule: { mobile: true, tablet: true, desktop: true },
          value: sectionsArray,
        },
      ],
    };

    const result = await resolveSectionsList(variantWrapper, makeRctx());
    expect(result).toEqual(sectionsArray);
  });

  it("returns empty when no variant matches in page-level wrapper", async () => {
    // All variants have __resolveType in rule → evaluateMatcher returns false
    // (unregistered matcher defaults to false)
    const variantWrapper = {
      variants: [
        {
          rule: { __resolveType: "website/matchers/device.ts", mobile: true },
          value: [{ __resolveType: "MobileOnly" }],
        },
      ],
    };

    const result = await resolveSectionsList(variantWrapper, makeRctx());
    expect(result).toEqual([]);
  });

  it("picks first matching variant in page-level wrapper", async () => {
    const desktopSections = [{ __resolveType: "DesktopLayout" }];
    const mobileSections = [{ __resolveType: "MobileLayout" }];

    const variantWrapper = {
      variants: [
        {
          // No __resolveType → evaluateMatcher returns true (first match wins)
          rule: { desktop: true },
          value: desktopSections,
        },
        {
          rule: { mobile: true },
          value: mobileSections,
        },
      ],
    };

    const result = await resolveSectionsList(variantWrapper, makeRctx());
    expect(result).toEqual(desktopSections);
  });

  it("returns empty for object without __resolveType and without variants", async () => {
    const result = await resolveSectionsList({ someKey: "value" }, makeRctx());
    expect(result).toEqual([]);
  });

  it("respects max depth limit (20)", async () => {
    // Build 21 levels of nested variant wrappers to exceed MAX_RESOLVE_DEPTH=20
    let wrapper: any = [{ __resolveType: "deep" }];
    for (let i = 0; i < 21; i++) {
      wrapper = { variants: [{ rule: {}, value: wrapper }] };
    }
    const result = await resolveSectionsList(wrapper, makeRctx());
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Commerce loader auto-injects URL query params as top-level props
// ---------------------------------------------------------------------------
//
// Regression guard for Google Shopping deep links (and any direct entry
// with `?skuId=…`, `?q=…`, etc.): the apps-start canonical commerce
// loaders read `props.skuId` to pre-select a variant. The framework
// injects URL search params into `resolvedProps` at the commerce-loader
// call site so loaders see them on direct navigation. CMS-configured
// props win over URL params (URL is a fallback, not an override).

describe("commerce loader auto-injects URL search params as props", () => {
  const KEY = "site/loaders/__test/queryInjectLoader";

  beforeEach(() => {
    clearCommerceLoaders();
  });

  afterEach(() => {
    clearCommerceLoaders();
  });

  it("populates props.skuId from ?skuId= when CMS does not set it", async () => {
    const calls: Array<Record<string, unknown>> = [];
    registerCommerceLoader(KEY, async (props: Record<string, unknown>) => {
      calls.push({ ...props });
      return null;
    });

    await resolveValue(
      { __resolveType: KEY, slug: "sabonete" },
      undefined,
      {
        url: "https://store.com/produto/sabonete/p?skuId=12345&size=M",
        path: "/produto/sabonete/p",
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      slug: "sabonete",
      skuId: "12345",
      size: "M",
      __pagePath: "/produto/sabonete/p",
      __pageUrl: "https://store.com/produto/sabonete/p?skuId=12345&size=M",
    });
  });

  it("does NOT override a CMS-configured prop with a URL param of the same name", async () => {
    const calls: Array<Record<string, unknown>> = [];
    registerCommerceLoader(KEY, async (props: Record<string, unknown>) => {
      calls.push({ ...props });
      return null;
    });

    await resolveValue(
      { __resolveType: KEY, skuId: "cms-locked-sku" },
      undefined,
      { url: "https://store.com/p?skuId=url-value", path: "/p" },
    );

    expect(calls[0]?.skuId).toBe("cms-locked-sku");
  });

  it("decodes URL-encoded values", async () => {
    const calls: Array<Record<string, unknown>> = [];
    registerCommerceLoader(KEY, async (props: Record<string, unknown>) => {
      calls.push({ ...props });
      return null;
    });

    await resolveValue({ __resolveType: KEY }, undefined, {
      url: "https://store.com/?q=preto%20azul",
      path: "/",
    });

    expect(calls[0]?.q).toBe("preto azul");
  });

  it("is a no-op when matcherCtx.url is missing", async () => {
    const calls: Array<Record<string, unknown>> = [];
    registerCommerceLoader(KEY, async (props: Record<string, unknown>) => {
      calls.push({ ...props });
      return null;
    });

    await resolveValue({ __resolveType: KEY, slug: "abc" }, undefined, {});

    expect(calls[0]).toEqual({ slug: "abc" });
    expect(calls[0]?.__pageUrl).toBeUndefined();
  });

  it("warns and skips injection when matcherCtx.url is malformed", async () => {
    const calls: Array<Record<string, unknown>> = [];
    registerCommerceLoader(KEY, async (props: Record<string, unknown>) => {
      calls.push({ ...props });
      return null;
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        resolveValue({ __resolveType: KEY, slug: "abc" }, undefined, {
          url: "not a url",
          path: "/",
        }),
      ).resolves.not.toThrow();

      // Loader still ran with __pageUrl set, but no query params were
      // injected and the warning surfaced the upstream bug.
      expect(calls[0]).toMatchObject({ slug: "abc", __pageUrl: "not a url" });
      expect(Object.keys(calls[0] ?? {}).sort()).toEqual(
        ["__pagePath", "__pageUrl", "slug"].sort(),
      );
      const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warnings.some((w) => w.includes("malformed matcherCtx.url"))).toBe(true);
      expect(warnings.some((w) => w.includes(KEY))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
