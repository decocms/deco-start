/**
 * Single observability entry point for `@decocms/start` on Cloudflare Workers.
 *
 * `instrumentWorker(handler, options)` wraps a Worker handler with:
 *  - structured JSON logger (stdout → Cloudflare Workers Logs) — always
 *  - Workers Analytics Engine metrics — when `env.DECO_METRICS` binding exists
 *  - OTLP/HTTP metrics exporter, direct POST to `deco-otel-ingest`
 *    `/v1/metrics` — when `env.DECO_OTEL_METRICS_ENDPOINT` is set. Buffered
 *    per-isolate, flushed via `ctx.waitUntil` at the end of every request.
 *    See `otelHttpMeter.ts` for the aggregation + flush model.
 *  - OTLP/HTTP error-log channel, direct POST to `deco-otel-ingest`
 *    `/v1/logs` — when `env.DECO_OTEL_LOGS_ENDPOINT` is set. Carries
 *    `logger.error(...)` calls at 100% capture (rate-limited per
 *    isolate) so head-sampled CF Destinations don't drop them.
 *    See `otelHttpErrorLog.ts` for the rate limiter + flush model.
 *  - Bridges framework-internal `withTracing()` calls onto the global
 *    `@opentelemetry/api` tracer, stamping `deco.*` attributes on every span
 *    so they survive Cloudflare's platform-managed trace export
 *
 * **Transport split.** Logs (info/warn) and traces flow through Cloudflare
 * Destinations (configured in `wrangler.jsonc`
 * `observability.{logs,traces}.destinations`). Metrics are NOT supported
 * by Destinations today (CF only exports OTLP for logs and traces), so the
 * framework POSTs them directly. Errors travel BOTH paths — via
 * `console.error` (sampled by CF Destinations) and direct POST (100%
 * capture). Same OTLP/HTTP JSON wire format, same ingest Worker.
 *
 * Required `wrangler.jsonc` block (run `scripts/migrate-to-cf-observability.ts`
 * to inject this automatically). Sampling defaults follow the fleet-scale cost
 * model documented in `docs/observability.md`:
 * ```jsonc
 * "observability": {
 *   "enabled": true,
 *   "logs":   { "enabled": true, "invocation_logs": true,
 *               "head_sampling_rate": 1,    "persist": true },
 *   "traces": { "enabled": true,
 *               "head_sampling_rate": 0.01, "persist": true }
 * },
 * "version_metadata":          { "binding": "CF_VERSION_METADATA" },
 * "analytics_engine_datasets": [{ "binding": "DECO_METRICS",
 *                                 "dataset":  "deco_metrics_my_site" }]
 * ```
 *
 * @example
 * ```ts
 * // worker-entry.ts
 * import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
 * import { instrumentWorker } from "@decocms/start/sdk/otel";
 *
 * const handler = createDecoWorkerEntry(serverEntry, options);
 * export default instrumentWorker(handler, { serviceName: "my-store" });
 * ```
 *
 * **Future ClickHouse path.** When a co-deployed OTel collector lands, an
 * exporter that pushes spans + logs + metrics to that collector will live in
 * `./otelAdapters/clickhouseCollector.ts` (today: documented stub that throws).
 * The `withTracing` / `recordRequestMetric` / `logger` instrumentation surface
 * does not change — only the transport layer wires up.
 */

import { SpanStatusCode, trace } from "@opentelemetry/api";
import { createCompositeLogger, createCompositeMeter } from "./composite";
import { configureLogger, defaultLoggerAdapter, setLoggerAttributeFloor } from "./logger";
import { configureMeter, configureTracer } from "./observability";
import { createAnalyticsEngineMeterAdapter } from "./otelAdapters";
import { createOtlpHttpErrorLogAdapter, type OtlpHttpErrorLog } from "./otelHttpErrorLog";
import { createOtlpHttpMeterAdapter, type OtlpHttpMeter } from "./otelHttpMeter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OtelOptions {
  /** Logical service name. Falls back to `env.DECO_SITE_NAME`, then "deco-site". */
  serviceName?: string;
  /** Env var name holding the AE binding. Defaults to `"DECO_METRICS"`. */
  analyticsEngineBindingName?: string;
  /** Set to `false` to disable AE even when the binding is present. */
  analyticsEngineEnabled?: boolean;
  /**
   * Env var name holding the OTLP/HTTP metrics endpoint. Defaults to
   * `"DECO_OTEL_METRICS_ENDPOINT"`. When the env var is set (and
   * `otlpMetricsEnabled !== false`), `instrumentWorker` wires a direct-POST
   * metrics exporter and flushes the buffer via `ctx.waitUntil` at the
   * end of every request. Cooldown + buffer cap are controlled by
   * `OtlpHttpMeterOptions`.
   */
  otlpMetricsEndpointEnvVar?: string;
  /** Set to `false` to disable the OTLP/HTTP metrics exporter explicitly. */
  otlpMetricsEnabled?: boolean;
  /**
   * Env var name holding the OTLP/HTTP logs endpoint used by the
   * direct-POST error-log channel. Defaults to `"DECO_OTEL_LOGS_ENDPOINT"`.
   * When set (and `otlpErrorLogsEnabled !== false`), `logger.error(...)`
   * dual-emits via `console.error` (CF Destinations path, head-sampled)
   * AND a direct POST to this endpoint (100% capture, rate-limited).
   */
  otlpErrorLogsEndpointEnvVar?: string;
  /** Set to `false` to disable the OTLP/HTTP error-log exporter explicitly. */
  otlpErrorLogsEnabled?: boolean;
  /**
   * Version of `@decocms/start` to advertise as `deco.runtime.version`
   * on every span and every log line. Falls back to a build-time constant;
   * override only for tests.
   */
  decoRuntimeVersion?: string;
  /** Optional `@decocms/apps` version, stamped as `deco.apps.version`. */
  decoAppsVersion?: string;
  /**
   * Test seam — replace the global `fetch` used by the OTLP metrics
   * exporter without touching the worker's outbound fetch.
   */
  otlpMetricsFetchImpl?: typeof fetch;
  /** Test seam — replace the global `fetch` used by the error-log exporter. */
  otlpErrorLogsFetchImpl?: typeof fetch;
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface WorkerHandler {
  fetch(
    request: Request,
    env: Record<string, unknown>,
    ctx: WorkerExecutionContext,
  ): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Boot state — guard against double-init across worker reloads
// ---------------------------------------------------------------------------

let booted = false;

/**
 * Module-level handle to the OTLP/HTTP metrics exporter — installed by
 * `bootObservability` when `DECO_OTEL_METRICS_ENDPOINT` is set on `env`.
 * `instrumentWorker` calls `flush()` via `ctx.waitUntil(...)` at the end
 * of every request so the buffer drains to roughly within one cooldown
 * window of real time before the isolate sleeps.
 */
let otlpMeter: OtlpHttpMeter | null = null;

/**
 * Module-level handle to the OTLP/HTTP error-log exporter — installed
 * by `bootObservability` when `DECO_OTEL_LOGS_ENDPOINT` is set on `env`.
 * Flushed alongside the metrics exporter via `ctx.waitUntil(...)`.
 */
let otlpErrorLog: OtlpHttpErrorLog | null = null;

/**
 * Per-span attribute floor — stamped on every span we create via
 * `configureTracer().startSpan(...)`. CF's trace export emits its own
 * resource attribute set (service.name=Worker name, faas.name,
 * cloudflare.script_version.id, etc.) so framework-level dimensions like
 * `deco.runtime.version` only survive when stamped per-span.
 *
 * Populated by `bootObservability` before any span is created. Stays an
 * empty object until then so early span creation is a no-op stamp.
 */
let spanAttributeFloor: Record<string, string> = {};

// ---------------------------------------------------------------------------
// instrumentWorker
// ---------------------------------------------------------------------------

/**
 * Wraps a Cloudflare Worker handler with the @decocms/start observability
 * stack:
 *  - structured JSON logger to console.* (CF captures via observability.logs)
 *  - AE meter (when `DECO_METRICS` binding present)
 *  - bridge from framework-internal `withTracing()` to `@opentelemetry/api`
 *    global tracer (CF observability.traces ingests via auto-instrumentation
 *    + the global-tracer hook)
 *
 * No external destinations, no OTLP transport. Forwarding to a future
 * OTel collector for ClickHouse will live behind a separate adapter
 * (see `./otelAdapters/clickhouseCollector.ts`).
 */
export function instrumentWorker(
  handler: WorkerHandler,
  options: OtelOptions | ((env: Record<string, unknown>) => OtelOptions) = {},
): WorkerHandler {
  // Bridge our pluggable TracerAdapter onto @opentelemetry/api. Framework
  // code calls `withTracing("name", fn, { attr: val })`; that delegates here
  // and lands on `trace.getTracer("@decocms/start").startSpan(...)`.
  //
  // CF Workers Tracing (when `observability.traces.enabled = true` in
  // wrangler) installs its own TracerProvider into the @opentelemetry/api
  // global, so these spans flow through to the CF dashboard. Without CF
  // tracing the global tracer is a no-op proxy and the spans simply drop
  // — same outcome as before, no error.
  configureTracer({
    startSpan: (name, attrs) => {
      const merged = { ...spanAttributeFloor, ...(attrs ?? {}) };
      const span = trace.getTracer("@decocms/start").startSpan(name, { attributes: merged });
      return {
        end: () => span.end(),
        setError: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof Error) span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message });
        },
        setAttribute: (k, v) => span.setAttribute(k, v),
        spanContext: () => {
          const ctx = span.spanContext();
          return {
            traceId: ctx.traceId,
            spanId: ctx.spanId,
            traceFlags: ctx.traceFlags,
          };
        },
      };
    },
  });

  return {
    async fetch(request, env, ctx) {
      const opts =
        typeof options === "function" ? options(env as Record<string, unknown>) : options;
      bootObservability(opts, env as Record<string, unknown>);
      // RequestContext.run + setRuntimeEnv(env) is handled inside
      // workerEntry.ts on the inner handler — instrumentWorker does
      // NOT re-wrap so we don't double-enter AsyncLocalStorage.
      try {
        return await handler.fetch(request, env, ctx);
      } finally {
        // Drain the OTLP metrics + error-log buffers via ctx.waitUntil
        // so neither POST blocks the response. Both exporters throttle
        // themselves per isolate — calling on every request is cheap;
        // the network only fires when the cooldown elapses or the
        // buffer fills.
        if (otlpMeter) {
          try {
            ctx.waitUntil(otlpMeter.flush());
          } catch {
            /* ctx.waitUntil throwing is benign — never block the response */
          }
        }
        if (otlpErrorLog) {
          try {
            ctx.waitUntil(otlpErrorLog.flush());
          } catch {
            /* swallow */
          }
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Boot — wires the loggers/meters once (per worker isolate)
// ---------------------------------------------------------------------------

function bootObservability(opts: OtelOptions, env: Record<string, unknown>): void {
  if (booted) return;

  const serviceName = opts.serviceName ?? (env.DECO_SITE_NAME as string | undefined) ?? "deco-site";
  const decoRuntimeVersion = opts.decoRuntimeVersion ?? DECO_RUNTIME_VERSION;
  const deploymentEnvironment = (env.DECO_ENV_NAME as string | undefined) ?? "production";
  const serviceVersion = (env.CF_VERSION_METADATA as { id?: string } | undefined)?.id;

  // service.name and service.version are OTel resource conventions. CF's
  // managed export already stamps service.name at the resource level (from
  // the Worker name in wrangler.jsonc) but framework-created spans don't
  // inherit resource attrs, so we stamp them per-span/per-log defensively.
  // service.version comes from the CF_VERSION_METADATA binding which is
  // unique per deployment — needed to correlate regressions with releases.
  const floor: Record<string, string> = {
    "service.name": serviceName,
    "deco.runtime.version": decoRuntimeVersion,
    "deployment.environment": deploymentEnvironment,
  };
  if (serviceVersion) floor["service.version"] = serviceVersion;
  if (opts.decoAppsVersion) floor["deco.apps.version"] = opts.decoAppsVersion;

  // Stamp on every span we create. CF-managed trace export emits its own
  // resource attribute set, so legacy resource attrs don't survive.
  // Stamping per-span preserves the dimensions dashboards / saved searches
  // filter on.
  spanAttributeFloor = floor;

  // Stamp on every log record. CF Workers Logs ships the JSON body
  // verbatim — without this floor, panels grouping logs by these
  // dimensions return empty. Caller-supplied `attrs` still win on
  // key collision (see logger.ts).
  setLoggerAttributeFloor(floor);

  // Logger — two paths composed:
  //
  //  - `defaultLoggerAdapter`: structured JSON to `console.*`. CF
  //    Workers Logs captures this and CF Destinations forwards a
  //    `logs.head_sampling_rate` fraction to `deco-otel-ingest/v1/logs`.
  //    Carries debug / info / warn / error.
  //  - `otlpErrorLog.adapter`: direct POST to `/v1/logs` for level=error
  //    only, rate-limited (default 100/min, burst 20), buffered, flushed
  //    via `ctx.waitUntil` at request end. Guarantees ≥99% error capture
  //    regardless of the CF Destinations sampling rate. See
  //    `otelHttpErrorLog.ts` for the aggregation + rate-limit details.
  //
  // The two paths land in the SAME `default.otel_logs` table, so the
  // ingestor's existing PII redaction applies uniformly and dashboards
  // need no changes. Records from the direct-POST path are
  // distinguishable from CF-Destinations records by `ScopeName =
  // "@decocms/start"` if needed (CF stamps its own scope).
  const otlpLogsEnvVar = opts.otlpErrorLogsEndpointEnvVar ?? "DECO_OTEL_LOGS_ENDPOINT";
  const otlpLogsEndpoint = (env[otlpLogsEnvVar] as string | undefined) ?? "";
  const otlpErrorLogsEnabled =
    opts.otlpErrorLogsEnabled !== false && otlpLogsEndpoint.length > 0;
  if (otlpErrorLogsEnabled) {
    otlpErrorLog = createOtlpHttpErrorLogAdapter({
      endpoint: otlpLogsEndpoint,
      resourceAttributes: floor,
      scopeVersion: decoRuntimeVersion,
      fetchImpl: opts.otlpErrorLogsFetchImpl,
      onError: (kind, err) => {
        // Don't recurse — use console.warn directly, not logger.warn.
        // The whole point of this adapter is to bypass the logger path
        // for high-fidelity error capture, so logging back into it
        // would be circular.
        try {
          console.warn(
            JSON.stringify({
              level: "warn",
              msg: "otlp error-log exporter",
              kind,
              error: err instanceof Error ? err.message : String(err),
              timestamp: new Date().toISOString(),
            }),
          );
        } catch {
          /* swallow */
        }
      },
    });
  } else {
    otlpErrorLog = null;
  }

  configureLogger(
    createCompositeLogger([defaultLoggerAdapter, otlpErrorLog ? otlpErrorLog.adapter : null]),
  );

  // Meter — fan out to two backends when both are configured:
  //
  //  - AE (binding `DECO_METRICS`): high-cardinality drill-down, queryable
  //    via the per-site dataset.
  //  - OTLP/HTTP (env `DECO_OTEL_METRICS_ENDPOINT`): SRE-grade rollups
  //    landed in ClickHouse `otel_metrics_{sum,gauge,histogram}` via the
  //    `deco-otel-ingest` Worker. Cumulative temporality, per-isolate
  //    buffer flushed by `ctx.waitUntil` in `instrumentWorker`.
  //
  // The two emitters are NOT redundant — AE keeps per-request per-path
  // dimensions; OTLP carries the same metric names at coarser cardinality
  // and survives outside the CF dashboard. Cost model in
  // `docs/observability.md` accounts for both.
  const aeBindingName = opts.analyticsEngineBindingName ?? "DECO_METRICS";
  const aeEnabled = opts.analyticsEngineEnabled !== false && Boolean(env[aeBindingName]);
  const aeAdapter = aeEnabled
    ? createAnalyticsEngineMeterAdapter({ bindingName: aeBindingName })
    : null;

  const otlpEnvVar = opts.otlpMetricsEndpointEnvVar ?? "DECO_OTEL_METRICS_ENDPOINT";
  const otlpEndpoint = (env[otlpEnvVar] as string | undefined) ?? "";
  const otlpEnabled = opts.otlpMetricsEnabled !== false && otlpEndpoint.length > 0;
  if (otlpEnabled) {
    otlpMeter = createOtlpHttpMeterAdapter({
      endpoint: otlpEndpoint,
      resourceAttributes: floor,
      scopeVersion: decoRuntimeVersion,
      fetchImpl: opts.otlpMetricsFetchImpl,
      onError: (kind, err) => {
        // Surface flush + overflow errors at warn so operators see them in
        // CF Logs without enabling debug. Stays JSON via the logger so
        // structured filters keep working.
        defaultLoggerAdapter.log("warn", "otlp metrics exporter", {
          kind,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    });
  } else {
    otlpMeter = null;
  }

  const composedMeter = createCompositeMeter([aeAdapter, otlpMeter]);
  // Composite meter is always installed — when both backends are absent the
  // composite becomes a 0-element no-op via createCompositeMeter's filter.
  configureMeter(composedMeter);

  booted = true;

  // Single boot-time breadcrumb so operators can confirm the wiring at a
  // glance from CF Logs without enabling debug.
  defaultLoggerAdapter.log("info", "observability booted", {
    service: serviceName,
    analyticsEngine: aeEnabled,
    otlpMetrics: otlpEnabled,
    otlpErrorLogs: otlpErrorLogsEnabled,
    runtimeVersion: decoRuntimeVersion,
    deploymentEnvironment,
    ...(serviceVersion ? { serviceVersion } : {}),
  });
}

/**
 * Test-only: clear boot state so successive tests can re-boot
 * `instrumentWorker` with different options. Do not call from app code.
 */
export function _resetBootStateForTests(): void {
  booted = false;
  spanAttributeFloor = {};
  otlpMeter = null;
  otlpErrorLog = null;
  setLoggerAttributeFloor({});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build-time @decocms/start version. Hand-bumped at release; we deliberately
 * avoid `import("../../package.json")` to keep the module side-effect-free
 * and JSON-import-quirk-free across the various build pipelines that
 * consume @decocms/start.
 *
 * Drift is acceptable — this attribute is for operator triage, not for
 * billing / SLOs.
 */
const DECO_RUNTIME_VERSION = "5.0.0";
