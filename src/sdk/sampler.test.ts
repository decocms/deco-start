import { ROOT_CONTEXT, SpanKind } from "@opentelemetry/api";
import {
  AlwaysOnSampler,
  ParentBasedSampler,
  SamplingDecision,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { createUrlBasedHeadSampler, decodeSamplingConfig, URLBasedSampler } from "./sampler";

const TRACE_ID = "0000000000000000ffffffffffffffff";

function decide(sampler: URLBasedSampler, path: string) {
  return sampler.shouldSample(
    ROOT_CONTEXT,
    TRACE_ID,
    "span-name",
    SpanKind.SERVER,
    { "url.path": path },
    [],
  );
}

describe("URLBasedSampler", () => {
  it("falls back to default ratio when no rule matches", () => {
    const s = new URLBasedSampler({ default: 1.0 });
    expect(decide(s, "/anything").decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it("first matching rule wins", () => {
    const s = new URLBasedSampler({
      default: 1.0,
      rules: [
        { pattern: "^/api/health", ratio: 0.0 },
        { pattern: "^/api/", ratio: 1.0 },
      ],
    });
    expect(decide(s, "/api/health").decision).toBe(SamplingDecision.NOT_RECORD);
    expect(decide(s, "/api/orders").decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it("falls back to default when no path attribute is present", () => {
    const s = new URLBasedSampler({ default: 1.0 });
    const result = s.shouldSample(ROOT_CONTEXT, TRACE_ID, "noop", SpanKind.INTERNAL, {}, []);
    expect(result.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it("supports url.path, http.target, and http.url", () => {
    const s = new URLBasedSampler({
      default: 0.0,
      rules: [{ pattern: "^/wanted", ratio: 1.0 }],
    });
    const ok = (attrs: Record<string, string>) =>
      s.shouldSample(ROOT_CONTEXT, TRACE_ID, "n", SpanKind.SERVER, attrs, []);

    expect(ok({ "url.path": "/wanted/x" }).decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(ok({ "http.target": "/wanted/y" }).decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(ok({ "http.url": "https://h.example/wanted/z?q=1" }).decision).toBe(
      SamplingDecision.RECORD_AND_SAMPLED,
    );
  });
});

describe("decodeSamplingConfig", () => {
  it("returns null on missing input", () => {
    expect(decodeSamplingConfig(undefined)).toBeNull();
    expect(decodeSamplingConfig("")).toBeNull();
  });

  it("decodes valid base64 JSON", () => {
    const cfg = { default: 0.5, rules: [{ pattern: "^/x", ratio: 1.0 }] };
    const enc = btoa(JSON.stringify(cfg));
    const decoded = decodeSamplingConfig(enc);
    expect(decoded).toEqual(cfg);
  });

  it("drops invalid rules but keeps the rest", () => {
    const enc = btoa(
      JSON.stringify({
        default: 0.1,
        rules: [
          { pattern: "^/ok", ratio: 1.0 },
          { pattern: "^[", ratio: 1.0 }, // invalid regex
          { pattern: "^/yes", ratio: 0.5 },
          { pattern: 7, ratio: 0.5 }, // wrong type
        ],
      }),
    );
    const decoded = decodeSamplingConfig(enc);
    expect(decoded?.rules).toEqual([
      { pattern: "^/ok", ratio: 1.0 },
      { pattern: "^/yes", ratio: 0.5 },
    ]);
  });

  it("returns null for non-JSON input", () => {
    expect(decodeSamplingConfig("not-base64-not-json!!")).toBeNull();
  });
});

describe("createUrlBasedHeadSampler", () => {
  it("wraps the URL-based sampler in ParentBasedSampler", () => {
    const sampler = createUrlBasedHeadSampler(null);
    expect(sampler).toBeInstanceOf(ParentBasedSampler);
  });

  it("applies the default-ratio = 1.0 when config is null", () => {
    // Smoke test only — sampler internals are validated above.
    const sampler = createUrlBasedHeadSampler(null);
    const result = sampler.shouldSample(
      ROOT_CONTEXT,
      TRACE_ID,
      "n",
      SpanKind.SERVER,
      { "url.path": "/" },
      [],
    );
    expect(result.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });
});

describe("regression: AlwaysOnSampler still works", () => {
  it("guards against accidental import-rename breakage", () => {
    // If sdk-trace-base ever renames AlwaysOnSampler we want a loud failure.
    const s = new AlwaysOnSampler();
    expect(s.shouldSample().decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });
});
