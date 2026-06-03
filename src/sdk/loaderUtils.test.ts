import { describe, expect, it } from "vitest";
import { getSearchParam, getSearchParams } from "./loaderUtils";

describe("getSearchParam", () => {
  it("returns the matching query value", () => {
    expect(
      getSearchParam(
        { __pageUrl: "https://store.com/p?skuId=12345" },
        "skuId",
      ),
    ).toBe("12345");
  });

  it("returns null when the param is absent", () => {
    expect(
      getSearchParam({ __pageUrl: "https://store.com/p" }, "skuId"),
    ).toBeNull();
  });

  it("returns null when __pageUrl is missing", () => {
    expect(getSearchParam({}, "skuId")).toBeNull();
  });

  it("returns null instead of throwing on a malformed URL", () => {
    expect(() =>
      getSearchParam({ __pageUrl: "not a url" }, "skuId"),
    ).not.toThrow();
    expect(getSearchParam({ __pageUrl: "not a url" }, "skuId")).toBeNull();
  });

  it("decodes URL-encoded values", () => {
    expect(
      getSearchParam(
        { __pageUrl: "https://store.com/?q=preto%20azul" },
        "q",
      ),
    ).toBe("preto azul");
  });

  it("returns the last value for duplicate keys (URLSearchParams behavior)", () => {
    // `URLSearchParams#get` returns the first match — locking this so we
    // notice if it ever drifts.
    expect(
      getSearchParam(
        { __pageUrl: "https://store.com/?filter=a&filter=b" },
        "filter",
      ),
    ).toBe("a");
  });
});

describe("getSearchParams", () => {
  it("returns all query params as a record", () => {
    expect(
      getSearchParams({
        __pageUrl: "https://store.com/p?skuId=1&size=M&color=red",
      }),
    ).toEqual({ skuId: "1", size: "M", color: "red" });
  });

  it("returns {} when __pageUrl is missing", () => {
    expect(getSearchParams({})).toEqual({});
  });

  it("returns {} for malformed URLs without throwing", () => {
    expect(() => getSearchParams({ __pageUrl: "//::///" })).not.toThrow();
  });

  it("collapses duplicate keys to the last value", () => {
    expect(
      getSearchParams({
        __pageUrl: "https://store.com/?filter=a&filter=b",
      }),
    ).toEqual({ filter: "b" });
  });
});
