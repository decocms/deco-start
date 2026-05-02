import { describe, expect, it } from "vitest";
import {
  deleteResponseCookie,
  getCookies,
  setResponseCookie,
} from "./cookie";

describe("getCookies", () => {
  it("returns an empty object when no Cookie header is present", () => {
    expect(getCookies(new Headers())).toEqual({});
  });

  it("parses a single cookie", () => {
    const h = new Headers({ cookie: "session=abc" });
    expect(getCookies(h)).toEqual({ session: "abc" });
  });

  it("parses multiple cookies separated by '; '", () => {
    const h = new Headers({ cookie: "a=1; b=2; c=3" });
    expect(getCookies(h)).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("URL-decodes values", () => {
    const h = new Headers({ cookie: "u=hello%20world" });
    expect(getCookies(h)).toEqual({ u: "hello world" });
  });

  it("falls back to the raw value when decoding fails", () => {
    // Lone '%' is invalid in URL encoding.
    const h = new Headers({ cookie: "x=100%" });
    expect(getCookies(h)).toEqual({ x: "100%" });
  });

  it("ignores entries without an '='", () => {
    const h = new Headers({ cookie: "garbage; ok=yes" });
    expect(getCookies(h)).toEqual({ ok: "yes" });
  });

  it("trims whitespace around names", () => {
    const h = new Headers({ cookie: " a=1; b=2 " });
    expect(getCookies(h)).toEqual({ a: "1", b: "2" });
  });
});

describe("setResponseCookie", () => {
  it("appends a Set-Cookie header with the cookie name and value", () => {
    const h = new Headers();
    setResponseCookie(h, { name: "session", value: "abc" });
    expect(h.get("set-cookie")).toBe("session=abc");
  });

  it("serializes maxAge, path, secure, httpOnly, sameSite, domain", () => {
    const h = new Headers();
    setResponseCookie(h, {
      name: "session",
      value: "abc",
      maxAge: 3600,
      path: "/",
      domain: "example.com",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
    const value = h.get("set-cookie")!;
    expect(value).toContain("session=abc");
    expect(value).toContain("Max-Age=3600");
    expect(value).toContain("Domain=example.com");
    expect(value).toContain("Path=/");
    expect(value).toContain("Secure");
    expect(value).toContain("HttpOnly");
    expect(value).toContain("SameSite=Lax");
  });

  it("serializes expires as a UTC string", () => {
    const h = new Headers();
    const date = new Date("2030-01-01T00:00:00Z");
    setResponseCookie(h, { name: "x", value: "y", expires: date });
    expect(h.get("set-cookie")).toContain(`Expires=${date.toUTCString()}`);
  });

  it("appends multiple cookies (does not overwrite the first)", () => {
    const h = new Headers();
    setResponseCookie(h, { name: "a", value: "1" });
    setResponseCookie(h, { name: "b", value: "2" });
    // Headers.getAll isn't standard; getSetCookie() is the modern API.
    const all = (h as any).getSetCookie?.() as string[] | undefined;
    if (all) {
      expect(all).toEqual(["a=1", "b=2"]);
    } else {
      // Fallback: the combined header value should mention both.
      const v = h.get("set-cookie")!;
      expect(v).toContain("a=1");
      expect(v).toContain("b=2");
    }
  });
});

describe("deleteResponseCookie", () => {
  it("emits a Set-Cookie that expires immediately", () => {
    const h = new Headers();
    deleteResponseCookie(h, "session", { path: "/" });
    const value = h.get("set-cookie")!;
    expect(value).toContain("session=");
    expect(value).toContain("Max-Age=0");
    expect(value).toContain(`Expires=${new Date(0).toUTCString()}`);
    expect(value).toContain("Path=/");
  });
});
