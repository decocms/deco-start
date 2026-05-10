import { describe, expect, it } from "vitest";
import { checkTierBoundaries } from "./check-tier-boundaries";

describe("checkTierBoundaries", () => {
  it("returns no violations on a clean dist/", async () => {
    // Assumes `bun run build` was run before tests.
    const result = await checkTierBoundaries({ distDir: "dist" });
    expect(result.violations).toEqual([]);
  });
});
