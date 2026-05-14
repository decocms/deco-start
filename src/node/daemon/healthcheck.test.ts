import { describe, expect, it } from "vitest";
import { ADMIN_COMPAT_VERSION } from "../../core/admin/version";
import { handleDecoHealthcheck } from "./healthcheck";

describe("handleDecoHealthcheck", () => {
  it("returns 200 with the ADMIN_COMPAT_VERSION body", async () => {
    const res = handleDecoHealthcheck();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ADMIN_COMPAT_VERSION);
  });

  it("emits text/plain", () => {
    expect(handleDecoHealthcheck().headers.get("Content-Type")).toBe("text/plain");
  });

  it("emits the CORS headers admin.deco.cx expects", () => {
    const res = handleDecoHealthcheck();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
  });
});
