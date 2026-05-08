import { ROOT_CONTEXT, SpanKind } from "@opentelemetry/api";
import {
  AlwaysOnSampler,
  ParentBasedSampler,
  SamplingDecision,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import {
  createUrlBasedHeadSampler,
  DEFAULT_SAMPLE_RATIO,
  decodeSamplingConfig,
  URLBasedSampler,
} from "./sampler";

// Two trace IDs at opposite ends of the TraceIdRatioBased accumulator.
// `accumulate(traceId)` xors the trace ID in 8-hex-char chunks; threshold at
// ratio R is `floor(R * 0xffffffff)`. See
// `@opentelemetry/sdk-trace-base/src/sampler/TraceIdRatioBasedSampler`.
//
//   LOW:  0x00000000 ^ 0x00000000 ^ 0xffffffff ^ 0xffffffff = 0
//         → 0 < threshold for any ratio > 0 → SAMPLED at any ratio > 0
//   HIGH: 0xffffffff ^ 0x00000000 ^ 0x00000000 ^ 0x00000000 = 0xffffffff
//         → never below threshold for ratio < 1.0 → DROPPED at any ratio < 1
const LOW_TRACE_ID = "0000000000000000ffffffffffffffff";
const HIGH_TRACE_ID = "ffffffff000000000000000000000000";

function decide(sampler: URLBasedSampler, path: string, traceId = LOW_TRACE_ID) {
  return sampler.shouldSample(
    ROOT_CONTEXT,
    traceId,
    "span-name",
    SpanKind.SERVER,
    { "url.path": path },
    [],
  );
}

describe("URLBasedSampler", () => {
  it("exposes 0.1 as the framework-wide default sample ratio", () => {
    expect(DEFAULT_SAMPLE_RATIO).toBe(0.1);
  });

  it("defaults to DEFAULT_SAMPLE_RATIO (0.1) when config omits `default`", () => {
    const s = new URLBasedSampler();
    // LOW_TRACE_ID accumulates to 0 — sampled at any ratio > 0, including 0.1.
    expect(decide(s, "/anything").decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    // HIGH_TRACE_ID accumulates to ~uint32 max — dropped at 0.1, would be
    // kept only at ratio ~= 1. This is the assertion that catches an
    // accidental revert to the old `?? 1.0` fallback.
    expect(decide(s, "/anything", HIGH_TRACE_ID).decision).toBe(SamplingDecision.NOT_RECORD);
  });

  it("explicit `default: 1` opts in to AlwaysOn (records every trace)", () => {
    const s = new URLBasedSampler({ default: 1 });
    expect(decide(s, "/anything", HIGH_TRACE_ID).decision).toBe(
      SamplingDecision.RECORD_AND_SAMPLED,
    );
  });

  it("falls back to provided default ratio when no rule matches", () => {
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
    const result = s.shouldSample(ROOT_CONTEXT, LOW_TRACE_ID, "noop", SpanKind.INTERNAL, {}, []);
    expect(result.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it("supports url.path, http.target, and http.url", () => {
    const s = new URLBasedSampler({
      default: 0.0,
      rules: [{ pattern: "^/wanted", ratio: 1.0 }],
    });
    const ok = (attrs: Record<string, string>) =>
      s.shouldSample(ROOT_CONTEXT, LOW_TRACE_ID, "n", SpanKind.SERVER, attrs, []);

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

  it("applies DEFAULT_SAMPLE_RATIO when config is null", () => {
    const sampler = createUrlBasedHeadSampler(null);
    // High-accumulating trace ID is dropped at 0.1 — proves the ParentBased
    // wrapper inherits the URLBasedSampler default and isn't accidentally
    // forcing AlwaysOn.
    const result = sampler.shouldSample(
      ROOT_CONTEXT,
      HIGH_TRACE_ID,
      "n",
      SpanKind.SERVER,
      { "url.path": "/" },
      [],
    );
    expect(result.decision).toBe(SamplingDecision.NOT_RECORD);
  });
});

describe("regression: AlwaysOnSampler still works", () => {
  it("guards against accidental import-rename breakage", () => {
    // If sdk-trace-base ever renames AlwaysOnSampler we want a loud failure.
    const s = new AlwaysOnSampler();
    expect(s.shouldSample().decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });
});
