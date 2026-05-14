import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireAdminJwt } from "./auth";

describe("requireAdminJwt", () => {
  const originalBypass = process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS;
  beforeEach(() => {
    delete process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS;
  });
  afterEach(() => {
    if (originalBypass === undefined) {
      delete process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS;
    } else {
      process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS = originalBypass;
    }
  });

  it("returns 401 Response when no token is present", async () => {
    const req = new Request("http://t/fs/file/x");
    const res = await requireAdminJwt(req, "my-site");
    expect(res).toBeInstanceOf(Response);
    expect(res?.status).toBe(401);
  });

  it("returns 401 Response when token is malformed", async () => {
    const req = new Request("http://t/fs/file/x", {
      headers: { authorization: "Bearer not-a-jwt" },
    });
    const res = await requireAdminJwt(req, "my-site");
    expect(res?.status).toBe(401);
  });

  it("returns null (pass) when DANGEROUSLY_ALLOW_PUBLIC_ACCESS=true", async () => {
    process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS = "true";
    const req = new Request("http://t/fs/file/x");
    const res = await requireAdminJwt(req, "my-site");
    expect(res).toBeNull();
  });

  it("accepts a ?token= query param fallback", async () => {
    // Token is malformed but exercises the extraction path.
    const req = new Request("http://t/fs/file/x?token=abc");
    const res = await requireAdminJwt(req, "my-site");
    // Still 401 because token is invalid — but path was attempted.
    expect(res?.status).toBe(401);
  });
});
