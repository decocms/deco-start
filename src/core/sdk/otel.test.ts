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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as observability from "../../tanstack/middleware/observability";
import * as composite from "./composite";
import * as logger from "./logger";
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
    expect(observability.MetricNames.HTTP_REQUEST_DURATION_MS).toBe("http_request_duration_ms");
    expect(observability.MetricNames.RESOLVE_DURATION_MS).toBe("resolve_duration_ms");
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
