import { describe, expect, it } from "vitest";
import { redactUrl } from "./urlRedaction";

describe("redactUrl", () => {
  it("redacts every query value by default", () => {
    expect(redactUrl("https://api.test/path?token=abc&page=2")).toBe(
      "https://api.test/path?token=REDACTED&page=REDACTED",
    );
  });

  it("preserves query keys listed in keepQueryKeys", () => {
    expect(
      redactUrl("https://api.test/path?token=abc&page=2&sort=name", {
        keepQueryKeys: ["page", "sort"],
      }),
    ).toBe("https://api.test/path?token=REDACTED&page=2&sort=name");
  });

  it("preserves empty query values verbatim", () => {
    expect(redactUrl("https://api.test/path?page=&token=abc")).toBe(
      "https://api.test/path?page=&token=REDACTED",
    );
  });

  it("strips userinfo from authority component", () => {
    expect(redactUrl("https://user:secret@api.test/path?x=1")).toBe(
      "https://api.test/path?x=REDACTED",
    );
  });

  it("drops the fragment", () => {
    expect(redactUrl("https://api.test/path?x=1#client-only-state-token=abc")).toBe(
      "https://api.test/path?x=REDACTED",
    );
  });

  it("preserves host and path verbatim", () => {
    expect(redactUrl("https://api.test/products/12345/details?x=1")).toBe(
      "https://api.test/products/12345/details?x=REDACTED",
    );
  });

  it("falls back to substring-before-? on unparseable URLs", () => {
    // Missing scheme — URL constructor throws.
    expect(redactUrl("not-a-url?token=abc")).toBe("not-a-url");
  });

  it("falls back to substring-before-# on unparseable URLs (no `?`)", () => {
    // Fragments can also carry secrets (`#access_token=…` in OAuth implicit
    // grant). The defensive path must drop them too.
    expect(redactUrl("not-a-url#access_token=abc")).toBe("not-a-url");
  });

  it("falls back to whichever of `?` / `#` appears first on unparseable URLs", () => {
    expect(redactUrl("not-a-url?x=1#y=2")).toBe("not-a-url");
    expect(redactUrl("not-a-url#frag?then=secret")).toBe("not-a-url");
  });

  it("returns the raw value when there is no query and the URL is unparseable", () => {
    expect(redactUrl("relative/path")).toBe("relative/path");
  });

  it("handles URLs without query string unchanged", () => {
    expect(redactUrl("https://api.test/products")).toBe("https://api.test/products");
  });

  it("redacts multi-value query parameters (e.g. ?fq=a&fq=b)", () => {
    // URLSearchParams collapses repeated keys to a single value when .set() is
    // called — the OTel guideline accepts this as acceptable cardinality loss.
    const out = redactUrl("https://api.test/path?fq=a&fq=b");
    expect(out).toBe("https://api.test/path?fq=REDACTED");
  });
});
