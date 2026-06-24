import { describe, expect, it } from "vitest";
import { derivePageUrl } from "./pageUrl";

describe("derivePageUrl (#280 — client-nav request URL)", () => {
  it("SSR real page without query: rebuilds from fullPath", () => {
    expect(
      derivePageUrl("/granado/produto", new URL("https://o.com/granado/produto")),
    ).toBe("https://o.com/granado/produto");
  });

  it("SSR real page preserves duplicate query params from the server URL", () => {
    // The TanStack search record collapses dup params; the server URL keeps them.
    expect(
      derivePageUrl(
        "/c/shoes?filter.category-1=a",
        new URL("https://o.com/c/shoes?filter.category-1=a&filter.category-1=b"),
      ),
    ).toBe("https://o.com/c/shoes?filter.category-1=a&filter.category-1=b");
  });

  it("client nav without query: rebuilds from fullPath, NOT the /_serverFn URL", () => {
    // The regression guard: getRequestUrl() is the serverFn endpoint here.
    const serverUrl = new URL(
      "https://o.com/_serverFn/loadCmsPage?payload=%2Fgranado%2Fproduto",
    );
    expect(derivePageUrl("/granado/produto", serverUrl)).toBe(
      "https://o.com/granado/produto",
    );
  });

  it("client nav with query: rebuilds path+search from fullPath", () => {
    const serverUrl = new URL("https://o.com/_serverFn/loadCmsPage?payload=x");
    expect(derivePageUrl("/s?q=foo", serverUrl)).toBe("https://o.com/s?q=foo");
  });

  it("home '/' on client nav: rebuilds to '/', not the /_serverFn URL", () => {
    // basePath '/' is a prefix of every path; the old startsWith check would
    // have returned the serverFn URL here.
    const serverUrl = new URL("https://o.com/_serverFn/loadCmsPage?payload=x");
    expect(derivePageUrl("/", serverUrl)).toBe("https://o.com/");
  });
});
