import { describe, expect, it } from "vitest";
import { createDecoAdminRouteHandlers, decoAdminRouteHandlers } from "./routeHandlers";

describe("createDecoAdminRouteHandlers", () => {
  it("returns identical handlers for GET and POST that delegate to the dispatcher", async () => {
    const { GET, POST } = createDecoAdminRouteHandlers({ site: "my-site" });
    const a = await GET(new Request("http://t/_healthcheck"));
    const b = await POST(new Request("http://t/_healthcheck"));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it("returns the same handler reference for all four HTTP methods", () => {
    // Smoke test — the dispatcher branches on method internally, so all
    // method exports share a single function reference. If this regresses,
    // the /fs/file/* mutating routes will silently fall through to 405.
    const handlers = createDecoAdminRouteHandlers({ site: "my-site" });
    expect(handlers.PATCH).toBe(handlers.GET);
    expect(handlers.DELETE).toBe(handlers.GET);
    expect(handlers.POST).toBe(handlers.GET);
  });

  it("decoAdminRouteHandlers is the default-options instance", async () => {
    process.env.DECO_SITE = "my-site";
    const res = await decoAdminRouteHandlers.GET(new Request("http://t/_healthcheck"));
    expect(res.status).toBe(200);
    delete process.env.DECO_SITE;
  });

  it("decoAdminRouteHandlers exposes PATCH and DELETE on the default instance", () => {
    expect(typeof decoAdminRouteHandlers.PATCH).toBe("function");
    expect(typeof decoAdminRouteHandlers.DELETE).toBe("function");
  });
});
