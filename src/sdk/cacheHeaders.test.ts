import { describe, expect, it } from "vitest";
import {
  canonicalizeServerFnPayloadForCacheKey,
  detectCacheProfile,
  serverFnPagePath,
} from "./cacheHeaders";

const sfn = (payload: unknown): URL => {
  const u = new URL("https://store.com/_serverFn/abc123");
  if (payload !== undefined) u.searchParams.set("payload", JSON.stringify(payload));
  return u;
};

describe("serverFnPagePath — extract page path from GET server-fn payload", () => {
  it("returns null for a non-server-fn URL", () => {
    expect(serverFnPagePath(new URL("https://store.com/escolar/p"))).toBeNull();
  });

  it("returns null when there is no payload", () => {
    expect(serverFnPagePath(new URL("https://store.com/_serverFn/abc"))).toBeNull();
  });

  it("extracts the page path from TanStack's serialized envelope", () => {
    // Shape observed from a real loadCmsPage preload request.
    const payload = {
      t: {
        t: 10,
        i: 0,
        p: { k: ["data"], v: [{ t: 1, s: "/mochila-executiva-preta/p" }] },
        o: 0,
      },
      f: 63,
      m: [],
    };
    expect(serverFnPagePath(sfn(payload))).toBe("/mochila-executiva-preta/p");
  });

  it("extracts the page path from the simple { data } form", () => {
    expect(serverFnPagePath(sfn({ data: "/c/shoes" }))).toBe("/c/shoes");
  });

  it("returns null on malformed payload (fails safe)", () => {
    const u = new URL("https://store.com/_serverFn/abc");
    u.searchParams.set("payload", "{not json");
    expect(serverFnPagePath(u)).toBeNull();
  });

  it("ignores protocol-relative-looking values (//) and finds none", () => {
    expect(serverFnPagePath(sfn({ data: "//cdn.example.com/x" }))).toBeNull();
  });

  it("lets the server-fn response inherit the page's cache profile", () => {
    // The whole point: a PDP data request should profile as "product" (5min),
    // not the "listing" (60s) it would get from the /_serverFn pathname.
    const pdp = serverFnPagePath(sfn({ data: "/bolsa-preta/p" }));
    expect(pdp).toBe("/bolsa-preta/p");
    expect(detectCacheProfile(pdp!)).toBe("product");

    const home = serverFnPagePath(sfn({ data: "/" }));
    expect(detectCacheProfile(home!)).toBe("static");
  });
});

describe("canonicalizeServerFnPayloadForCacheKey — variant-param cache key", () => {
  // The real envelope shape observed from a loadCmsPage preload.
  const envelope = (path: string) =>
    JSON.stringify({
      t: { t: 10, i: 0, p: { k: ["data"], v: [{ t: 1, s: path }] }, o: 0 },
      f: 63,
      m: [],
    });

  it("strips skuId so a variant URL keys the same as the canonical path", () => {
    const withSku = canonicalizeServerFnPayloadForCacheKey(
      envelope("/mala-preta/p?skuId=148940"),
    );
    const canonical = canonicalizeServerFnPayloadForCacheKey(envelope("/mala-preta/p"));
    expect(withSku).toBe(canonical);
  });

  it("strips idsku as well", () => {
    const a = canonicalizeServerFnPayloadForCacheKey(envelope("/x/p?idsku=99"));
    const b = canonicalizeServerFnPayloadForCacheKey(envelope("/x/p"));
    expect(a).toBe(b);
  });

  it("keeps PLP filter/search params (they DO change the response)", () => {
    const filtered = canonicalizeServerFnPayloadForCacheKey(
      envelope("/c/shoes?filter.size=40"),
    );
    const plain = canonicalizeServerFnPayloadForCacheKey(envelope("/c/shoes"));
    expect(filtered).not.toBe(plain);
    expect(filtered).toContain("filter.size=40");
  });

  it("keeps a non-ignored param while dropping skuId", () => {
    const out = canonicalizeServerFnPayloadForCacheKey(
      envelope("/c/shoes?q=boot&skuId=1"),
    );
    expect(out).toContain("q=boot");
    expect(out).not.toContain("skuId");
  });

  it("canonicalizes equivalent payloads to byte-identical strings", () => {
    // Even with no ignored param, both must round-trip to the same string so
    // the cache key is stable regardless of incidental serialization diffs.
    const a = canonicalizeServerFnPayloadForCacheKey(envelope("/a/p"));
    const b = canonicalizeServerFnPayloadForCacheKey(envelope("/a/p"));
    expect(a).toBe(b);
  });

  it("returns the original string on malformed payload (fail-safe)", () => {
    expect(canonicalizeServerFnPayloadForCacheKey("{not json")).toBe("{not json");
  });
});
