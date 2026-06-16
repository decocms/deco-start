/**
 * Phase 3 (D-12) coverage for the direct-POST OTLP trace exporter.
 * Mirrors the test style of `otelHttpMeter.test.ts` — fake fetch,
 * deterministic clock, deterministic IDs via injected accessors.
 */
import { describe, expect, it, vi } from "vitest";
import type { Span } from "../middleware/observability";
import {
  createOtlpHttpTracerAdapter,
  newSpanId,
  newTraceId,
  parseTraceparent,
  shouldSampleTrace,
  type TraceContext,
} from "./otelHttpTracer";

// ---------------------------------------------------------------------------
// Helpers — capture fetch & emulate active-span propagation
// ---------------------------------------------------------------------------

function captureFetch(): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; payload: Record<string, unknown> }>;
} {
  const calls: Array<{ url: string; payload: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body as string | undefined;
    calls.push({ url, payload: body ? JSON.parse(body) : {} });
    return new Response("", { status: 200 });
  };
  return { fetchImpl, calls };
}

/**
 * Build a minimal active-span scope helper. Tests can push a parent
 * span before calling `startSpan`, simulating what `withTracing` does
 * via ALS.
 */
function activeSpanStack(): {
  push(span: Span): void;
  pop(): void;
  get(): Span | null;
} {
  const stack: Span[] = [];
  return {
    push(span) {
      stack.push(span);
    },
    pop() {
      stack.pop();
    },
    get() {
      return stack[stack.length - 1] ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// parseTraceparent
// ---------------------------------------------------------------------------

describe("parseTraceparent (D-12)", () => {
  it("parses a well-formed sampled header", () => {
    const ctx = parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    expect(ctx).toEqual({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      parentSpanId: "b7ad6b7169203331",
      sampled: true,
      remoteParent: true,
    });
  });

  it("parses a well-formed unsampled header", () => {
    const ctx = parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00");
    expect(ctx?.sampled).toBe(false);
  });

  it("returns null on null / undefined / empty string", () => {
    expect(parseTraceparent(null)).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent("")).toBeNull();
  });

  it("rejects unknown versions", () => {
    expect(parseTraceparent("01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")).toBeNull();
  });

  it("rejects the well-known all-zero IDs (per W3C §3.2.2)", () => {
    expect(
      parseTraceparent("00-00000000000000000000000000000000-b7ad6b7169203331-01"),
    ).toBeNull();
    expect(
      parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01"),
    ).toBeNull();
  });

  it("rejects malformed lengths and non-hex characters", () => {
    expect(parseTraceparent("00-tooshort-b7ad6b7169203331-01")).toBeNull();
    expect(parseTraceparent("00-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-b7ad6b7169203331-01")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// shouldSampleTrace — consistency + boundary cases
// ---------------------------------------------------------------------------

describe("shouldSampleTrace (D-12)", () => {
  it("returns true for rate >= 1 (always sample)", () => {
    expect(shouldSampleTrace("0".repeat(31) + "1", 1)).toBe(true);
    expect(shouldSampleTrace("0".repeat(31) + "1", 5)).toBe(true);
    expect(shouldSampleTrace("0".repeat(31) + "1", Infinity)).toBe(true);
  });

  it("returns false for rate <= 0 (never sample)", () => {
    expect(shouldSampleTrace("0".repeat(31) + "1", 0)).toBe(false);
    expect(shouldSampleTrace("0".repeat(31) + "1", -1)).toBe(false);
  });

  it("decisions are stable per trace ID (called twice → same answer)", () => {
    const traceId = newTraceId();
    const first = shouldSampleTrace(traceId, 0.1);
    const second = shouldSampleTrace(traceId, 0.1);
    expect(first).toBe(second);
  });

  it("approximates the configured rate over a large sample", () => {
    // 5000 random trace IDs sampled at 10% should land within ±3% of
    // the target — bounded statistical noise, deterministic seed not
    // required because `Math.random` flakes here would already
    // indicate a broken hash.
    const trials = 5000;
    let kept = 0;
    for (let i = 0; i < trials; i++) {
      if (shouldSampleTrace(newTraceId(), 0.1)) kept++;
    }
    const observed = kept / trials;
    expect(observed).toBeGreaterThan(0.07);
    expect(observed).toBeLessThan(0.13);
  });
});

// ---------------------------------------------------------------------------
// ID generation — shape only (entropy depends on crypto.getRandomValues)
// ---------------------------------------------------------------------------

describe("newTraceId / newSpanId (D-12)", () => {
  it("returns 32-hex-char trace IDs and 16-hex-char span IDs", () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });
  it("does not repeat over 100 calls", () => {
    const set = new Set<string>();
    for (let i = 0; i < 100; i++) set.add(newTraceId());
    expect(set.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Adapter — startSpan / end / flush
// ---------------------------------------------------------------------------

describe("createOtlpHttpTracerAdapter (D-12)", () => {
  it("buffers a root span and POSTs OTLP payload on flush", async () => {
    const { fetchImpl, calls } = captureFetch();
    const stack = activeSpanStack();
    let clock = 100;

    const tracer = createOtlpHttpTracerAdapter({
      endpoint: "https://collector.example/v1/traces",
      resourceAttributes: { "service.name": "test-site" },
      headSamplingRate: 1,
      minFlushIntervalMs: 0,
      fetchImpl,
      nowMs: () => clock,
      getActiveSpanForParent: () => stack.get(),
    });

    const span = tracer.startSpan("deco.http.request", { "http.method": "GET" });
    clock = 250;
    span.setAttribute?.("http.status_code", 200);
    span.end();

    expect(tracer.pendingSpanCount()).toBe(1);
    await tracer.flush();
    expect(tracer.pendingSpanCount()).toBe(0);
    expect(calls).toHaveLength(1);

    const resourceSpans = (calls[0].payload as { resourceSpans: unknown[] }).resourceSpans as Array<{
      resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
      scopeSpans: Array<{
        spans: Array<{
          name: string;
          traceId: string;
          spanId: string;
          parentSpanId: string;
          startTimeUnixNano: string;
          endTimeUnixNano: string;
          attributes: Array<{ key: string; value: unknown }>;
          status: { code: number };
        }>;
      }>;
    }>;
    const rs = resourceSpans[0];
    expect(rs.resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "test-site" },
    });
    const spans = rs.scopeSpans[0].spans;
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("deco.http.request");
    expect(spans[0].traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spans[0].spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(spans[0].parentSpanId).toBe("");
    // 200 status_code → status.code = OK (1)
    expect(spans[0].status.code).toBe(1);
  });

  it("inherits trace ID from the active parent span", async () => {
    const { fetchImpl, calls } = captureFetch();
    const stack = activeSpanStack();
    const tracer = createOtlpHttpTracerAdapter({
      endpoint: "https://collector.example/v1/traces",
      resourceAttributes: {},
      headSamplingRate: 1,
      minFlushIntervalMs: 0,
      fetchImpl,
      getActiveSpanForParent: () => stack.get(),
    });

    const parent = tracer.startSpan("deco.http.request");
    stack.push(parent);
    const child = tracer.startSpan("deco.cache.lookup");
    stack.pop();

    const parentCtx = parent.spanContext?.();
    const childCtx = child.spanContext?.();
    expect(childCtx?.traceId).toBe(parentCtx?.traceId);
    expect(childCtx?.spanId).not.toBe(parentCtx?.spanId);

    child.end();
    parent.end();
    await tracer.flush();

    const payload = calls[0].payload as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{
      name: string;
      parentSpanId: string;
      spanId: string;
    }> }> }> };
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    const childRow = spans.find((s) => s.name === "deco.cache.lookup");
    const parentRow = spans.find((s) => s.name === "deco.http.request");
    expect(childRow?.parentSpanId).toBe(parentRow?.spanId);
  });

  it("honors an inbound W3C traceparent for root spans", async () => {
    const { fetchImpl } = captureFetch();
    const stack = activeSpanStack();
    const remote: TraceContext = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      parentSpanId: "b7ad6b7169203331",
      sampled: true,
      remoteParent: true,
    };
    const tracer = createOtlpHttpTracerAdapter({
      endpoint: "https://collector.example/v1/traces",
      resourceAttributes: {},
      headSamplingRate: 0, // would normally drop everything
      minFlushIntervalMs: 0,
      fetchImpl,
      getActiveSpanForParent: () => stack.get(),
      getRequestTraceContext: () => remote,
    });

    const root = tracer.startSpan("deco.http.request");
    const ctx = root.spanContext?.();
    expect(ctx?.traceId).toBe(remote.traceId);
    // parentSpanId from the remote should appear on the OTLP record
    root.end();

    // Even at samplingRate=0, the remote `sampled=true` overrides and
    // keeps this span.
    expect(tracer.pendingSpanCount()).toBe(1);
  });

  it("drops spans deterministically when samplingRate=0 and no remote sample bit", async () => {
    const stack = activeSpanStack();
    const tracer = createOtlpHttpTracerAdapter({
      endpoint: "https://collector.example/v1/traces",
      resourceAttributes: {},
      headSamplingRate: 0,
      minFlushIntervalMs: 0,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      getActiveSpanForParent: () => stack.get(),
    });
    const span = tracer.startSpan("deco.http.request");
    span.end();
    expect(tracer.pendingSpanCount()).toBe(0);
  });

  it("captures setError as an OTLP exception event", async () => {
    const { fetchImpl, calls } = captureFetch();
    const stack = activeSpanStack();
    const tracer = createOtlpHttpTracerAdapter({
      endpoint: "https://collector.example/v1/traces",
      resourceAttributes: {},
      headSamplingRate: 1,
      minFlushIntervalMs: 0,
      fetchImpl,
      getActiveSpanForParent: () => stack.get(),
    });
    const span = tracer.startSpan("deco.cache.lookup");
    span.setError?.(new TypeError("boom"));
    span.end();
    await tracer.flush();

    const payload = calls[0].payload as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{
      status: { code: number; message?: string };
      events: Array<{ name: string; attributes: Array<{ key: string }> }>;
      attributes: Array<{ key: string; value: { stringValue: string } }>;
    }> }> }> };
    const span0 = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span0.status.code).toBe(2);
    expect(span0.status.message).toBe("boom");
    expect(span0.events[0].name).toBe("exception");
    expect(span0.attributes.find((a) => a.key === "exception.type")?.value.stringValue).toBe(
      "TypeError",
    );
  });

  it("setAttribute http.status_code >= 400 promotes span to ERROR", async () => {
    const { fetchImpl, calls } = captureFetch();
    const stack = activeSpanStack();
    const tracer = createOtlpHttpTracerAdapter({
      endpoint: "https://collector.example/v1/traces",
      resourceAttributes: {},
      headSamplingRate: 1,
      minFlushIntervalMs: 0,
      fetchImpl,
      getActiveSpanForParent: () => stack.get(),
    });

    for (const status of [400, 429, 500, 503]) {
      const span = tracer.startSpan("vtex.catalog.search");
      span.setAttribute?.("http.status_code", status);
      span.end();
    }
    await tracer.flush();

    const spans = (calls[0].payload as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ status: { code: number; message: string } }> }> }> })
      .resourceSpans[0].scopeSpans[0].spans;
    for (const span of spans) {
      // ERROR = 2
      expect(span.status.code).toBe(2);
      expect(span.status.message).toMatch(/^HTTP (400|429|500|503)$/);
    }
  });

  it("setAttribute http.status_code < 400 does not overwrite an existing ERROR status", async () => {
    const { fetchImpl, calls } = captureFetch();
    const stack = activeSpanStack();
    const tracer = createOtlpHttpTracerAdapter({
      endpoint: "https://collector.example/v1/traces",
      resourceAttributes: {},
      headSamplingRate: 1,
      minFlushIntervalMs: 0,
      fetchImpl,
      getActiveSpanForParent: () => stack.get(),
    });

    const span = tracer.startSpan("deco.cache.lookup");
    span.setError?.(new Error("internal failure"));
    // A 200 attribute set afterwards should not clear the ERROR status
    span.setAttribute?.("http.status_code", 200);
    span.end();
    await tracer.flush();

    const span0 = (calls[0].payload as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ status: { code: number } }> }> }> })
      .resourceSpans[0].scopeSpans[0].spans[0];
    expect(span0.status.code).toBe(2);
  });

  it("flush is a no-op when the buffer is empty", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const stack = activeSpanStack();
    const tracer = createOtlpHttpTracerAdapter({
      endpoint: "https://collector.example/v1/traces",
      resourceAttributes: {},
      headSamplingRate: 1,
      minFlushIntervalMs: 0,
      fetchImpl,
      getActiveSpanForParent: () => stack.get(),
    });
    await tracer.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("respects the cooldown — second flush within window is skipped", async () => {
    const { fetchImpl, calls } = captureFetch();
    const stack = activeSpanStack();
    // Use wall-clock-realistic values: `lastFlushAt` starts at 0, so the
    // first flush's `elapsed` needs to exceed `minFlushIntervalMs` to
    // get through. That's always true in production where `now() =
    // Date.now() ~= 1.7e12`; we model that by starting the fake clock
    // at the same scale.
    let clock = 1_000_000_000_000;
    const tracer = createOtlpHttpTracerAdapter({
      endpoint: "https://collector.example/v1/traces",
      resourceAttributes: {},
      headSamplingRate: 1,
      minFlushIntervalMs: 5000,
      fetchImpl,
      nowMs: () => clock,
      getActiveSpanForParent: () => stack.get(),
    });
    const a = tracer.startSpan("a");
    a.end();
    clock += 100;
    await tracer.flush();
    expect(calls).toHaveLength(1);

    const b = tracer.startSpan("b");
    b.end();
    clock += 100; // 200ms after first flush — still within 5s cooldown
    await tracer.flush();
    expect(calls).toHaveLength(1); // still one — cooldown blocked it
    expect(tracer.pendingSpanCount()).toBe(1);

    clock += 10_000; // past cooldown
    await tracer.flush();
    expect(calls).toHaveLength(2);
  });

  it("calls onError when the buffer overflows", async () => {
    const stack = activeSpanStack();
    const onError = vi.fn();
    const tracer = createOtlpHttpTracerAdapter({
      endpoint: "https://collector.example/v1/traces",
      resourceAttributes: {},
      headSamplingRate: 1,
      minFlushIntervalMs: 0,
      maxBufferSpans: 2,
      fetchImpl: (async () => new Response("", { status: 200 })) as typeof fetch,
      getActiveSpanForParent: () => stack.get(),
      onError,
    });
    for (let i = 0; i < 5; i++) {
      const s = tracer.startSpan(`s${i}`);
      s.end();
    }
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0][0]).toBe("overflow");
  });

  it("calls onError on flush failure (non-2xx)", async () => {
    const stack = activeSpanStack();
    const onError = vi.fn();
    const fetchImpl: typeof fetch = async () => new Response("server explosion", { status: 503 });
    const tracer = createOtlpHttpTracerAdapter({
      endpoint: "https://collector.example/v1/traces",
      resourceAttributes: {},
      headSamplingRate: 1,
      minFlushIntervalMs: 0,
      fetchImpl,
      getActiveSpanForParent: () => stack.get(),
      onError,
    });
    const s = tracer.startSpan("x");
    s.end();
    await tracer.flush();
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0][0]).toBe("flush");
  });
});
