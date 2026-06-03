import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPageByPath, matchPath, setBlocks } from "./loader";

// Mirrors the behavior of the original deco-cx/deco Fresh framework
// (runtime/features/render.tsx), which uses native `URLPattern` directly
// and returns `result.pathname.groups`. Splats become numbered groups
// ("0", "1", …) — there is no `_splat` rename.

describe("matchPath", () => {
  describe("literal segments", () => {
    it("matches the root path", () => {
      expect(matchPath("/", "/")).toEqual({});
    });

    it("matches exact literal paths", () => {
      expect(matchPath("/foo/bar", "/foo/bar")).toEqual({});
    });

    it("returns null when literals differ", () => {
      expect(matchPath("/foo/bar", "/foo/baz")).toBeNull();
    });

    it("returns null when literal-only pattern does not span the whole URL", () => {
      expect(matchPath("/foo", "/foo/bar")).toBeNull();
    });
  });

  describe("named params (:slug)", () => {
    it("captures a single param", () => {
      expect(matchPath("/foo/:slug", "/foo/sabonete")).toEqual({ slug: "sabonete" });
    });

    it("captures a param sandwiched between literals (VTEX PDP)", () => {
      expect(matchPath("/produto/:slug/p", "/produto/sabonete/p")).toEqual({
        slug: "sabonete",
      });
    });

    it("returns null when the URL is shorter than the pattern", () => {
      expect(matchPath("/foo/:slug", "/foo")).toBeNull();
    });
  });

  describe("trailing splat (*)", () => {
    it("captures the rest as group '0'", () => {
      expect(matchPath("/*", "/foo/bar")).toEqual({ "0": "foo/bar" });
    });

    it("matches root with empty splat", () => {
      expect(matchPath("/*", "/")).toEqual({ "0": "" });
    });

    it("captures the remainder under a prefix", () => {
      expect(matchPath("/foo/*", "/foo/bar/baz")).toEqual({ "0": "bar/baz" });
    });

    // Intentional bug fix: the previous custom matchPath accidentally matched
    // `/foo` against `/foo/*` due to its naive split("/") logic, which also
    // mis-handled trailing slashes. Native URLPattern (and the Fresh original)
    // require at least one segment after `/foo/`.
    it("does NOT match the bare prefix without a trailing segment", () => {
      expect(matchPath("/foo/*", "/foo")).toBeNull();
    });
  });

  describe("URLPattern optional groups ({...}?)", () => {
    // Patterns emitted by the deco-cx admin / present in production CMS data.
    // These are the cases that issue #213 documents as broken.

    it("matches with the optional group present", () => {
      expect(matchPath("/{granado/}?*", "/granado/perfumaria")).toEqual({
        "0": "perfumaria",
      });
    });

    it("matches with the optional group absent", () => {
      expect(matchPath("/{granado/}?*", "/perfumaria")).toEqual({ "0": "perfumaria" });
    });

    it("matches root when optional prefix and splat collapse to empty", () => {
      expect(matchPath("/{granado/}?*", "/")).toEqual({ "0": "" });
    });

    it("matches with an optional prefix before a literal segment", () => {
      expect(
        matchPath("/{granado/}?campanhas/*", "/granado/campanhas/destaques-2023"),
      ).toEqual({ "0": "destaques-2023" });
      expect(
        matchPath("/{granado/}?campanhas/*", "/campanhas/destaques-2023"),
      ).toEqual({ "0": "destaques-2023" });
    });

    it("matches an optional suffix group present and absent", () => {
      expect(matchPath("/black-friday{/70-off}?", "/black-friday")).toEqual({});
      expect(matchPath("/black-friday{/70-off}?", "/black-friday/70-off")).toEqual({});
    });
  });

  describe("error tolerance", () => {
    it("returns null for malformed patterns instead of throwing", () => {
      expect(() => matchPath("/[invalid", "/anything")).not.toThrow();
      expect(matchPath("/[invalid", "/anything")).toBeNull();
    });
  });
});

describe("findPageByPath specificity", () => {
  beforeEach(() => {
    setBlocks({
      "pages-bf": {
        name: "Black Friday",
        path: "/black-friday",
        sections: [],
      },
      "pages-bf-splat": {
        name: "Black Friday with optional suffix",
        path: "/black-friday{/70-off}?",
        sections: [],
      },
      "pages-pdp-plp": {
        name: "PDP & PLP",
        path: "/{granado/}?*",
        sections: [],
      },
      "pages-product": {
        name: "Product",
        path: "/produto/:slug/p",
        sections: [],
      },
    });
  });

  afterEach(() => {
    setBlocks({});
  });

  it("prefers an exact literal over an optional-group splat", () => {
    const match = findPageByPath("/black-friday");
    expect(match?.blockKey).toBe("pages-bf");
  });

  it("prefers the home page over an optional-group splat catch-all", () => {
    // Regression: /{granado/}?* matches "/" and was out-ranking the home
    // because the `{granado` segment counted as a param. The home block
    // is a literal-only `/` path and must always win.
    setBlocks({
      "pages-home": {
        name: "Home",
        path: "/",
        sections: [],
      },
      "pages-pdp-plp": {
        name: "PDP & PLP",
        path: "/{granado/}?*",
        sections: [],
      },
    });
    const match = findPageByPath("/");
    expect(match?.blockKey).toBe("pages-home");
  });

  it("falls back to the splat page for unknown URLs", () => {
    const match = findPageByPath("/perfumaria");
    expect(match?.blockKey).toBe("pages-pdp-plp");
    expect(match?.params).toEqual({ "0": "perfumaria" });
  });

  it("matches the param-bearing route ahead of the splat catch-all", () => {
    const match = findPageByPath("/produto/sabonete/p");
    expect(match?.blockKey).toBe("pages-product");
    expect(match?.params).toEqual({ slug: "sabonete" });
  });

  it("returns null when no page matches", () => {
    setBlocks({
      "pages-only-bf": {
        name: "Black Friday",
        path: "/black-friday",
        sections: [],
      },
    });
    expect(findPageByPath("/nope")).toBeNull();
  });
});
