import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAnalyticsEngineMeterAdapter,
  createOtelLoggerAdapter,
  createOtelMeterAdapter,
  setRuntimeEnv,
} from "./otelAdapters";
import { RequestContext } from "./requestContext";

describe("createOtelLoggerAdapter / createOtelMeterAdapter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns null when no endpoint is provided (no-op safe)", () => {
    expect(createOtelLoggerAdapter(null)).toBeNull();
    expect(createOtelLoggerAdapter({ endpoint: "" })).toBeNull();
    expect(createOtelMeterAdapter(null)).toBeNull();
  });

  it("constructs without throwing when an endpoint is provided", () => {
    // We don't want this test to actually open a network connection.
    // The exporters lazy-initialize their HTTP client and only POST on
    // batch flush, so simply constructing must not throw.
    const log = createOtelLoggerAdapter({
      endpoint: "https://otel.example.invalid",
      headers: { authorization: "test" },
      name: "test-svc",
    });
    expect(log).not.toBeNull();
    expect(typeof log!.log).toBe("function");

    const meter = createOtelMeterAdapter({
      endpoint: "https://otel.example.invalid",
      headers: { authorization: "test" },
      exportIntervalMillis: 60_000,
      name: "test-svc",
    });
    expect(meter).not.toBeNull();
    expect(typeof meter!.counterInc).toBe("function");
    expect(typeof meter!.histogramRecord).toBe("function");
  });

  it("logs without throwing for a variety of attribute shapes", () => {
    const log = createOtelLoggerAdapter({ endpoint: "https://otel.example.invalid" });
    expect(log).not.toBeNull();
    expect(() =>
      log!.log("info", "ok", {
        s: "x",
        n: 1,
        b: true,
        arr: [1, "two", true],
        nested: { a: 1, b: { c: "d" } },
        nullV: null,
        undef: undefined,
        fn: () => {},
        sym: Symbol("s") as unknown as string,
      }),
    ).not.toThrow();
  });
});

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

    meter.counterInc("http_requests_total", 1, { method: "GET", path: "/", status: 200 });
    meter.histogramRecord?.("http_request_duration_ms", 150, {
      method: "GET",
      path: "/",
      status: 200,
    });
    meter.gaugeSet?.("custom_gauge", 7, { region: "gru" });

    expect(writeDataPoint).toHaveBeenCalledTimes(3);

    // For HTTP request metrics, indexes[0] must be the path.
    expect(writeDataPoint.mock.calls[0]?.[0].indexes).toEqual(["/"]);
    expect(writeDataPoint.mock.calls[0]?.[0].doubles).toEqual([1]);
    expect(writeDataPoint.mock.calls[0]?.[0].blobs?.[0]).toBe("http_requests_total");

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
      // Use a known HTTP metric name so path is promoted to index[0].
      meter.counterInc("http_requests_total", 1, { path: "/x" });
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
