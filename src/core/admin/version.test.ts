import { describe, expect, it } from "vitest";
import { ADMIN_COMPAT_VERSION } from "./version";

describe("ADMIN_COMPAT_VERSION", () => {
  it("is a non-empty semver string", () => {
    expect(ADMIN_COMPAT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is pinned to the deco-cx/deco 1.177.x compatibility range", () => {
    // This pin must NOT track @decocms/start's own version. Admin compares
    // against deco-cx/deco's range, so changing the major/minor here is a
    // breaking change for admin compatibility — bump deliberately.
    expect(ADMIN_COMPAT_VERSION.startsWith("1.177.")).toBe(true);
  });
});
