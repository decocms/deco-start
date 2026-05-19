/**
 * Single observability entry point for `@decocms/start` on Cloudflare Workers.
 *
 * `instrumentWorker(handler, options)` wraps a Worker handler with:
 *  - structured JSON logger (stdout → Cloudflare Workers Logs) — always
 *  - Workers Analytics Engine metrics — when `env.DECO_METRICS` binding exists
 *  - Bridges framework-internal `withTracing()` calls onto the global
 *    `@opentelemetry/api` tracer, stamping `deco.*` attributes on every span
 *    so they survive Cloudflare's platform-managed trace export
 *
 * **All export goes through Cloudflare.** Logs reach the dashboard via
 * `console.*` capture; traces reach the dashboard via CF auto-instrumentation
 * plus the global-tracer spans this module forwards. There is no in-Worker
 * OTLP exporter and no third-party destination — the CF dashboard is the
 * destination.
 *
 * Required `wrangler.jsonc` block (run `scripts/migrate-to-cf-observability.ts`
 * to inject this automatically):
 * ```jsonc
 * "observability": {
 *   "enabled": true,
 *   "logs":   { "enabled": true, "invocation_logs": true,
 *               "head_sampling_rate": 1,   "persist": true },
 *   "traces": { "enabled": true,
 *               "head_sampling_rate": 0.1, "persist": true }
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

import { trace } from "@opentelemetry/api";

import { configureMeter, configureTracer } from "../middleware/observability";
import { configureLogger, defaultLoggerAdapter, setLoggerAttributeFloor } from "./logger";
import { createAnalyticsEngineMeterAdapter } from "./otelAdapters";

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
   * Version of `@decocms/start` to advertise as `deco.runtime.version`
   * on every span and every log line. Falls back to a build-time constant;
   * override only for tests.
   */
  decoRuntimeVersion?: string;
  /** Optional `@decocms/apps` version, stamped as `deco.apps.version`. */
  decoAppsVersion?: string;
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
          if (error instanceof Error) span.recordException(error);
        },
        setAttribute: (k, v) => span.setAttribute(k, v),
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
      return handler.fetch(request, env, ctx);
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

  const floor: Record<string, string> = {
    "deco.runtime.version": decoRuntimeVersion,
    "deployment.environment": deploymentEnvironment,
  };
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

  // Logger: structured JSON to console.*, captured by CF observability.logs.
  configureLogger(defaultLoggerAdapter);

  // Meter: AE only. OTLP metrics path was removed in 5.0.0; will return
  // via the ClickHouse collector adapter when that lands.
  const aeBindingName = opts.analyticsEngineBindingName ?? "DECO_METRICS";
  const aeEnabled = opts.analyticsEngineEnabled !== false && Boolean(env[aeBindingName]);
  if (aeEnabled) {
    configureMeter(createAnalyticsEngineMeterAdapter({ bindingName: aeBindingName }));
  }

  booted = true;

  // Single boot-time breadcrumb so operators can confirm the wiring at a
  // glance from CF Logs without enabling debug.
  defaultLoggerAdapter.log("info", "observability booted", {
    service: serviceName,
    analyticsEngine: aeEnabled,
    runtimeVersion: decoRuntimeVersion,
    deploymentEnvironment,
  });
}

/**
 * Test-only: clear boot state so successive tests can re-boot
 * `instrumentWorker` with different options. Do not call from app code.
 */
export function _resetBootStateForTests(): void {
  booted = false;
  spanAttributeFloor = {};
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
