/**
 * Coverage for `createAnalyticsEngineMeterAdapter` and the
 * `setRuntimeEnv` / `getRuntimeEnv` helpers.
 *
 * As of 5.0.0 this file no longer covers `createOtelLoggerAdapter` /
 * `createOtelMeterAdapter` / `flushOtelProviders` — those exporters were
 * removed when the framework converged on Cloudflare-native log + trace
 * capture. AE remains the in-Worker metrics path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnalyticsEngineMeterAdapter, setRuntimeEnv } from "./otelAdapters";
import { RequestContext } from "./requestContext";

describe("createAnalyticsEngineMeterAdapter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("no-ops when binding is missing (does not throw)", () => {
    const meter = createAnalyticsEngineMeterAdapter({ bindingName: "MISSING" });
    expect(() => meter.counterInc("foo", 1)).not.toThrow();
    expect(() => meter.gaugeSet?.("bar", 5)).not.toThrow();
    expect(() => meter.histogramRecord?.("baz", 100)).not.toThrow();
  });

  it("writes one data point per call to the resolved binding", () => {
    const writeDataPoint = vi.fn();
    const binding = { writeDataPoint };

    const meter = createAnalyticsEngineMeterAdapter({ binding });

    meter.counterInc("deco.cache.hits", 1, { profile: "product" });
    meter.histogramRecord?.("http.server.request.duration", 150, {
      method: "GET",
      path: "/",
      status: 200,
    });
    meter.gaugeSet?.("custom_gauge", 7, { region: "gru" });

    expect(writeDataPoint).toHaveBeenCalledTimes(3);

    // Non-HTTP counter falls back to the metric name as the index.
    expect(writeDataPoint.mock.calls[0]?.[0].indexes).toEqual(["deco.cache.hits"]);
    expect(writeDataPoint.mock.calls[0]?.[0].doubles).toEqual([1]);
    expect(writeDataPoint.mock.calls[0]?.[0].blobs?.[0]).toBe("deco.cache.hits");

    // For canonical HTTP server histogram, indexes[0] must be the path.
    expect(writeDataPoint.mock.calls[1]?.[0].indexes).toEqual(["/"]);
    expect(writeDataPoint.mock.calls[1]?.[0].doubles).toEqual([150]);

    // Non-HTTP metrics fall back to the metric name as the index.
    expect(writeDataPoint.mock.calls[2]?.[0].indexes).toEqual(["custom_gauge"]);
    expect(writeDataPoint.mock.calls[2]?.[0].doubles).toEqual([7]);
  });

  it("resolves binding via RequestContext when not provided directly", () => {
    const writeDataPoint = vi.fn();
    const env = { DECO_METRICS: { writeDataPoint } };

    RequestContext.run(new Request("https://x.example/"), () => {
      setRuntimeEnv(env);
      const meter = createAnalyticsEngineMeterAdapter();
      // Canonical HTTP server histogram → path is promoted to index[0].
      meter.histogramRecord?.("http.server.request.duration", 1, { path: "/x" });
      expect(writeDataPoint).toHaveBeenCalledOnce();
      expect(writeDataPoint.mock.calls[0]?.[0].indexes).toEqual(["/x"]);
    });
  });

  it("never throws when binding throws", () => {
    const binding = {
      writeDataPoint: () => {
        throw new Error("AE down");
      },
    };
    const meter = createAnalyticsEngineMeterAdapter({ binding });
    expect(() => meter.counterInc("x", 1)).not.toThrow();
  });

  it("orders blob columns deterministically by sorted label keys", () => {
    const writeDataPoint = vi.fn();
    const binding = { writeDataPoint };
    const meter = createAnalyticsEngineMeterAdapter({ binding });

    meter.counterInc("metric", 1, { z: "last", a: "first", m: "mid" });

    const blobs = writeDataPoint.mock.calls[0]?.[0].blobs as string[];
    // blobs[0] is metric name; remaining must follow sorted label-key order: a, m, z
    expect(blobs).toEqual(["metric", "first", "mid", "last"]);
  });
});
