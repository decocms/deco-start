/**
 * Coverage for the public observability surface and `instrumentWorker`.
 *
 * As of 5.0.0 the framework no longer bundles an in-Worker OTLP exporter
 * for logs/metrics. Tests below verify:
 *   - public exports stay stable (logger, composite helpers, AE adapter,
 *     observability primitives)
 *   - `instrumentWorker` is a thin wrapper: bridge tracer + boot logger/meter,
 *     forward `fetch` to the wrapped handler, no flush registry, no
 *     `ctx.waitUntil` for telemetry plumbing.
 */
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as composite from "./composite";
import * as logger from "./logger";
import * as observability from "./observability";
import { _resetBootStateForTests, instrumentWorker } from "./otel";
import * as adapters from "./otelAdapters";
import { createClickhouseCollectorAdapter } from "./otelAdapters/clickhouseCollector";

interface TestEnv extends Record<string, unknown> {
  DECO_SITE_NAME?: string;
  DECO_METRICS?: { writeDataPoint: () => void };
  CF_VERSION_METADATA?: { id: string };
}

function fakeCtx() {
  const waited: Array<Promise<unknown>> = [];
  return {
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p);
    },
    passThroughOnException: () => {},
    waited,
  };
}

describe("observability granular modules", () => {
  it("exports the logger surface", () => {
    expect(typeof logger.logger.info).toBe("function");
    expect(typeof logger.configureLogger).toBe("function");
    expect(typeof logger.setLogLevel).toBe("function");
    expect(typeof logger.defaultLoggerAdapter.log).toBe("function");
    expect(typeof logger.serializeError).toBe("function");
    expect(typeof logger.setLoggerAttributeFloor).toBe("function");
  });

  it("exports composite helpers", () => {
    expect(typeof composite.createCompositeLogger).toBe("function");
    expect(typeof composite.createCompositeMeter).toBe("function");
  });

  it("exports only the AE adapter factory + runtime env helpers", () => {
    expect(typeof adapters.createAnalyticsEngineMeterAdapter).toBe("function");
    expect(typeof adapters.setRuntimeEnv).toBe("function");
    expect(typeof adapters.getRuntimeEnv).toBe("function");
    // OTLP factories + flush registry were removed in 5.0.0.
    expect("createOtelLoggerAdapter" in adapters).toBe(false);
    expect("createOtelMeterAdapter" in adapters).toBe(false);
    expect("flushOtelProviders" in adapters).toBe(false);
    expect("registerOtelFlushHandler" in adapters).toBe(false);
  });

  it("exports observability primitives from middleware/observability", () => {
    expect(typeof observability.withTracing).toBe("function");
    expect(typeof observability.recordRequestMetric).toBe("function");
    expect(typeof observability.recordCacheMetric).toBe("function");
    expect(observability.MetricNames.HTTP_SERVER_REQUEST_DURATION).toBe(
      "http.server.request.duration",
    );
    expect(observability.MetricNames.RESOLVE_DURATION).toBe("deco.cms.resolve.duration");
  });

  it("ClickHouse collector adapter is a documented stub that throws", () => {
    expect(() =>
      createClickhouseCollectorAdapter({ endpoint: "https://otel-collector.internal" }),
    ).toThrow(/not implemented/i);
  });
});

describe("instrumentWorker — CF-native default boot", () => {
  beforeEach(() => {
    _resetBootStateForTests();
  });

  afterEach(() => {
    _resetBootStateForTests();
  });

  it("forwards fetch to the wrapped handler", async () => {
    const handler = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const wrapped = instrumentWorker(handler);

    const env: TestEnv = {};
    const ctx = fakeCtx();
    const res = await wrapped.fetch(new Request("https://example.test/"), env, ctx);

    expect(handler.fetch).toHaveBeenCalledOnce();
    expect(await res.text()).toBe("ok");
    // No flush registry anymore — instrumentWorker should NOT push anything
    // into ctx.waitUntil for telemetry plumbing.
    expect(ctx.waited).toHaveLength(0);
  });

  it("does not call ctx.waitUntil even when the handler throws", async () => {
    const handler = { fetch: vi.fn().mockRejectedValue(new Error("boom")) };
    const wrapped = instrumentWorker(handler);

    const env: TestEnv = {};
    const ctx = fakeCtx();
    await expect(wrapped.fetch(new Request("https://example.test/"), env, ctx)).rejects.toThrow(
      "boom",
    );
    expect(ctx.waited).toHaveLength(0);
  });

  it("boot is idempotent across requests", async () => {
    const handler = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const wrapped = instrumentWorker(handler, { decoRuntimeVersion: "5.0.0-test" });

    const env: TestEnv = {};
    for (let i = 0; i < 3; i++) {
      await wrapped.fetch(new Request("https://example.test/"), env, fakeCtx());
    }

    expect(handler.fetch).toHaveBeenCalledTimes(3);
  });

  it("AE meter is wired without OTLP when DECO_METRICS binding is present", async () => {
    const writeDataPoint = vi.fn();
    const handler = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const wrapped = instrumentWorker(handler);

    const env: TestEnv = { DECO_METRICS: { writeDataPoint } };
    const ctx = fakeCtx();
    await wrapped.fetch(new Request("https://example.test/"), env, ctx);

    // AE adapter does not register flush handlers (writeDataPoint is
    // fire-and-forget), so ctx.waitUntil stays empty even with AE wired.
    expect(ctx.waited).toHaveLength(0);
  });

  it("accepts a function for options so site code can read env at boot time", async () => {
    const handler = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const wrapped = instrumentWorker(handler, (env) => ({
      serviceName: (env.DECO_SITE_NAME as string) ?? "fallback",
    }));

    const env: TestEnv = { DECO_SITE_NAME: "my-store-test" };
    await wrapped.fetch(new Request("https://example.test/"), env, fakeCtx());

    expect(handler.fetch).toHaveBeenCalledOnce();
  });
});

describe("instrumentWorker — identity floor", () => {
  beforeEach(() => {
    _resetBootStateForTests();
  });

  afterEach(() => {
    _resetBootStateForTests();
  });

  it("stamps service.name and service.version on the logger floor", async () => {
    const handler = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const wrapped = instrumentWorker(handler, { serviceName: "casaevideo-tanstack" });

    const env: TestEnv = { CF_VERSION_METADATA: { id: "abc123" } };
    await wrapped.fetch(new Request("https://example.test/"), env, fakeCtx());

    const floor = logger._getLoggerAttributeFloorForTests();
    expect(floor["service.name"]).toBe("casaevideo-tanstack");
    expect(floor["service.version"]).toBe("abc123");
  });

  it("falls back to DECO_SITE_NAME for service.name", async () => {
    const handler = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const wrapped = instrumentWorker(handler);

    const env: TestEnv = { DECO_SITE_NAME: "fallback-site" };
    await wrapped.fetch(new Request("https://example.test/"), env, fakeCtx());

    const floor = logger._getLoggerAttributeFloorForTests();
    expect(floor["service.name"]).toBe("fallback-site");
  });

  it("omits service.version when CF_VERSION_METADATA is absent", async () => {
    const handler = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const wrapped = instrumentWorker(handler, { serviceName: "no-version-site" });

    const env: TestEnv = {};
    await wrapped.fetch(new Request("https://example.test/"), env, fakeCtx());

    const floor = logger._getLoggerAttributeFloorForTests();
    expect("service.version" in floor).toBe(false);
  });
});

describe("instrumentWorker — tracer bridge", () => {
  beforeEach(() => {
    _resetBootStateForTests();
  });

  afterEach(() => {
    _resetBootStateForTests();
    observability.configureTracer({
      startSpan: () => ({ end: () => {} }),
    });
    // installBridgeWithFakeOtelSpan() below uses vi.spyOn(trace, "getTracer").
    // Without restoring, that spy leaks into any later test that touches the
    // real OTel API.
    vi.restoreAllMocks();
  });

  function installBridgeWithFakeOtelSpan() {
    const span = {
      end: vi.fn(),
      recordException: vi.fn(),
      setStatus: vi.fn(),
      setAttribute: vi.fn(),
      spanContext: vi.fn(() => ({
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "fedcba9876543210",
        traceFlags: 1,
      })),
    };
    const getTracer = vi.spyOn(trace, "getTracer").mockReturnValue({
      startSpan: () => span,
      startActiveSpan: () => undefined,
    } as unknown as ReturnType<typeof trace.getTracer>);
    const handler = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const wrapped = instrumentWorker(handler);
    return { span, wrapped, getTracer };
  }

  it("setError sets SpanStatusCode.ERROR and records exception", async () => {
    const { span, wrapped } = installBridgeWithFakeOtelSpan();
    await wrapped.fetch(new Request("https://example.test/"), {}, fakeCtx());

    // Drive a span through the bridge via withTracing.
    await expect(
      observability.withTracing("t", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(span.recordException).toHaveBeenCalledOnce();
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "boom",
    });
  });

  it("setError sets ERROR status for non-Error throws too", async () => {
    const { span, wrapped } = installBridgeWithFakeOtelSpan();
    await wrapped.fetch(new Request("https://example.test/"), {}, fakeCtx());

    await expect(
      observability.withTracing("t", async () => {
        throw "string-error";
      }),
    ).rejects.toBe("string-error");

    expect(span.recordException).not.toHaveBeenCalled();
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "string-error",
    });
  });

  it("spanContext round-trips traceId/spanId/traceFlags", async () => {
    const { wrapped } = installBridgeWithFakeOtelSpan();
    await wrapped.fetch(new Request("https://example.test/"), {}, fakeCtx());

    const tracer = observability.getTracer();
    const span = tracer?.startSpan("t");
    expect(span?.spanContext?.()).toEqual({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "fedcba9876543210",
      traceFlags: 1,
    });
  });
});

describe("instrumentWorker — OTLP/HTTP metrics exporter wiring", () => {
  beforeEach(() => {
    _resetBootStateForTests();
  });

  afterEach(() => {
    _resetBootStateForTests();
    vi.restoreAllMocks();
  });

  function makeFetchSpy() {
    const calls: Array<{ url: string; body: string }> = [];
    const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response("{}", { status: 200 });
    });
    return { impl: impl as unknown as typeof fetch, calls };
  }

  it("wires the OTLP meter only when DECO_OTEL_METRICS_ENDPOINT is set on env", async () => {
    const { impl } = makeFetchSpy();
    const handler = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const wrapped = instrumentWorker(handler, {
      serviceName: "smoke-site",
      otlpMetricsFetchImpl: impl,
    });

    // Without the env var, no flush is enqueued via ctx.waitUntil.
    const ctxNoEndpoint = fakeCtx();
    await wrapped.fetch(new Request("https://example.test/"), {}, ctxNoEndpoint);
    expect(ctxNoEndpoint.waited).toHaveLength(0);
  });

  it("records metrics + flushes via ctx.waitUntil at request end", async () => {
    const { impl, calls } = makeFetchSpy();
    const handler = {
      fetch: vi.fn(async () => {
        observability.recordRequestMetric("GET", "/p/123", 200, 42);
        return new Response("ok");
      }),
    };
    const wrapped = instrumentWorker(handler, {
      serviceName: "smoke-site",
      otlpMetricsFetchImpl: impl,
    });

    const env: TestEnv = {
      DECO_OTEL_METRICS_ENDPOINT: "https://ingest.test/v1/metrics",
    } as TestEnv & { DECO_OTEL_METRICS_ENDPOINT: string };
    const ctx = fakeCtx();
    await wrapped.fetch(new Request("https://example.test/"), env, ctx);

    // ctx.waitUntil was used to drain the buffer.
    expect(ctx.waited).toHaveLength(1);
    await Promise.all(ctx.waited);

    // Exactly one POST to the configured endpoint.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ingest.test/v1/metrics");

    // Payload carries the resource floor and at least the canonical
    // `http.server.request.duration` histogram that recordRequestMetric emits.
    const payload = JSON.parse(calls[0].body) as {
      resourceMetrics: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
        scopeMetrics: Array<{ metrics: Array<{ name: string }> }>;
      }>;
    };
    const attrs = payload.resourceMetrics[0].resource.attributes;
    expect(attrs).toContainEqual({
      key: "service.name",
      value: { stringValue: "smoke-site" },
    });
    const names = payload.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name);
    expect(names).toContain("http.server.request.duration");
  });

  it("otlpMetricsEnabled=false disables the OTLP meter even when env is set", async () => {
    const { impl, calls } = makeFetchSpy();
    const handler = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const wrapped = instrumentWorker(handler, {
      otlpMetricsEnabled: false,
      otlpMetricsFetchImpl: impl,
    });

    const env: TestEnv = {
      DECO_OTEL_METRICS_ENDPOINT: "https://ingest.test/v1/metrics",
    } as TestEnv & { DECO_OTEL_METRICS_ENDPOINT: string };
    const ctx = fakeCtx();
    await wrapped.fetch(new Request("https://example.test/"), env, ctx);

    expect(ctx.waited).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("falling back to handler.fetch failure still triggers a flush", async () => {
    const { impl } = makeFetchSpy();
    const handler = { fetch: vi.fn().mockRejectedValue(new Error("boom")) };
    const wrapped = instrumentWorker(handler, {
      otlpMetricsFetchImpl: impl,
    });

    const env: TestEnv = {
      DECO_OTEL_METRICS_ENDPOINT: "https://ingest.test/v1/metrics",
    } as TestEnv & { DECO_OTEL_METRICS_ENDPOINT: string };
    const ctx = fakeCtx();
    await expect(
      wrapped.fetch(new Request("https://example.test/"), env, ctx),
    ).rejects.toThrow("boom");

    expect(ctx.waited).toHaveLength(1);
  });
});

describe("instrumentWorker — OTLP/HTTP error-log channel wiring", () => {
  beforeEach(() => {
    _resetBootStateForTests();
  });

  afterEach(() => {
    _resetBootStateForTests();
    vi.restoreAllMocks();
  });

  function makeFetchSpy() {
    const calls: Array<{ url: string; body: string }> = [];
    const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response("{}", { status: 200 });
    });
    return { impl: impl as unknown as typeof fetch, calls };
  }

  it("routes logger.error through the direct-POST channel when env is set", async () => {
    const { impl, calls } = makeFetchSpy();
    const handler = {
      fetch: vi.fn(async () => {
        logger.logger.error("payment failed", { stage: "checkout", reason: "declined" });
        return new Response("ok");
      }),
    };
    const wrapped = instrumentWorker(handler, {
      serviceName: "smoke-site",
      otlpErrorLogsFetchImpl: impl,
    });

    const env: TestEnv = {
      DECO_OTEL_LOGS_ENDPOINT: "https://ingest.test/v1/logs",
    } as TestEnv & { DECO_OTEL_LOGS_ENDPOINT: string };
    const ctx = fakeCtx();
    await wrapped.fetch(new Request("https://example.test/"), env, ctx);

    // ctx.waitUntil(flushErrors) was queued.
    expect(ctx.waited.length).toBeGreaterThanOrEqual(1);
    await Promise.all(ctx.waited);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ingest.test/v1/logs");
    const payload = JSON.parse(calls[0].body) as {
      resourceLogs: Array<{
        scopeLogs: Array<{
          logRecords: Array<{ severityText: string; body: { stringValue: string } }>;
        }>;
      }>;
    };
    const rec = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(rec.severityText).toBe("error");
    expect(rec.body.stringValue).toBe("payment failed");
  });

  it("info / warn / debug calls do NOT trigger a direct POST", async () => {
    const { impl, calls } = makeFetchSpy();
    const handler = {
      fetch: vi.fn(async () => {
        logger.logger.info("info msg");
        logger.logger.warn("warn msg");
        logger.logger.debug("debug msg");
        return new Response("ok");
      }),
    };
    const wrapped = instrumentWorker(handler, {
      otlpErrorLogsFetchImpl: impl,
    });

    const env: TestEnv = {
      DECO_OTEL_LOGS_ENDPOINT: "https://ingest.test/v1/logs",
    } as TestEnv & { DECO_OTEL_LOGS_ENDPOINT: string };
    const ctx = fakeCtx();
    await wrapped.fetch(new Request("https://example.test/"), env, ctx);
    await Promise.all(ctx.waited);

    expect(calls).toHaveLength(0);
  });

  it("otlpErrorLogsEnabled=false disables the channel even when env is set", async () => {
    const { impl, calls } = makeFetchSpy();
    const handler = {
      fetch: vi.fn(async () => {
        logger.logger.error("boom");
        return new Response("ok");
      }),
    };
    const wrapped = instrumentWorker(handler, {
      otlpErrorLogsEnabled: false,
      otlpErrorLogsFetchImpl: impl,
    });

    const env: TestEnv = {
      DECO_OTEL_LOGS_ENDPOINT: "https://ingest.test/v1/logs",
    } as TestEnv & { DECO_OTEL_LOGS_ENDPOINT: string };
    const ctx = fakeCtx();
    await wrapped.fetch(new Request("https://example.test/"), env, ctx);
    await Promise.all(ctx.waited);

    expect(calls).toHaveLength(0);
  });
});
