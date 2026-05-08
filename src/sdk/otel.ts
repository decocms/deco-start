/**
 * Single observability entry point for `@decocms/start` on Cloudflare Workers.
 *
 * `instrumentWorker(handler, options)` wraps a Worker handler with:
 *  - structured JSON logger (stdout → Cloudflare Workers Logs) — always
 *  - Workers Analytics Engine metrics — when `env.DECO_METRICS` binding exists
 *  - OTLP/HTTP metrics exporter (HyperDX) — when `OTEL_EXPORTER_OTLP_ENDPOINT`
 *    is set (CF doesn't support OTLP metrics export yet, so this stays app-side)
 *  - Per-request `ctx.waitUntil(forceFlush)` for any registered OTel batch
 *    processors so log/metric batches don't die with the isolate
 *  - Bridges framework-internal `withTracing()` calls onto the global
 *    `@opentelemetry/api` tracer, stamping `deco.*` attributes on every span
 *    so they survive Cloudflare's platform-managed trace export
 *
 * **Logs and traces export to HyperDX is now handled by Cloudflare** via the
 * `observability.{logs,traces}.destinations` block in `wrangler.jsonc`. CF
 * captures `console.*` output and `@opentelemetry/api` global tracer spans
 * out-of-band and ships them OTLP-encoded to whatever destination is
 * configured. This eliminates the in-Worker exporter SDK, the per-request
 * subrequest cost of pushing OTLP, and the entire class of bug PR #153 fixed
 * (batch processors that never flush before isolate recycling).
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
 * Companion `wrangler.jsonc` block (run `scripts/migrate-to-cf-observability.ts`
 * to inject this automatically):
 * ```jsonc
 * "observability": {
 *   "logs":   { "enabled": true, "destinations": ["hyperdx-logs"],
 *               "head_sampling_rate": 1.0, "persist": false },
 *   "traces": { "enabled": true, "destinations": ["hyperdx-traces"],
 *               "head_sampling_rate": 0.1, "persist": false }
 * },
 * "version_metadata":          { "binding": "CF_VERSION_METADATA" },
 * "analytics_engine_datasets": [{ "binding": "DECO_METRICS",
 *                                 "dataset":  "deco_metrics_my_site" }]
 * ```
 *
 * **Back-compat seam.** Sites that need to keep app-side OTLP log export
 * (custom destination not covered by CF, custom batching, etc.) can opt back
 * in with `enableAppSideOtlpLogs: true` and the existing `OTEL_EXPORTER_OTLP_*`
 * secrets. Slated for removal in 5.0.0.
 */

import { trace } from "@opentelemetry/api";
import { type Resource, resourceFromAttributes } from "@opentelemetry/resources";

import { configureMeter, configureTracer } from "../middleware/observability";
import { createCompositeLogger, createCompositeMeter } from "./composite";
import {
  configureLogger,
  defaultLoggerAdapter,
  type LogLevel,
  logger,
  setLoggerAttributeFloor,
} from "./logger";
import {
  createAnalyticsEngineMeterAdapter,
  createOtelLoggerAdapter,
  createOtelMeterAdapter,
  flushOtelProviders,
  setRuntimeEnv,
} from "./otelAdapters";
import { RequestContext } from "./requestContext";

const VALID_LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function parseLogLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== "string") return undefined;
  const lc = value.toLowerCase();
  return VALID_LOG_LEVELS.find((l) => l === lc);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OtelOptions {
  /** Logical service name. Falls back to `env.DECO_SITE_NAME`, then "deco-site". */
  serviceName?: string;
  /** Override OTLP endpoint. Defaults to `env.OTEL_EXPORTER_OTLP_ENDPOINT`. */
  endpoint?: string;
  /** Override OTLP auth headers. Defaults to parsed `env.OTEL_EXPORTER_OTLP_HEADERS`. */
  headers?: Record<string, string>;
  /** Env var name holding the AE binding. Defaults to `"DECO_METRICS"`. */
  analyticsEngineBindingName?: string;
  /** Set to `false` to disable AE even when the binding is present. */
  analyticsEngineEnabled?: boolean;
  /** Push interval for OTLP metrics, in ms. Defaults to env.OTEL_EXPORT_INTERVAL or 60_000. */
  metricsExportIntervalMillis?: number;
  /**
   * Minimum severity to forward to the **app-side OTLP** logger (only
   * relevant when `enableAppSideOtlpLogs: true`). The default `console.*`
   * adapter is unaffected and continues to capture every level for
   * Cloudflare Workers Logs / CF-side OTLP export.
   *
   * Defaults to `"warn"`. Falls back to env `OTEL_LOG_MIN_SEVERITY` when
   * unset. Set to `"debug"` to forward everything.
   */
  otlpMinSeverity?: LogLevel;
  /**
   * Opt-in: also wire an in-Worker OTLP logger that pushes log records to
   * `OTEL_EXPORTER_OTLP_ENDPOINT`. Defaults to `false` — sites should
   * prefer the platform-managed CF-side path
   * (`observability.logs.destinations` in `wrangler.jsonc`), which is
   * cheaper, has no flush-bug class, and consumes zero subrequest budget.
   *
   * Use this only when CF's OTLP logs export doesn't meet a specific need
   * (e.g. shipping to a destination CF doesn't support, custom batching,
   * staging-only debugging). Requires `OTEL_EXPORTER_OTLP_ENDPOINT` and
   * `OTEL_EXPORTER_OTLP_HEADERS` to be set.
   *
   * Slated for removal in 5.0.0.
   */
  enableAppSideOtlpLogs?: boolean;
  /**
   * Version of `@decocms/start` to advertise as `deco.runtime.version`
   * on every span (CF doesn't preserve it as a resource attribute since
   * we no longer ship our own resource — we stamp it per-span instead).
   * Falls back to a build-time constant; override only for tests.
   */
  decoRuntimeVersion?: string;
  /** Optional `@decocms/apps` version, stamped as `deco.apps.version` on every span. */
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

interface BootState {
  serviceName: string;
  otlpEndpoint: string | null;
  otlpHeaders: Record<string, string>;
  resource: Resource;
}

let bootState: BootState | null = null;

/**
 * Per-span attribute floor — stamped on every span we create via
 * `configureTracer().startSpan(...)`. These match what the legacy resource
 * attributes used to carry (when `@microlabs/otel-cf-workers` shipped its
 * own OTel `Resource`); we now stamp them on each span so HyperDX panels
 * filtering on `deco.runtime.version`, `deco.apps.version`, or
 * `deployment.environment` keep working with CF-managed export, which only
 * preserves CF's own resource attribute set (`service.name`, `faas.name`,
 * `cloudflare.script_version.id`, etc.).
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
 *  - structured JSON logger (always)
 *  - AE meter (when `DECO_METRICS` binding present)
 *  - optional app-side OTLP meter (when `OTEL_EXPORTER_OTLP_ENDPOINT` set)
 *  - optional app-side OTLP logger (when `enableAppSideOtlpLogs: true`)
 *  - per-request `ctx.waitUntil(forceFlush)` for any registered batch processors
 *  - bridge from framework-internal `withTracing()` to `@opentelemetry/api`
 *    global tracer, with `deco.*` attributes stamped on every span
 *
 * Logs and traces export to HyperDX (or any OTLP destination) is handled
 * by Cloudflare via `observability.{logs,traces}.destinations` in
 * `wrangler.jsonc`. This wrapper does NOT call `@microlabs/otel-cf-workers`
 * `instrument()` — CF's platform-managed export captures `console.*` output
 * and global-tracer spans out-of-band.
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
  // global, so these spans flow through to whatever OTLP destination is
  // configured. Without CF tracing the global tracer is a no-op proxy and
  // the spans simply drop — same outcome as before, no error.
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

      // Stash env so request-scoped adapters (AE) can resolve their
      // bindings. Done inside RequestContext.run wrapping in workerEntry.ts
      // too, but we re-stash here in case `instrumentWorker` is wrapped
      // over a handler that doesn't go through `createDecoWorkerEntry`.
      const wrap = async () => {
        setRuntimeEnv(env);
        return handler.fetch(request, env, ctx);
      };

      try {
        if (RequestContext.current) {
          return await wrap();
        }
        return await RequestContext.run(request, wrap);
      } finally {
        // Drain OTLP meter (and OTLP logger, if `enableAppSideOtlpLogs`)
        // batches inside the post-response window `waitUntil` guarantees.
        // Without this hook, `PeriodicExportingMetricReader` (60s flush)
        // batches usually die with the isolate before the timer fires.
        // No-op when no batch processors are registered.
        try {
          ctx.waitUntil(flushOtelProviders());
        } catch {
          // `waitUntil` only throws if `ctx` isn't a real ExecutionContext
          // (e.g. test stubs). Telemetry flush failures are not request-fatal.
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Boot — wires the loggers/meters once (per worker isolate)
// ---------------------------------------------------------------------------

function bootObservability(opts: OtelOptions, env: Record<string, unknown>): void {
  if (booted && bootState) return;

  const serviceName = opts.serviceName ?? (env.DECO_SITE_NAME as string | undefined) ?? "deco-site";

  const otlpEndpoint =
    opts.endpoint ?? (env.OTEL_EXPORTER_OTLP_ENDPOINT as string | undefined) ?? null;
  const otlpHeaders =
    opts.headers ?? parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS as string | undefined);

  const decoRuntimeVersion = opts.decoRuntimeVersion ?? DECO_RUNTIME_VERSION;
  const deploymentEnvironment = (env.DECO_ENV_NAME as string | undefined) ?? "production";

  const resource = buildResource({
    serviceName,
    serviceVersion: (env.CF_VERSION_METADATA as { id?: string } | undefined)?.id,
    serviceInstanceId: cryptoRandomId(),
    deploymentEnvironment,
    decoRuntimeVersion,
    decoAppsVersion: opts.decoAppsVersion,
  });

  // Stamp deco.* attributes on every span we create. CF-managed trace
  // export emits its own resource attribute set (service.name=Worker name,
  // faas.name, cloudflare.script_version.id, faas.version, etc.) so the
  // legacy resource attrs from `buildResource` don't survive on the
  // CF-side path. Stamping them per-span preserves the dimensions
  // existing HyperDX dashboards filter on.
  spanAttributeFloor = {
    "deco.runtime.version": decoRuntimeVersion,
    "deployment.environment": deploymentEnvironment,
    ...(opts.decoAppsVersion ? { "deco.apps.version": opts.decoAppsVersion } : {}),
  };

  // Same set, stamped on every log record. CF Workers Logs ships the JSON
  // body verbatim (resource attrs from `buildResource` are NOT applied to
  // logs in default mode), so HyperDX panels grouping by these dimensions
  // would otherwise return empty. Caller-supplied `attrs` still win on key
  // collision.
  setLoggerAttributeFloor({
    "deco.runtime.version": decoRuntimeVersion,
    "deployment.environment": deploymentEnvironment,
    ...(opts.decoAppsVersion ? { "deco.apps.version": opts.decoAppsVersion } : {}),
  });

  // ---- Logger ----------------------------------------------------------
  // Default mode: console JSON only. Cloudflare Workers Logs captures the
  // output and ships it via `observability.logs.destinations` to whichever
  // OTLP destination is configured in `wrangler.jsonc`. This is the
  // recommended path: zero in-Worker exporter, no flush bug, no subrequest
  // cost per emit.
  //
  // Opt-in mode (`enableAppSideOtlpLogs: true`): also wire the OTLP logger
  // adapter for sites with destinations CF doesn't support. Requires
  // `OTEL_EXPORTER_OTLP_ENDPOINT` to be set.
  const otlpMinSeverity =
    opts.otlpMinSeverity ?? parseLogLevel(env.OTEL_LOG_MIN_SEVERITY) ?? "warn";

  const wantAppSideLogs = opts.enableAppSideOtlpLogs === true;
  const otelLogger =
    wantAppSideLogs && otlpEndpoint != null
      ? createOtelLoggerAdapter({
          endpoint: otlpEndpoint,
          headers: otlpHeaders,
          resource,
          name: serviceName,
          minSeverity: otlpMinSeverity,
        })
      : null;

  configureLogger(createCompositeLogger([defaultLoggerAdapter, otelLogger]));

  // ---- Meter -----------------------------------------------------------
  // OTLP meter stays default-on when an endpoint is configured: CF doesn't
  // support OTLP metrics export yet, so this is the only path to
  // HyperDX-compatible metrics. Drop this branch when CF ships metrics.
  const otelMeter =
    otlpEndpoint != null
      ? createOtelMeterAdapter({
          endpoint: otlpEndpoint,
          headers: otlpHeaders,
          resource,
          exportIntervalMillis:
            opts.metricsExportIntervalMillis ?? numericEnv(env.OTEL_EXPORT_INTERVAL, 60_000),
          name: serviceName,
        })
      : null;

  const aeBindingName = opts.analyticsEngineBindingName ?? "DECO_METRICS";
  const aeEnabled = opts.analyticsEngineEnabled !== false && Boolean(env[aeBindingName]);
  const aeMeter = aeEnabled
    ? createAnalyticsEngineMeterAdapter({ bindingName: aeBindingName })
    : null;

  configureMeter(createCompositeMeter([aeMeter, otelMeter]));

  bootState = {
    serviceName,
    otlpEndpoint,
    otlpHeaders,
    resource,
  };
  booted = true;

  // Single boot-time breadcrumb so operators can confirm the wiring at a
  // glance from CF Logs without enabling debug. Surfaces which export
  // mode is active (CF-native vs app-side) so misconfigured sites are
  // obvious from the first request.
  logger.info("observability booted", {
    service: serviceName,
    mode: wantAppSideLogs ? "hybrid (app-side OTLP logs + CF traces)" : "cf-native",
    otlpMeter: Boolean(otlpEndpoint),
    otlpLogger: wantAppSideLogs && otlpEndpoint != null,
    otlpMinSeverity: wantAppSideLogs && otlpEndpoint != null ? otlpMinSeverity : null,
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
  bootState = null;
  spanAttributeFloor = {};
  setLoggerAttributeFloor({});
}

// ---------------------------------------------------------------------------
// Resource attributes
// ---------------------------------------------------------------------------

interface ResourceInput {
  serviceName: string;
  serviceVersion?: string;
  serviceInstanceId: string;
  deploymentEnvironment: string;
  decoRuntimeVersion: string;
  decoAppsVersion?: string;
}

function buildResource(input: ResourceInput): Resource {
  const attrs: Record<string, string> = {
    "service.name": input.serviceName,
    "service.version": input.serviceVersion ?? "unknown",
    "service.instance.id": input.serviceInstanceId,
    "cloud.provider": "cloudflare",
    "deployment.environment": input.deploymentEnvironment,
    "deco.runtime.version": input.decoRuntimeVersion,
  };
  if (input.decoAppsVersion) attrs["deco.apps.version"] = input.decoAppsVersion;
  return resourceFromAttributes(attrs);
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
const DECO_RUNTIME_VERSION = "4.4.0";

function parseHeaders(str?: string): Record<string, string> {
  if (!str) return {};
  return Object.fromEntries(
    str
      .split(",")
      .map((kv) => {
        const [k, ...v] = kv.split("=");
        return [k.trim(), v.join("=").trim()] as const;
      })
      .filter(([k]) => k.length > 0),
  );
}

function numericEnv(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function cryptoRandomId(): string {
  // crypto.randomUUID is universally available in CF Workers + Node 19+.
  try {
    return crypto.randomUUID();
  } catch {
    return `inst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}
