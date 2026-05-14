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

  it("decoAdminRouteHandlers is the default-options instance", async () => {
    process.env.DECO_SITE = "my-site";
    const res = await decoAdminRouteHandlers.GET(new Request("http://t/_healthcheck"));
    expect(res.status).toBe(200);
    delete process.env.DECO_SITE;
  });
});
