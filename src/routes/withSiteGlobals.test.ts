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
import {
  __resetSiteGlobalsCache,
  dedupeGlobals,
  resolveSiteGlobals,
  withSiteGlobals,
} from "./withSiteGlobals";

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

  describe("withSiteGlobals (deprecated no-op)", () => {
    // Site globals merging moved into the `loadCmsPage` server function so SSR
    // and SPA navigations both go through the same server-side path (#233).
    // The wrapper is now a passthrough kept only for backward compatibility.
    it("is an identity wrapper — returns the route config unchanged", () => {
      const baseLoader = vi.fn().mockResolvedValue({ resolvedSections: [] });
      const input = { loader: baseLoader, otherField: "kept" } as any;
      const cfg = withSiteGlobals(input);
      expect(cfg).toBe(input);
      expect(cfg.loader).toBe(baseLoader);
    });
  });

  describe("dedupeGlobals", () => {
    it("returns empty when globals is empty", () => {
      expect(
        dedupeGlobals(
          [],
          [{ component: "Header.tsx", props: {}, key: "p0" }],
        ),
      ).toEqual([]);
    });

    it("drops globals whose component already appears in existing", () => {
      const globals = [
        { component: "Theme.tsx", props: {}, key: "g0" },
        { component: "Session.tsx", props: {}, key: "g1" },
      ];
      const existing = [
        { component: "Session.tsx", props: { fromPage: true }, key: "p0" },
      ];

      const result = dedupeGlobals(globals, existing);
      // Session dropped (already on page); Theme kept.
      expect(result.map((s) => s.component)).toEqual(["Theme.tsx"]);
    });

    it("dedupes within globals (first-wins)", () => {
      const globals = [
        { component: "Session.tsx", props: { from: "global" }, key: "g0" },
        { component: "Session.tsx", props: { from: "pageSections" }, key: "g1" },
      ];
      const result = dedupeGlobals(globals, []);
      expect(result).toHaveLength(1);
      expect(result[0].props.from).toBe("global");
    });
  });
});
