/**
 * Coverage for `instrumentWorker` and the public observability surface.
 *
 * As of 4.4.0 the framework no longer wraps with `@microlabs/otel-cf-workers`
 * (`cloudflare:workers`-only), so importing `./otel` and `./observability`
 * works in plain vitest. Earlier versions of this file documented that
 * constraint — it's gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as observability from "../middleware/observability";
import * as composite from "./composite";
import * as logger from "./logger";
import { _resetBootStateForTests, instrumentWorker } from "./otel";
import * as adapters from "./otelAdapters";
import * as sampler from "./sampler";

interface TestEnv extends Record<string, unknown> {
  DECO_SITE_NAME?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
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
  });

  it("exports composite helpers", () => {
    expect(typeof composite.createCompositeLogger).toBe("function");
    expect(typeof composite.createCompositeMeter).toBe("function");
  });

  it("exports OTel adapter factories", () => {
    expect(typeof adapters.createOtelLoggerAdapter).toBe("function");
    expect(typeof adapters.createOtelMeterAdapter).toBe("function");
    expect(typeof adapters.createAnalyticsEngineMeterAdapter).toBe("function");
    expect(typeof adapters.setRuntimeEnv).toBe("function");
    expect(typeof adapters.getRuntimeEnv).toBe("function");
    expect(typeof adapters.flushOtelProviders).toBe("function");
    expect(typeof adapters.registerOtelFlushHandler).toBe("function");
  });

  it("exports sampler API", () => {
    expect(typeof sampler.URLBasedSampler).toBe("function");
    expect(typeof sampler.decodeSamplingConfig).toBe("function");
    expect(typeof sampler.createUrlBasedHeadSampler).toBe("function");
  });

  it("exports observability primitives from middleware/observability", () => {
    expect(typeof observability.withTracing).toBe("function");
    expect(typeof observability.recordRequestMetric).toBe("function");
    expect(typeof observability.recordCacheMetric).toBe("function");
    expect(observability.MetricNames.HTTP_REQUEST_DURATION_MS).toBe("http_request_duration_ms");
    expect(observability.MetricNames.RESOLVE_DURATION_MS).toBe("resolve_duration_ms");
  });
});

describe("instrumentWorker — CF-native default boot", () => {
  beforeEach(() => {
    _resetBootStateForTests();
    adapters._resetFlushHandlersForTests();
  });

  afterEach(() => {
    _resetBootStateForTests();
    adapters._resetFlushHandlersForTests();
  });

  it("default mode (no opts, only OTLP endpoint set): wires meter flush only, NOT logger flush", async () => {
    const handler = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const wrapped = instrumentWorker(handler);

    const env: TestEnv = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://in-otel.hyperdx.io",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer test",
    };
    const ctx = fakeCtx();
    await wrapped.fetch(new Request("https://example.test/"), env, ctx);

    // Exactly one provider registered: the OTLP meter. The OTLP logger is
    // gated behind `enableAppSideOtlpLogs` opt-in and CF handles log export.
    expect(adapters._getFlushHandlerCountForTests()).toBe(1);
    expect(handler.fetch).toHaveBeenCalledOnce();
    expect(ctx.waited).toHaveLength(1);
  });

  it("default mode without OTLP endpoint: no flush handlers registered (pure CF-native)", async () => {
    const handler = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const wrapped = instrumentWorker(handler);

    const env: TestEnv = {};
    const ctx = fakeCtx();
    await wrapped.fetch(new Request("https://example.test/"), env, ctx);

    expect(adapters._getFlushHandlerCountForTests()).toBe(0);
    // ctx.waitUntil still called with the no-op flush, but the handler array is empty.
    expect(ctx.waited).toHaveLength(1);
  });

  it("opt-in mode (enableAppSideOtlpLogs: true): wires BOTH logger and meter flush", async () => {
    const handler = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const wrapped = instrumentWorker(handler, { enableAppSideOtlpLogs: true });

    const env: TestEnv = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://in-otel.hyperdx.io",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer test",
    };
    const ctx = fakeCtx();
    await wrapped.fetch(new Request("https://example.test/"), env, ctx);

    expect(adapters._getFlushHandlerCountForTests()).toBe(2);
  });

  it("flush is awaited via ctx.waitUntil even when fetch throws", async () => {
    const handler = { fetch: vi.fn().mockRejectedValue(new Error("boom")) };
    const wrapped = instrumentWorker(handler);

    const env: TestEnv = {};
    const ctx = fakeCtx();
    await expect(wrapped.fetch(new Request("https://example.test/"), env, ctx)).rejects.toThrow(
      "boom",
    );

    expect(ctx.waited).toHaveLength(1);
  });

  it("boot is idempotent across requests: flush handler count stable", async () => {
    const handler = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const wrapped = instrumentWorker(handler);

    const env: TestEnv = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://in-otel.hyperdx.io",
    };

    for (let i = 0; i < 3; i++) {
      await wrapped.fetch(new Request("https://example.test/"), env, fakeCtx());
    }

    expect(adapters._getFlushHandlerCountForTests()).toBe(1);
    expect(handler.fetch).toHaveBeenCalledTimes(3);
  });

  it("AE meter is wired without OTLP when DECO_METRICS binding is present", async () => {
    const writeDataPoint = vi.fn();
    const handler = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const wrapped = instrumentWorker(handler);

    const env: TestEnv = { DECO_METRICS: { writeDataPoint } };
    const ctx = fakeCtx();
    await wrapped.fetch(new Request("https://example.test/"), env, ctx);

    // AE adapter doesn't register a flush (writeDataPoint is fire-and-forget),
    // so no providers should be registered when only AE is wired.
    expect(adapters._getFlushHandlerCountForTests()).toBe(0);
  });
});
