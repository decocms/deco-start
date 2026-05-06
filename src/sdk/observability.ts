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
 * The granular modules (`@decocms/start/sdk/logger`, `.../otelAdapters`,
 * `.../sampler`) remain importable for advanced use cases (custom adapters,
 * tests, etc.) but the common path stays here.
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
} from "../middleware/observability";
// Composite helpers (for advanced multi-backend wiring)
export { createCompositeLogger, createCompositeMeter } from "./composite";
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
  setLogLevel,
} from "./logger";
// Worker-entry wrapper + adapter wiring
export { instrumentWorker, type OtelOptions } from "./otel";
// Adapters (for tests / custom wiring)
export {
  type AnalyticsEngineMeterAdapterOptions,
  createAnalyticsEngineMeterAdapter,
  createOtelLoggerAdapter,
  createOtelMeterAdapter,
  getRuntimeEnv,
  type OtelLoggerAdapterOptions,
  type OtelMeterAdapterOptions,
  setRuntimeEnv,
} from "./otelAdapters";
// Sampler
export {
  createUrlBasedHeadSampler,
  decodeSamplingConfig,
  type SamplingConfig,
  type SamplingRule,
  URLBasedSampler,
} from "./sampler";
