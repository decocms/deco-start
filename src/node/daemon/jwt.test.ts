import { describe, expect, it } from "vitest";
import { tokenIsValid, type JwtPayload, verifyAdminJwt } from "./jwt";

describe("verifyAdminJwt", () => {
  it("returns null for malformed tokens", async () => {
    expect(await verifyAdminJwt("not-a-jwt")).toBeNull();
    expect(await verifyAdminJwt("a.b")).toBeNull();
    expect(await verifyAdminJwt("")).toBeNull();
  });

  it("returns null for tokens with invalid signatures", async () => {
    // header.payload.signature where signature does not verify
    const fake = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.AAAA";
    expect(await verifyAdminJwt(fake)).toBeNull();
  });
});

describe("tokenIsValid", () => {
  it("rejects payloads missing iss or sub", () => {
    expect(tokenIsValid("my-site", { iss: "x" } as JwtPayload)).toBe(false);
    expect(tokenIsValid("my-site", { sub: "x" } as JwtPayload)).toBe(false);
  });

  it("rejects expired tokens", () => {
    expect(
      tokenIsValid("my-site", {
        iss: "admin",
        sub: "urn:deco:site:org:my-site:deployment/123",
        exp: 1,
      }),
    ).toBe(false);
  });

  it("accepts a matching site URN", () => {
    expect(
      tokenIsValid("my-site", {
        iss: "admin",
        sub: "urn:deco:site:org:my-site:deployment/123",
        exp: 9999999999,
      }),
    ).toBe(true);
  });

  it("rejects mismatched site", () => {
    expect(
      tokenIsValid("other-site", {
        iss: "admin",
        sub: "urn:deco:site:org:my-site:deployment/123",
        exp: 9999999999,
      }),
    ).toBe(false);
  });
});
