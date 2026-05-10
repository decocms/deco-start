import { describe, expect, it } from "vitest";
import { handleDecoAdminRoute } from "./adminRoute";

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
