import { afterEach, describe, expect, it } from "vitest";
import { findPageByPath, getAllPages, normalizePagePath, setBlocks } from "./loader";

afterEach(() => {
  setBlocks({});
});

describe("normalizePagePath", () => {
  it("strips trailing slash from non-root paths", () => {
    expect(normalizePagePath("/ofertas/datas-promocionais/")).toBe("/ofertas/datas-promocionais");
  });

  it("preserves the root path", () => {
    expect(normalizePagePath("/")).toBe("/");
  });

  it("is a no-op for paths already without trailing slash", () => {
    expect(normalizePagePath("/ofertas/datas-promocionais")).toBe("/ofertas/datas-promocionais");
  });

  it("handles empty input", () => {
    expect(normalizePagePath("")).toBe("");
  });
});

describe("findPageByPath with trailing-slash paths", () => {
  it("matches a URL without trailing slash against a block whose path has one", () => {
    setBlocks({
      "pages-Datas Promocionais-670910": {
        name: "Datas Promocionais",
        path: "/ofertas/datas-promocionais/",
        sections: [],
      },
    });

    const match = findPageByPath("/ofertas/datas-promocionais");
    expect(match).not.toBeNull();
    expect(match?.blockKey).toBe("pages-Datas Promocionais-670910");
    expect(match?.page.path).toBe("/ofertas/datas-promocionais");
  });

  it("matches a URL with trailing slash against a block whose path has none", () => {
    setBlocks({
      "pages-Foo-1": { name: "Foo", path: "/foo", sections: [] },
    });

    const match = findPageByPath("/foo/");
    expect(match).not.toBeNull();
    expect(match?.blockKey).toBe("pages-Foo-1");
  });

  it("still prefers static paths over parameterized ones", () => {
    setBlocks({
      "pages-Ofertas-catch-all": {
        name: "Ofertas",
        path: "/ofertas/:s",
        sections: [],
      },
      "pages-Datas Promocionais-670910": {
        name: "Datas Promocionais",
        path: "/ofertas/datas-promocionais/",
        sections: [],
      },
    });

    const match = findPageByPath("/ofertas/datas-promocionais");
    expect(match?.blockKey).toBe("pages-Datas Promocionais-670910");
  });

  it("exposes normalized paths through getAllPages", () => {
    setBlocks({
      "pages-A": { name: "A", path: "/a/", sections: [] },
      "pages-B": { name: "B", path: "/b", sections: [] },
      "pages-Home": { name: "Home", path: "/", sections: [] },
    });

    const pages = getAllPages();
    const byKey = Object.fromEntries(pages.map((p) => [p.key, p.page.path]));
    expect(byKey["pages-A"]).toBe("/a");
    expect(byKey["pages-B"]).toBe("/b");
    expect(byKey["pages-Home"]).toBe("/");
  });
});
