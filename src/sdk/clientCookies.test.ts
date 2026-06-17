import { describe, expect, it } from "vitest";
import {
  buildClientCookieScript,
  injectScriptIntoHtml,
  stripFrameworkSetCookies,
} from "./clientCookies";

describe("clientCookies", () => {
  it("buildClientCookieScript captures deco_matcher_* cookies", () => {
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      "deco_matcher_123456=abc%401; Path=/; Max-Age=2592000; SameSite=Lax",
    );
    headers.append("Set-Cookie", "cart_id=xyz; Path=/");

    const script = buildClientCookieScript(headers);
    expect(script).toContain("document.cookie=");
    expect(script).toContain("deco_matcher_123456");
    expect(script).not.toContain("cart_id");
  });

  it("injectScriptIntoHtml inserts at head", () => {
    const html = "<html><head></head><body></body></html>";
    const out = injectScriptIntoHtml(html, "<script>/* test */</script>");
    expect(out).toContain("<head><script>/* test */</script></head>");
  });

  it("stripFrameworkSetCookies removes only framework cookies", () => {
    const headers = new Headers();
    headers.append("Set-Cookie", "deco_segment=%7B%7D; Path=/");
    headers.append("Set-Cookie", "cart_id=abc; Path=/");

    stripFrameworkSetCookies(headers);
    const remaining =
      (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toContain("cart_id");
  });
});
