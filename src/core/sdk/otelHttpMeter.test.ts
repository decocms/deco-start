import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOtlpHttpMeterAdapter } from "./otelHttpMeter";

interface OtlpPayload {
  resourceMetrics: Array<{
    resource: {
      attributes: Array<{ key: string; value: { stringValue: string } }>;
    };
    scopeMetrics: Array<{
      scope: { name: string; version: string };
      metrics: Array<{
        name: string;
        sum?: {
          aggregationTemporality: number;
          isMonotonic: boolean;
          dataPoints: Array<{
            attributes: Array<{ key: string; value: Record<string, unknown> }>;
            startTimeUnixNano: string;
            timeUnixNano: string;
            asDouble: number;
          }>;
        };
        gauge?: {
          dataPoints: Array<{
            attributes: Array<{ key: string; value: Record<string, unknown> }>;
            timeUnixNano: string;
            asDouble: number;
          }>;
        };
        histogram?: {
          aggregationTemporality: number;
          dataPoints: Array<{
            attributes: Array<{ key: string; value: Record<string, unknown> }>;
            startTimeUnixNano: string;
            timeUnixNano: string;
            count: string;
            sum: number;
            min: number;
            max: number;
            bucketCounts: string[];
            explicitBounds: number[];
          }>;
        };
      }>;
    }>;
  }>;
}

function captureFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function buildAdapter(
  overrides: {
    fetchImpl?: typeof fetch;
    minFlushIntervalMs?: number;
    maxBufferDatapoints?: number;
    nowMs?: () => number;
    onError?: (kind: "flush" | "overflow" | "kind-mismatch", err: unknown) => void;
    histogramBounds?: number[];
  } = {},
) {
  return createOtlpHttpMeterAdapter({
    endpoint: "https://ingest.test/v1/metrics",
    resourceAttributes: {
      "service.name": "smoke-site",
      "service.version": "abc123",
    },
    scopeVersion: "5.0.0-test",
    fetchImpl: overrides.fetchImpl,
    minFlushIntervalMs: overrides.minFlushIntervalMs ?? 0,
    maxBufferDatapoints: overrides.maxBufferDatapoints,
    nowMs: overrides.nowMs,
    onError: overrides.onError,
    histogramBounds: overrides.histogramBounds,
  });
}

describe("createOtlpHttpMeterAdapter — buffer + flush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T16:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("counterInc accumulates per attr-key and exports cumulative sum", async () => {
    const { impl, calls } = captureFetch();
    const meter = buildAdapter({ fetchImpl: impl });

    meter.counterInc("deco.http.requests", 1, { method: "GET", status: "2xx" });
    meter.counterInc("deco.http.requests", 1, { method: "GET", status: "2xx" });
    meter.counterInc("deco.http.requests", 1, { method: "POST", status: "5xx" });

    await meter.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ingest.test/v1/metrics");
    const payload = JSON.parse(calls[0].init!.body as string) as OtlpPayload;
    const m = payload.resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(m.name).toBe("deco.http.requests");
    expect(m.sum?.isMonotonic).toBe(true);
    expect(m.sum?.aggregationTemporality).toBe(2);
    expect(m.sum?.dataPoints).toHaveLength(2);

    // Sort for stable assertion order.
    const points = [...(m.sum?.dataPoints ?? [])].sort((a, b) =>
      JSON.stringify(a.attributes).localeCompare(JSON.stringify(b.attributes)),
    );
    expect(points[0].asDouble).toBe(2); // GET+2xx
    expect(points[1].asDouble).toBe(1); // POST+5xx
  });

  it("histogramRecord assigns buckets correctly and reports count/sum/min/max", async () => {
    const { impl, calls } = captureFetch();
    const meter = buildAdapter({
      fetchImpl: impl,
      histogramBounds: [5, 10, 25, 50, 75, 100, 250, 500, 1000],
    });

    // 12 samples across the [5,10,25,50,75,100,250,500,1000] bounds, with
    // the `value <= bound[i]` lower-bucket convention used by the exporter.
    // Distribution:
    //   bucket 0 (≤5):     []
    //   bucket 1 (5..10]:  [8.4]
    //   bucket 2 (10..25]: [12,14,20]
    //   bucket 3 (25..50]: [30,35,38,48]
    //   bucket 4 (50..75]: [60,70]
    //   bucket 5 (75..100]:[80,87.2]
    //   bucket 6+:         []
    const samples = [8.4, 12, 14, 20, 30, 35, 38, 48, 60, 70, 80, 87.2];
    expect(samples).toHaveLength(12);
    const sum = samples.reduce((a, b) => a + b, 0);
    for (const v of samples) {
      meter.histogramRecord("outbound_request_duration_ms", v, { provider: "vtex" });
    }

    await meter.flush();

    const payload = JSON.parse(calls[0].init!.body as string) as OtlpPayload;
    const m = payload.resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(m.histogram?.aggregationTemporality).toBe(2);
    expect(m.histogram?.dataPoints).toHaveLength(1);
    const dp = m.histogram!.dataPoints[0];
    expect(dp.count).toBe("12");
    expect(dp.sum).toBeCloseTo(sum, 5);
    expect(dp.min).toBe(8.4);
    expect(dp.max).toBe(87.2);
    expect(dp.bucketCounts).toEqual(["0", "1", "3", "4", "2", "2", "0", "0", "0", "0"]);
    expect(dp.explicitBounds).toEqual([5, 10, 25, 50, 75, 100, 250, 500, 1000]);
  });

  it("gaugeSet keeps last write per attr-key", async () => {
    const { impl, calls } = captureFetch();
    const meter = buildAdapter({ fetchImpl: impl });

    meter.gaugeSet("deco.metrics.buffer_size", 3);
    meter.gaugeSet("deco.metrics.buffer_size", 7);

    await meter.flush();

    const payload = JSON.parse(calls[0].init!.body as string) as OtlpPayload;
    const m = payload.resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(m.gauge?.dataPoints).toHaveLength(1);
    expect(m.gauge?.dataPoints[0].asDouble).toBe(7);
  });

  it("resource attributes are stamped on every payload", async () => {
    const { impl, calls } = captureFetch();
    const meter = buildAdapter({ fetchImpl: impl });
    meter.counterInc("x", 1);
    await meter.flush();

    const payload = JSON.parse(calls[0].init!.body as string) as OtlpPayload;
    const attrs = payload.resourceMetrics[0].resource.attributes;
    expect(attrs).toContainEqual({
      key: "service.name",
      value: { stringValue: "smoke-site" },
    });
    expect(attrs).toContainEqual({
      key: "service.version",
      value: { stringValue: "abc123" },
    });
  });

  it("never throws when fetch rejects — surfaces via onError", async () => {
    const onError = vi.fn();
    const failing: typeof fetch = vi.fn(() =>
      Promise.reject(new Error("network unreachable")),
    ) as unknown as typeof fetch;
    const meter = buildAdapter({ fetchImpl: failing, onError });

    meter.counterInc("x", 1);
    await expect(meter.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith("flush", expect.any(Error));
  });

  it("non-200 HTTP response surfaces via onError but does not throw", async () => {
    const onError = vi.fn();
    const non200: typeof fetch = vi.fn(async () =>
      new Response("oops", { status: 500 }),
    ) as unknown as typeof fetch;
    const meter = buildAdapter({ fetchImpl: non200, onError });
    meter.counterInc("x", 1);
    await meter.flush();
    expect(onError).toHaveBeenCalledWith("flush", expect.any(Error));
  });

  it("registering a metric name as two different kinds drops the second + onError", () => {
    const onError = vi.fn();
    const meter = buildAdapter({ onError });

    meter.counterInc("conflict", 1);
    meter.gaugeSet?.("conflict", 7);

    expect(onError).toHaveBeenCalledWith("kind-mismatch", expect.any(Error));
    expect(meter.pendingDatapointCount()).toBe(1);
  });

  it("cooldown gates flushes; cooldown is bypassed once buffer reaches the cap", async () => {
    let mockNow = 1_000_000;
    const { impl, calls } = captureFetch();
    const meter = buildAdapter({
      fetchImpl: impl,
      minFlushIntervalMs: 5000,
      maxBufferDatapoints: 3,
      nowMs: () => mockNow,
    });

    // 1st flush at t=0 — buffer has 1 entry, cooldown bypass via lastFlush=0
    meter.counterInc("a", 1, { k: "1" });
    await meter.flush();
    expect(calls).toHaveLength(1);

    // 2nd flush at t=2s — cooldown not elapsed AND buffer below cap → no-op
    mockNow += 2000;
    meter.counterInc("a", 1, { k: "2" });
    await meter.flush();
    expect(calls).toHaveLength(1);

    // 3rd flush at t=2.5s — still under cooldown but buffer at cap (3) → flush
    mockNow += 500;
    meter.counterInc("a", 1, { k: "3" });
    expect(meter.pendingDatapointCount()).toBe(3);
    await meter.flush();
    expect(calls).toHaveLength(2);
  });

  it("overflow drops new attribute-keys when buffer is at cap (existing keys still update)", () => {
    const onError = vi.fn();
    const meter = buildAdapter({ maxBufferDatapoints: 2, onError });

    meter.counterInc("a", 1, { k: "1" });
    meter.counterInc("a", 1, { k: "2" });
    expect(meter.pendingDatapointCount()).toBe(2);

    meter.counterInc("a", 1, { k: "3" });
    expect(onError).toHaveBeenCalledWith("overflow", expect.any(Error));
    expect(meter.pendingDatapointCount()).toBe(2);

    // Existing key still updates (no new datapoint, just bumps the existing value).
    meter.counterInc("a", 5, { k: "1" });
    expect(meter.pendingDatapointCount()).toBe(2);
  });

  it("concurrent flushes share a single in-flight POST", async () => {
    let releaseFetch: ((res: Response) => void) | undefined;
    const slow: typeof fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = resolve;
        }),
    ) as unknown as typeof fetch;
    const meter = buildAdapter({ fetchImpl: slow });

    meter.counterInc("x", 1);
    const a = meter.flush();
    const b = meter.flush();
    expect(slow).toHaveBeenCalledTimes(1);
    releaseFetch?.(new Response("{}", { status: 200 }));
    await Promise.all([a, b]);
    expect(slow).toHaveBeenCalledTimes(1);
  });
});
