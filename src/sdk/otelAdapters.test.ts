import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _getFlushHandlerCountForTests,
  _resetFlushHandlersForTests,
  createAnalyticsEngineMeterAdapter,
  createOtelLoggerAdapter,
  createOtelMeterAdapter,
  flushOtelProviders,
  registerOtelFlushHandler,
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
    // minSeverity:"debug" so the test exercises the actual emit path; the
    // default "warn" floor would short-circuit before the OTel emit runs
    // and the attribute-sanitization branch wouldn't be hit.
    const log = createOtelLoggerAdapter({
      endpoint: "https://otel.example.invalid",
      minSeverity: "debug",
    });
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

describe("createOtelLoggerAdapter — minSeverity floor", () => {
  // Every call to `createOtelLoggerAdapter` constructs its own local
  // `LoggerProvider`. The OTel global provider is set the first time
  // (`setGlobalLoggerProvider` is "first wins"), so spying on the global
  // doesn't observe later adapters' emits. Spying on the *prototype*
  // sidesteps that — every provider instance, local or global, returns
  // the same fake logger and we can count emits across all of them.
  let emitSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetFlushHandlersForTests();
    emitSpy = vi.fn();
    vi.spyOn(LoggerProvider.prototype, "getLogger").mockReturnValue({
      emit: emitSpy,
    } as unknown as ReturnType<LoggerProvider["getLogger"]>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetFlushHandlersForTests();
  });

  function makeAdapter(minSeverity?: "debug" | "info" | "warn" | "error") {
    const adapter = createOtelLoggerAdapter({
      endpoint: "https://otel.example.invalid",
      headers: { authorization: "test" },
      ...(minSeverity ? { minSeverity } : {}),
    });
    expect(adapter).not.toBeNull();
    return adapter!;
  }

  it("defaults to 'warn' — drops debug + info, keeps warn + error", () => {
    const adapter = makeAdapter(undefined);
    adapter.log("debug", "d");
    adapter.log("info", "i");
    adapter.log("warn", "w");
    adapter.log("error", "e");
    expect(emitSpy).toHaveBeenCalledTimes(2);
    expect(emitSpy.mock.calls[0]?.[0].severityText).toBe("WARN");
    expect(emitSpy.mock.calls[1]?.[0].severityText).toBe("ERROR");
  });

  it("explicit minSeverity='debug' lets every level through", () => {
    const adapter = makeAdapter("debug");
    adapter.log("debug", "d");
    adapter.log("info", "i");
    adapter.log("warn", "w");
    adapter.log("error", "e");
    expect(emitSpy).toHaveBeenCalledTimes(4);
  });

  it("explicit minSeverity='error' only forwards error", () => {
    const adapter = makeAdapter("error");
    adapter.log("debug", "d");
    adapter.log("info", "i");
    adapter.log("warn", "w");
    adapter.log("error", "e");
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy.mock.calls[0]?.[0].severityText).toBe("ERROR");
  });
});

describe("flushOtelProviders / registerOtelFlushHandler", () => {
  beforeEach(() => _resetFlushHandlersForTests());
  afterEach(() => {
    vi.restoreAllMocks();
    _resetFlushHandlersForTests();
  });

  it("resolves immediately when no handlers are registered", async () => {
    expect(_getFlushHandlerCountForTests()).toBe(0);
    await expect(flushOtelProviders()).resolves.toBeUndefined();
  });

  it("invokes every registered handler exactly once", async () => {
    const a = vi.fn(() => Promise.resolve());
    const b = vi.fn(() => Promise.resolve());
    registerOtelFlushHandler(a);
    registerOtelFlushHandler(b);
    expect(_getFlushHandlerCountForTests()).toBe(2);
    await flushOtelProviders();
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("does NOT reject when a handler throws — uses Promise.allSettled", async () => {
    const ok = vi.fn(() => Promise.resolve());
    const fail = vi.fn(() => Promise.reject(new Error("OTLP 503")));
    registerOtelFlushHandler(fail);
    registerOtelFlushHandler(ok);
    // Must resolve, not throw — flush failures are telemetry incidents,
    // not request incidents. This is the surface contract callers rely on.
    await expect(flushOtelProviders()).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledOnce();
  });

  it("createOtelLoggerAdapter registers exactly one flush handler", () => {
    const before = _getFlushHandlerCountForTests();
    const adapter = createOtelLoggerAdapter({
      endpoint: "https://otel.example.invalid",
    });
    expect(adapter).not.toBeNull();
    expect(_getFlushHandlerCountForTests()).toBe(before + 1);
  });

  it("createOtelMeterAdapter registers exactly one flush handler", () => {
    const before = _getFlushHandlerCountForTests();
    const meter = createOtelMeterAdapter({
      endpoint: "https://otel.example.invalid",
      exportIntervalMillis: 60_000,
    });
    expect(meter).not.toBeNull();
    expect(_getFlushHandlerCountForTests()).toBe(before + 1);
  });

  it("returning-null factories register no handlers", () => {
    expect(_getFlushHandlerCountForTests()).toBe(0);
    createOtelLoggerAdapter(null);
    createOtelLoggerAdapter({ endpoint: "" });
    createOtelMeterAdapter(null);
    expect(_getFlushHandlerCountForTests()).toBe(0);
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
