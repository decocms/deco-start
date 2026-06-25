import { describe, expect, it } from "vitest";
import { detectCacheProfile, serverFnPagePath } from "./cacheHeaders";

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
