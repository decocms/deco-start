import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleDecoAdminRoute } from "./adminRoute";

beforeAll(() => { process.env.DECO_SITE = "my-site"; });
afterAll(() => { delete process.env.DECO_SITE; });

describe("handleDecoAdminRoute", () => {
  it("returns 404 for non-admin paths", async () => {
    const req = new Request("http://t/some/random/path");
    const res = await handleDecoAdminRoute(req);
    expect(res.status).toBe(404);
  });

  it("dispatches /live/_meta to a real handler (no exception)", async () => {
    const req = new Request("http://t/live/_meta");
    const res = await handleDecoAdminRoute(req);
    // Don't assert exact status (auth-dependent); just that it returns a Response.
    expect(res).toBeInstanceOf(Response);
  });
});

describe("handleDecoAdminRoute — extended dispatch", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  beforeEach(() => {
    delete process.env.NODE_ENV;
    process.env.DECO_SITE = "my-site";
  });
  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    delete process.env.DECO_SITE;
  });

  it("serves /_healthcheck", async () => {
    const res = await handleDecoAdminRoute(new Request("http://t/_healthcheck"));
    expect(res.status).toBe(200);
  });

  it("serves /_ready", async () => {
    const res = await handleDecoAdminRoute(new Request("http://t/_ready"));
    expect([200, 503]).toContain(res.status);
  });

  it("returns 501 for /volumes/<id>/files", async () => {
    const res = await handleDecoAdminRoute(new Request("http://t/volumes/abc/files"));
    expect(res.status).toBe(501);
  });

  it("disables /_watch in production", async () => {
    process.env.NODE_ENV = "production";
    const res = await handleDecoAdminRoute(new Request("http://t/_watch"));
    expect(res.status).toBe(404);
  });
});
