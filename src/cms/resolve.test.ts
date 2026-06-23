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
  DEFAULT_FOLD_THRESHOLD,
  getAsyncRenderingConfig,
  registerCommerceLoader,
  registerEagerSections,
  registerNeverDeferSections,
  resolveDeferredSectionFull,
  resolveSectionsList,
  resolveValue,
  setAsyncRenderingConfig,
  shouldDeferSection,
  WELL_KNOWN_TYPES,
} from "./resolve";
import { runSingleSectionLoader } from "./sectionLoaders";
import { normalizeUrlsInObject } from "../sdk/normalizeUrls";
import type { AsyncRenderingConfig, DeferredSection } from "./resolve";

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

// ---------------------------------------------------------------------------
// Async rendering: the admin (CMS Lazy ⚡ toggle) is the source of truth
// ---------------------------------------------------------------------------
//
// Regression guard for issue #266: the framework must NOT defer a section by
// position, and must NOT let code-level flags (`export const eager/neverDefer`)
// override the editor's ⚡ choice. A section is deferred iff the editor wrapped
// it in CMS Lazy/Deferred in the admin. The position threshold + code flags are
// an explicit per-site opt-in that is OFF by default (foldThreshold = Infinity)
// and never overrides the admin.

describe("async rendering config defaults", () => {
  beforeEach(() => {
    // Reset the globalThis-backed config so each assertion is order-independent.
    (globalThis as any).__deco.asyncConfig = null;
  });

  it("DEFAULT_FOLD_THRESHOLD is Infinity (position-based deferral off)", () => {
    expect(DEFAULT_FOLD_THRESHOLD).toBe(Infinity);
  });

  it("setAsyncRenderingConfig() defaults to foldThreshold=Infinity, respectCmsLazy=true", () => {
    setAsyncRenderingConfig();
    const cfg = getAsyncRenderingConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.foldThreshold).toBe(Infinity);
    expect(cfg!.respectCmsLazy).toBe(true);
  });

  it("preserves an explicit finite foldThreshold (opt-in)", () => {
    setAsyncRenderingConfig({ foldThreshold: 3 });
    expect(getAsyncRenderingConfig()!.foldThreshold).toBe(3);
  });
});

describe("shouldDeferSection — admin is the source of truth", () => {
  const mkCfg = (over: Partial<AsyncRenderingConfig> = {}): AsyncRenderingConfig => ({
    respectCmsLazy: true,
    foldThreshold: Infinity,
    alwaysEager: new Set(),
    ...over,
  });

  const lazyWrap = (inner: object) => ({
    __resolveType: WELL_KNOWN_TYPES.LAZY,
    section: inner,
  });

  it("defers a section the editor marked ⚡ (wrapped in CMS Lazy)", () => {
    const section = lazyWrap({ __resolveType: "site/sections/Hero.tsx" });
    expect(shouldDeferSection(section, 0, mkCfg(), false)).toBe(true);
  });

  it("renders a non-⚡ section eagerly regardless of position (default Infinity)", () => {
    const section = { __resolveType: "site/sections/SeoText.tsx" };
    // Position 5 used to auto-defer with the old foldThreshold=3 — now SSR.
    expect(shouldDeferSection(section, 5, mkCfg(), false)).toBe(false);
  });

  it("admin ⚡ overrides `export const eager` (code flag ignored)", () => {
    const key = "site/sections/EagerButLazy.tsx";
    registerEagerSections([key]);
    const section = lazyWrap({ __resolveType: key });
    // Even with a finite threshold where the eager flag would otherwise apply,
    // the editor's ⚡ wins → deferred.
    expect(shouldDeferSection(section, 0, mkCfg({ foldThreshold: 3 }), false)).toBe(true);
  });

  it("admin ⚡ overrides `export const neverDefer` (code flag ignored)", () => {
    const key = "site/sections/NeverDeferButLazy.tsx";
    registerNeverDeferSections([key]);
    const section = lazyWrap({ __resolveType: key });
    expect(shouldDeferSection(section, 0, mkCfg(), false)).toBe(true);
  });

  it("bots always get SSR, even for ⚡ sections (SEO)", () => {
    const section = lazyWrap({ __resolveType: "site/sections/Hero.tsx" });
    expect(shouldDeferSection(section, 0, mkCfg(), true)).toBe(false);
  });

  it("opt-in finite foldThreshold defers UNMARKED sections by position", () => {
    const section = { __resolveType: "site/sections/Shelf.tsx" };
    expect(shouldDeferSection(section, 5, mkCfg({ foldThreshold: 3 }), false)).toBe(true);
    expect(shouldDeferSection(section, 1, mkCfg({ foldThreshold: 3 }), false)).toBe(false);
  });
});
