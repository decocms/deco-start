import { beforeEach, describe, expect, it, vi } from "vitest";

const { onChangeListeners } = vi.hoisted(() => ({
  onChangeListeners: [] as Array<() => void>,
}));

vi.mock("../cms", () => ({
  loadBlocks: vi.fn(),
  onChange: vi.fn((listener: () => void) => {
    onChangeListeners.push(listener);
  }),
  resolvePageSections: vi.fn(),
}));

import { loadBlocks, resolvePageSections } from "../cms";
import { __resetSiteGlobalsCache, resolveSiteGlobals, withSiteGlobals } from "./withSiteGlobals";

const mockedLoadBlocks = loadBlocks as unknown as ReturnType<typeof vi.fn>;
const mockedResolvePageSections = resolvePageSections as unknown as ReturnType<typeof vi.fn>;

describe("withSiteGlobals", () => {
  beforeEach(() => {
    __resetSiteGlobalsCache();
    mockedLoadBlocks.mockReset();
    mockedResolvePageSections.mockReset();
  });

  describe("resolveSiteGlobals", () => {
    it("returns empty when there is no Site block", async () => {
      mockedLoadBlocks.mockReturnValue({});
      const result = await resolveSiteGlobals();
      expect(result.resolvedSections).toEqual([]);
      expect(result.rawRefs).toEqual([]);
      expect(mockedResolvePageSections).not.toHaveBeenCalled();
    });

    it("returns empty when Site block has no globals", async () => {
      mockedLoadBlocks.mockReturnValue({ site: { seo: { title: "x" } } });
      const result = await resolveSiteGlobals();
      expect(result.resolvedSections).toEqual([]);
      expect(result.rawRefs).toEqual([]);
      expect(mockedResolvePageSections).not.toHaveBeenCalled();
    });

    it("gathers theme + global + pageSections in order", async () => {
      mockedLoadBlocks.mockReturnValue({
        site: {
          theme: { __resolveType: "Theme" },
          global: [{ __resolveType: "Analytics" }, { __resolveType: "WishlistProvider" }],
          pageSections: [{ __resolveType: "Session" }],
        },
      });
      const resolved = [
        { component: "Theme.tsx", props: {}, key: "k0" },
        { component: "Analytics.tsx", props: {}, key: "k1" },
        { component: "Wishlist.tsx", props: {}, key: "k2" },
        { component: "Session.tsx", props: {}, key: "k3" },
      ];
      mockedResolvePageSections.mockResolvedValue(resolved);

      const result = await resolveSiteGlobals();

      expect(result.rawRefs).toEqual([
        { __resolveType: "Theme" },
        { __resolveType: "Analytics" },
        { __resolveType: "WishlistProvider" },
        { __resolveType: "Session" },
      ]);
      expect(result.resolvedSections).toEqual(resolved);
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(1);
    });

    it("accepts both `site` (lowercase) and `Site` (PascalCase) block keys", async () => {
      mockedLoadBlocks.mockReturnValue({
        Site: { theme: { __resolveType: "Theme" } },
      });
      mockedResolvePageSections.mockResolvedValue([
        { component: "Theme.tsx", props: {}, key: "k0" },
      ]);
      const result = await resolveSiteGlobals();
      expect(result.rawRefs).toEqual([{ __resolveType: "Theme" }]);
      expect(result.resolvedSections).toHaveLength(1);
    });

    it("dedupes inflight requests (single resolvePageSections call for parallel callers)", async () => {
      mockedLoadBlocks.mockReturnValue({
        site: { global: [{ __resolveType: "Analytics" }] },
      });
      let resolveFn!: (v: unknown[]) => void;
      mockedResolvePageSections.mockImplementation(
        () =>
          new Promise((res) => {
            resolveFn = res as any;
          }),
      );

      const a = resolveSiteGlobals();
      const b = resolveSiteGlobals();
      resolveFn([{ component: "A.tsx", props: {}, key: "k0" }]);
      const [ra, rb] = await Promise.all([a, b]);

      expect(ra).toEqual(rb);
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(1);
    });

    it("caches across calls within TTL", async () => {
      mockedLoadBlocks.mockReturnValue({
        site: { global: [{ __resolveType: "Analytics" }] },
      });
      mockedResolvePageSections.mockResolvedValue([{ component: "A.tsx", props: {}, key: "k0" }]);

      await resolveSiteGlobals();
      await resolveSiteGlobals();
      await resolveSiteGlobals();

      expect(mockedResolvePageSections).toHaveBeenCalledTimes(1);
    });

    it("invalidates cache when onChange fires", async () => {
      mockedLoadBlocks.mockReturnValue({
        site: { global: [{ __resolveType: "Analytics" }] },
      });
      mockedResolvePageSections.mockResolvedValue([{ component: "A.tsx", props: {}, key: "k0" }]);

      await resolveSiteGlobals();
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(1);

      // Simulate a CMS reload
      for (const listener of onChangeListeners) listener();

      await resolveSiteGlobals();
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(2);
    });

    it("does not cache failures (next call retries)", async () => {
      mockedLoadBlocks.mockReturnValue({
        site: { global: [{ __resolveType: "Analytics" }] },
      });
      mockedResolvePageSections
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce([{ component: "A.tsx", props: {}, key: "k0" }]);

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const first = await resolveSiteGlobals();
      expect(first.resolvedSections).toEqual([]);

      const second = await resolveSiteGlobals();
      expect(second.resolvedSections).toHaveLength(1);
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(2);
      errSpy.mockRestore();
    });
  });

  describe("withSiteGlobals wrapper", () => {
    it("passes through null page (404) without merging globals", async () => {
      mockedLoadBlocks.mockReturnValue({});
      const baseLoader = vi.fn().mockResolvedValue(null);
      const cfg = withSiteGlobals({ loader: baseLoader });
      const result = await cfg.loader();
      expect(result).toBeNull();
    });

    it("merges resolved globals BEFORE page sections", async () => {
      mockedLoadBlocks.mockReturnValue({
        site: { theme: { __resolveType: "Theme" } },
      });
      mockedResolvePageSections.mockResolvedValue([
        { component: "Theme.tsx", props: {}, key: "g0" },
      ]);
      const baseLoader = vi.fn().mockResolvedValue({
        resolvedSections: [
          { component: "Header.tsx", props: {}, key: "p0" },
          { component: "Hero.tsx", props: {}, key: "p1" },
        ],
        // arbitrary other route fields preserved
        cacheProfile: "static",
      });

      const cfg = withSiteGlobals({ loader: baseLoader });
      const result = await cfg.loader();

      expect(result.resolvedSections.map((s: any) => s.component)).toEqual([
        "Theme.tsx",
        "Header.tsx",
        "Hero.tsx",
      ]);
      expect(result.cacheProfile).toBe("static");
    });

    it("dedupes globals whose component already appears on the page", async () => {
      mockedLoadBlocks.mockReturnValue({
        site: {
          global: [{ __resolveType: "Session" }, { __resolveType: "Theme" }],
        },
      });
      mockedResolvePageSections.mockResolvedValue([
        { component: "Session.tsx", props: {}, key: "g0" },
        { component: "Theme.tsx", props: {}, key: "g1" },
      ]);
      const baseLoader = vi.fn().mockResolvedValue({
        // Page already mounts Session — global Session should NOT duplicate.
        resolvedSections: [{ component: "Session.tsx", props: { fromPage: true }, key: "p0" }],
      });

      const cfg = withSiteGlobals({ loader: baseLoader });
      const result = await cfg.loader();

      const components = result.resolvedSections.map((s: any) => s.component);
      // Only one Session, taken from the page (page-level wins).
      expect(components).toEqual(["Theme.tsx", "Session.tsx"]);
      const session = result.resolvedSections.find((s: any) => s.component === "Session.tsx");
      expect(session.props.fromPage).toBe(true);
    });

    it("dedupes within globals (Session in both site.global AND site.pageSections)", async () => {
      mockedLoadBlocks.mockReturnValue({
        site: {
          global: [{ __resolveType: "Session" }],
          pageSections: [{ __resolveType: "Session" }],
        },
      });
      mockedResolvePageSections.mockResolvedValue([
        { component: "Session.tsx", props: { from: "global" }, key: "g0" },
        { component: "Session.tsx", props: { from: "pageSections" }, key: "g1" },
      ]);
      const baseLoader = vi.fn().mockResolvedValue({ resolvedSections: [] });

      const cfg = withSiteGlobals({ loader: baseLoader });
      const result = await cfg.loader();

      // Only one Session ends up in the final tree (first-wins within globals).
      expect(result.resolvedSections).toHaveLength(1);
      expect(result.resolvedSections[0].props.from).toBe("global");
    });

    it("attaches siteGlobals.rawRefs for site to read head-injection data", async () => {
      const analyticsRef = {
        __resolveType: "website/sections/Analytics/Analytics.tsx",
        trackingIds: ["GTM-ABC"],
      };
      mockedLoadBlocks.mockReturnValue({
        site: { global: [analyticsRef] },
      });
      mockedResolvePageSections.mockResolvedValue([]);
      const baseLoader = vi.fn().mockResolvedValue({ resolvedSections: [] });

      const cfg = withSiteGlobals({ loader: baseLoader });
      const result = await cfg.loader();

      expect(result.siteGlobals).toEqual({ rawRefs: [analyticsRef] });
    });

    it("preserves wrapped loader's other return fields", async () => {
      mockedLoadBlocks.mockReturnValue({});
      const baseLoader = vi.fn().mockResolvedValue({
        resolvedSections: [],
        seo: { title: "Hello" },
        cacheProfile: "product",
        device: "mobile",
        pageUrl: "https://store.com/x",
      });

      const cfg = withSiteGlobals({ loader: baseLoader });
      const result = await cfg.loader();

      expect(result.seo).toEqual({ title: "Hello" });
      expect(result.cacheProfile).toBe("product");
      expect(result.device).toBe("mobile");
      expect(result.pageUrl).toBe("https://store.com/x");
    });
  });
});
