import { describe, expect, it, vi } from "vitest";
import { DEFAULT_INFLIGHT_TIMEOUT_MS, withInflightTimeout } from "./inflightTimeout";

describe("withInflightTimeout", () => {
  it("returns the underlying value when work settles in time", async () => {
    const result = await withInflightTimeout(Promise.resolve(42), "ok-case");
    expect(result).toBe(42);
  });

  it("propagates rejection when underlying work rejects in time", async () => {
    await expect(
      withInflightTimeout(Promise.reject(new Error("boom")), "reject-case"),
    ).rejects.toThrow("boom");
  });

  it("rejects with a timeout error when underlying work never settles", async () => {
    vi.useFakeTimers();
    try {
      const hung = new Promise<number>(() => {});
      const raced = withInflightTimeout(hung, "hung-case", 1_000);
      // Swallow the eventual rejection so the runner doesn't see it as unhandled
      raced.catch(() => {});

      await vi.advanceTimersByTimeAsync(1_500);
      await expect(raced).rejects.toThrow(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exports a sane default timeout", () => {
    expect(DEFAULT_INFLIGHT_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(DEFAULT_INFLIGHT_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
