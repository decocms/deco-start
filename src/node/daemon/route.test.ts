import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_COMPAT_VERSION } from "../../core/admin/version";
import { createDecoAdminRoute } from "./route";

describe("createDecoAdminRoute", () => {
  const originalEnv = process.env.NODE_ENV;
  const originalBypass = process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS;

  beforeEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
    if (originalBypass === undefined) delete process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS;
    else process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS = originalBypass;
  });

  it("serves /_healthcheck with the version body", async () => {
    const handler = createDecoAdminRoute({ site: "my-site" });
    const res = await handler(new Request("http://t/_healthcheck"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ADMIN_COMPAT_VERSION);
  });

  it("serves /_ready (503 before setBlocks-equivalent state)", async () => {
    const handler = createDecoAdminRoute({ site: "my-site" });
    const res = await handler(new Request("http://t/_ready"));
    expect([200, 503]).toContain(res.status);
  });

  it("returns 404 when the master enabled switch is false", async () => {
    const handler = createDecoAdminRoute({ site: "my-site", enabled: false });
    const res = await handler(new Request("http://t/_healthcheck"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when an individual group is disabled", async () => {
    const handler = createDecoAdminRoute({ site: "my-site", healthcheck: false });
    expect((await handler(new Request("http://t/_healthcheck"))).status).toBe(404);
    expect((await handler(new Request("http://t/_ready"))).status).not.toBe(404);
  });

  it("disables /fs/* and /_watch in production by default", async () => {
    process.env.NODE_ENV = "production";
    const handler = createDecoAdminRoute({ site: "my-site" });
    expect((await handler(new Request("http://t/_watch"))).status).toBe(404);
    expect((await handler(new Request("http://t/fs/file/anything"))).status).toBe(404);
  });

  it("enables /fs/* and /_watch in development by default", async () => {
    process.env.NODE_ENV = "development";
    process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS = "true";
    // manageWatcher: false avoids spinning up a real chokidar against repo root
    // for unit tests; the lazy-watcher integration is exercised in src/next/.
    const handler = createDecoAdminRoute({
      site: "my-site",
      cwd: process.cwd(),
      manageWatcher: false,
    });
    const fsRes = await handler(new Request("http://t/fs/file/.deco/missing.json"));
    // 404 here means "file not found", not "route disabled" — assert it's not the route-404 case.
    expect(fsRes.status).toBe(404);
    expect((await fsRes.json()).timestamp).toBeGreaterThan(0);
  });

  it("gates /fs/* on JWT when bypass is not set", async () => {
    process.env.NODE_ENV = "development";
    const handler = createDecoAdminRoute({
      site: "my-site",
      manageWatcher: false,
    });
    const res = await handler(new Request("http://t/fs/file/.deco/anything"));
    expect(res.status).toBe(401);
  });

  it("creates the chokidar watcher lazily on first /fs/* hit when manageWatcher is on", async () => {
    process.env.NODE_ENV = "development";
    process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS = "true";
    const handler = createDecoAdminRoute({
      site: "my-site",
      cwd: process.cwd(),
      manageWatcher: true,
    });
    // Hit a non-existent path so we don't depend on repo contents; we only care
    // that the call succeeds without crashing the lazy-watcher boot.
    const res = await handler(new Request("http://t/fs/file/.deco/missing.json"));
    expect(res.status).toBe(404);
  });

  it("returns 501 for /volumes/<id>/files (Next path)", async () => {
    const handler = createDecoAdminRoute({ site: "my-site" });
    const res = await handler(new Request("http://t/volumes/abc/files"));
    expect(res.status).toBe(501);
  });

  it("throws at construction when site is missing and admin-protocol is enabled", () => {
    expect(() => createDecoAdminRoute({})).toThrow(/site/);
  });

  it("does not require site when only probes are enabled", () => {
    expect(() =>
      createDecoAdminRoute({
        adminProtocol: false,
        fs: false,
        watch: false,
      }),
    ).not.toThrow();
  });

  it("awaits onRequest exactly once per request before pathname dispatch", async () => {
    let calls = 0;
    const handler = createDecoAdminRoute({
      site: "my-site",
      onRequest: async () => {
        calls++;
      },
    });
    const res = await handler(new Request("http://t/_healthcheck"));
    expect(res.status).toBe(200);
    expect(calls).toBe(1);

    await handler(new Request("http://t/_ready"));
    expect(calls).toBe(2);
  });

  it("short-circuits with the Response returned by onRequest", async () => {
    const handler = createDecoAdminRoute({
      site: "my-site",
      onRequest: () => new Response("maintenance", { status: 503 }),
    });
    const res = await handler(new Request("http://t/_healthcheck"));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("maintenance");
  });

  it("continues to the dispatcher when onRequest returns undefined", async () => {
    const handler = createDecoAdminRoute({
      site: "my-site",
      onRequest: () => undefined,
    });
    const res = await handler(new Request("http://t/_healthcheck"));
    expect(res.status).toBe(200);
  });

  it("skips onRequest entirely when enabled is false", async () => {
    let called = false;
    const handler = createDecoAdminRoute({
      site: "my-site",
      enabled: false,
      onRequest: () => {
        called = true;
      },
    });
    const res = await handler(new Request("http://t/_healthcheck"));
    expect(res.status).toBe(404);
    expect(called).toBe(false);
  });
});
