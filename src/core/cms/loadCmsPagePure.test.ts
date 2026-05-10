import { describe, expect, it } from "vitest";
import { loadCmsPagePure } from "./loadCmsPagePure";
import type { MatcherContext } from "./resolve";

describe("loadCmsPagePure", () => {
  it("is an async function with two arguments (fullPath, ctx)", () => {
    expect(typeof loadCmsPagePure).toBe("function");
    expect(loadCmsPagePure.length).toBe(2);
  });

  it("returns null for an unknown path", async () => {
    const ctx: MatcherContext = {
      userAgent: "vitest",
      url: "http://test.local/this-path-does-not-exist",
      path: "/this-path-does-not-exist",
      cookies: {},
    };
    const result = await loadCmsPagePure("/this-path-does-not-exist", ctx);
    expect(result).toBeNull();
  });

  it("does not crash without TanStack request context being set", async () => {
    // The whole point: no getRequestUrl/getCookies/getRequest must be called.
    const ctx: MatcherContext = {
      userAgent: "",
      url: "http://test.local/",
      path: "/",
      cookies: {},
    };
    // Should resolve, even if to null (no blocks loaded in test).
    await expect(loadCmsPagePure("/", ctx)).resolves.toBeDefined();
  });
});
