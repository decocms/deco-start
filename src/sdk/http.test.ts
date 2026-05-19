import { describe, expect, it } from "vitest";
import { HttpError, STATUS_CODE, UserAgent } from "./http";

describe("STATUS_CODE", () => {
  it("exposes common codes with the IANA-canonical names", () => {
    expect(STATUS_CODE.OK).toBe(200);
    expect(STATUS_CODE.MovedPermanently).toBe(301);
    expect(STATUS_CODE.NotFound).toBe(404);
    expect(STATUS_CODE.TooManyRequests).toBe(429);
    expect(STATUS_CODE.InternalServerError).toBe(500);
  });

  it("is readonly at the type level", () => {
    // @ts-expect-error — assigning into the const map should not type-check.
    STATUS_CODE.OK = 999;
    // Even though the assignment is allowed at runtime (frozen-by-convention),
    // we just want the type to flag it. The value is whatever JS allows.
    expect(typeof STATUS_CODE.OK).toBe("number");
  });
});

describe("UserAgent", () => {
  it("accepts a string and exposes it via toString", () => {
    const ua = new UserAgent("Mozilla/5.0 (test)");
    expect(ua.toString()).toBe("Mozilla/5.0 (test)");
  });

  it("treats null as an empty UA string", () => {
    const ua = new UserAgent(null);
    expect(ua.toString()).toBe("");
  });

  it("exposes empty browser/os/cpu/device/engine accessors", () => {
    const ua = new UserAgent("anything");
    expect(ua.browser).toEqual({});
    expect(ua.os).toEqual({});
    expect(ua.cpu).toEqual({});
    expect(ua.device).toEqual({});
    expect(ua.engine).toEqual({});
  });
});

describe("HttpError", () => {
  it("captures status and message", () => {
    const err = new HttpError(404, "Missing");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("HttpError");
    expect(err.status).toBe(404);
    expect(err.message).toBe("Missing");
  });

  it("defaults the message from the status when not provided", () => {
    const err = new HttpError(503);
    expect(err.message).toBe("HTTP 503");
  });

  it("preserves an optional body payload for downstream handling", () => {
    const body = { code: "rate_limited" };
    const err = new HttpError(429, "Too Many Requests", body);
    expect(err.body).toEqual(body);
  });

  it("supports `instanceof` discrimination", () => {
    const err = new HttpError(304);
    function isNotModified(e: unknown): e is HttpError {
      return e instanceof HttpError && e.status === 304;
    }
    expect(isNotModified(err)).toBe(true);
    expect(isNotModified(new Error("nope"))).toBe(false);
  });
});
