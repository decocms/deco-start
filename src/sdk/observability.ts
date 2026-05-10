/**
 * One-stop import for everything observability-related in `@decocms/start`.
 *
 * Consumers (sites, apps) should prefer importing from here so future
 * re-organisations don't ripple through every site:
 *
 * ```ts
 * import {
 *   instrumentWorker,
 *   logger,
 *   setLogLevel,
 *   withTracing,
 *   recordRequestMetric,
 *   recordCacheMetric,
 *   MetricNames,
 * } from "@decocms/start/sdk/observability";
 * ```
 *
 * The granular modules (`@decocms/start/sdk/logger`, `.../otelAdapters`)
 * remain importable for advanced use cases (custom adapters, tests, etc.)
 * but the common path stays here.
 *
 * **5.0.0 surface change.** The OTLP exporters (`createOtelLoggerAdapter`,
 * `createOtelMeterAdapter`), the flush registry (`flushOtelProviders`,
 * `registerOtelFlushHandler`), and the URL-based sampler
 * (`URLBasedSampler`, `decodeSamplingConfig`, `createUrlBasedHeadSampler`,
 * `SamplingConfig`, `SamplingRule`) were removed. They will be reintroduced
 * via `./otelAdapters/clickhouseCollector.ts` when the platform-side OTel
 * collector ships. The `instrumentWorker` / `withTracing` / `logger` /
 * `recordRequestMetric` / `recordCacheMetric` surface is unchanged — only
 * the transport layer was stripped.
 */

// Tracer / meter / request log primitives (re-exported from the middleware)
export {
  configureMeter,
  configureTracer,
  getActiveSpan,
  getMeter,
  getTracer,
  logRequest,
  type MeterAdapter,
  MetricNames,
  recordCacheMetric,
  recordRequestMetric,
  type Span,
  setSpanAttribute,
  type TracerAdapter,
  withTracing,
} from "../tanstack/middleware/observability";
// Composite helpers (for advanced multi-backend wiring — e.g. AE + future
// ClickHouse-collector meter, or default-console + future-collector logger)
export { createCompositeLogger, createCompositeMeter } from "../core/sdk/composite";
// Logger surface
export {
  configureLogger,
  defaultLoggerAdapter,
  getLoggerAdapter,
  getLogLevel,
  type Logger,
  type LoggerAdapter,
  type LogLevel,
  logger,
  type SerializedError,
  serializeError,
  setLoggerAttributeFloor,
  setLogLevel,
} from "../core/sdk/logger";
// Worker-entry wrapper + adapter wiring
export { instrumentWorker, type OtelOptions } from "../core/sdk/otel";
// AE meter adapter + runtime env helpers (for tests / custom wiring)
export {
  type AnalyticsEngineDataset,
  type AnalyticsEngineMeterAdapterOptions,
  createAnalyticsEngineMeterAdapter,
  getRuntimeEnv,
  setRuntimeEnv,
} from "../core/sdk/otelAdapters";
// ClickHouse collector adapter — stub today, real exporter when the
// collector lands. Re-exported from here so site code can import the
// future-target symbol via the canonical observability barrel.
export {
  type ClickhouseCollectorOptions,
  createClickhouseCollectorAdapter,
} from "../core/sdk/otelAdapters/clickhouseCollector";
