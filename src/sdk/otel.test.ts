/**
 * NOTE: full `instrumentWorker(...)` integration tests aren't feasible in
 * plain vitest because `@microlabs/otel-cf-workers` imports `cloudflare:workers`,
 * which only exists in the Workers runtime.
 *
 * The wiring is validated end-to-end on the lebiscuit canary (Section 2 of
 * the otel-hyperdx-parity plan): hit the deployed preview, confirm log
 * lines via `wrangler tail`, traces via the HyperDX UI, and AE data points
 * via `wrangler analytics-engine sql`. If we ever migrate the framework
 * test suite to `@cloudflare/vitest-pool-workers`, restore the in-process
 * smoke test here.
 *
 * Until then this file just guards the public API shape of the granular
 * modules so refactors that break the export surface fail loudly in CI.
 * (We deliberately don't import `./observability` here — it transitively
 * pulls in `@microlabs/otel-cf-workers` and therefore `cloudflare:workers`.)
 */
import { describe, expect, it } from "vitest";
import * as observability from "../middleware/observability";
import * as composite from "./composite";
import * as logger from "./logger";
import * as adapters from "./otelAdapters";
import * as sampler from "./sampler";

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
