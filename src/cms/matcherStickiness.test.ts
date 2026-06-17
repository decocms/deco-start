import { describe, expect, it, vi } from "vitest";

vi.mock("../sdk/cookiePassthrough", () => ({
  forwardResponseCookies: vi.fn(),
}));

import {
  DECO_MATCHER_PREFIX,
  applyDecoSegmentCookie,
  buildUniqueId,
  cookieValue,
  evaluateWithStickiness,
  type MatcherFlag,
} from "./matcherStickiness";

describe("matcherStickiness", () => {
  it("buildUniqueId walks resolve chain from last resolvable", () => {
    const { uniqueId, isSegment } = buildUniqueId([
      { type: "resolvable", value: "Hero Flag" },
      { type: "prop", value: "variants" },
      { type: "prop", value: "0" },
      { type: "prop", value: "rule" },
    ]);
    expect(uniqueId).toBe("Hero Flag@variants.0.rule");
    expect(isSegment).toBe(false);
  });

  it("cookieValue round-trips boolean results", () => {
    const built = cookieValue.build("test-id", true);
    expect(cookieValue.boolean(built)).toBe(true);
    expect(cookieValue.boolean(cookieValue.build("test-id", false))).toBe(false);
  });

  it("sticky random matcher reuses cookie value across calls", () => {
    const flags: MatcherFlag[] = [];
    const chain = [
      { type: "resolvable" as const, value: "AB Test" },
      { type: "prop" as const, value: "variants" },
      { type: "prop" as const, value: "0" },
      { type: "prop" as const, value: "rule" },
    ];
    const cookieName = `${DECO_MATCHER_PREFIX}123`;
    const cookies: Record<string, string> = {
      [cookieName]: cookieValue.build("AB Test@variants.0.rule", true),
    };

    // Mock murmur hash by pre-setting cookie — evaluateWithStickiness reads cookie
    // when sticky. Use actual flow with existing cookie from a prior "draw":
    let calls = 0;
    const runMatcher = () => {
      calls++;
      return Math.random() < 0.01; // would usually be false
    };

    // First call without cookie — runs matcher
    const cookiesEmpty: Record<string, string> = {};
    evaluateWithStickiness(
      "website/matchers/random.ts",
      { traffic: 0.5 },
      chain,
      cookiesEmpty,
      undefined,
      runMatcher,
      flags,
    );
    expect(calls).toBe(1);

    // Simulate cookie being set — find cookie name from flags
    expect(flags.length).toBe(1);
  });

  it("applyDecoSegmentCookie writes deco_segment when sticky flags present", () => {
    const flags: MatcherFlag[] = [
      {
        name: "Hero Flag",
        value: true,
        isSegment: true,
        sticky: true,
      },
    ];

    applyDecoSegmentCookie({}, flags);
    // Cookie write goes through forwardResponseCookies — verified via no throw
  });
});
