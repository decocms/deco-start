import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDaemonMiddleware } from "./middleware";

describe("createDaemonMiddleware (integration)", () => {
  let httpServer: ReturnType<typeof createServer>;
  let url: string;
  const noopWatcher = { on: () => undefined };

  beforeEach(async () => {
    const middleware = createDaemonMiddleware({
      site: "my-site",
      server: { httpServer: null, watcher: noopWatcher },
    });
    httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      middleware(req, res, () => {
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise<void>((r) => httpServer.listen(0, r));
    url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => httpServer.close(() => r())));

  it("serves /_healthcheck without auth", async () => {
    const r = await fetch(url + "/_healthcheck");
    expect(r.status).toBe(200);
    expect((await r.text()).length).toBeGreaterThan(0);
  });

  it("serves /_ready without auth", async () => {
    const r = await fetch(url + "/_ready");
    expect([200, 503]).toContain(r.status);
  });

  it("returns 401 for /fs/file/anything without a token", async () => {
    process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS = "";
    const r = await fetch(url + "/fs/file/.deco/anything", {
      headers: { "x-daemon-api": "true" },
    });
    expect(r.status).toBe(401);
  });
});
