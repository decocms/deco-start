import { describe, expect, it } from "vitest";

import { parseLoadCmsHomePageInput, parseLoadCmsPageInput } from "./cmsRoute";

describe("parseLoadCmsPageInput (#292 resolveGlobals opt-out)", () => {
  it("treats a bare string as the path with globals enabled (back-compat)", () => {
    expect(parseLoadCmsPageInput("/p/foo?skuId=1")).toEqual({
      path: "/p/foo?skuId=1",
      resolveGlobals: true,
    });
  });

  it("defaults resolveGlobals to true when the object omits it", () => {
    expect(parseLoadCmsPageInput({ path: "/c/shoes" })).toEqual({
      path: "/c/shoes",
      resolveGlobals: true,
    });
  });

  it("respects resolveGlobals: false explicitly", () => {
    expect(parseLoadCmsPageInput({ path: "/", resolveGlobals: false })).toEqual({
      path: "/",
      resolveGlobals: false,
    });
  });

  it("keeps globals on for any non-false value", () => {
    expect(parseLoadCmsPageInput({ path: "/x", resolveGlobals: true }).resolveGlobals).toBe(true);
  });

  it("falls back to '/' when no path is provided", () => {
    expect(parseLoadCmsPageInput({}).path).toBe("/");
    expect(parseLoadCmsPageInput(undefined).path).toBe("/");
  });
});

describe("parseLoadCmsHomePageInput (#292 resolveGlobals opt-out)", () => {
  it("defaults resolveGlobals to true for undefined / empty input", () => {
    expect(parseLoadCmsHomePageInput(undefined).resolveGlobals).toBe(true);
    expect(parseLoadCmsHomePageInput({}).resolveGlobals).toBe(true);
  });

  it("respects resolveGlobals: false explicitly", () => {
    expect(parseLoadCmsHomePageInput({ resolveGlobals: false }).resolveGlobals).toBe(false);
  });
});
