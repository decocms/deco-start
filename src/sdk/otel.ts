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
 *    See `otelHttpLog.ts` for the rate limiter + flush model.
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
// OTel community SemConv constants — official attribute names from the OTel
// specification. Importing from the package (rather than typing strings)
// guards against typos, surfaces deprecations via TypeScript, and tracks
// upstream spec changes via the dep version.
//   https://opentelemetry.io/docs/specs/semconv/resource/
//   https://www.npmjs.com/package/@opentelemetry/semantic-conventions
//
// Stable attributes (graduated in upstream SemConv) come from the default
// entry point. Incubating attributes (still experimental upstream) come from
// the `/incubating` subpath — using them is a deliberate trade-off: stable
// attribute names + a stability disclaimer documented in the conventions
// guide (see context/04_engineering/o11y/02-conventions.md §4.2).
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
  ATTR_CLOUD_PLATFORM,
  ATTR_CLOUD_PROVIDER,
} from "@opentelemetry/semantic-conventions/incubating";
import { createCompositeLogger, createCompositeMeter } from "./composite";
import { configureLogger, defaultLoggerAdapter, logger, setLogLevel, setLoggerAttributeFloor, type LogLevel } from "./logger";
import { METRIC_METADATA } from "../middleware/observability";
import { configureMeter, configureTracer, getActiveSpan } from "./observability";
import { createAnalyticsEngineMeterAdapter } from "./otelAdapters";
import { createOtlpHttpLogAdapter, type OtlpHttpLog } from "./otelHttpLog";
import { createOtlpHttpMeterAdapter, type OtlpHttpMeter } from "./otelHttpMeter";
import {
  createOtlpHttpTracerAdapter,
  type OtlpHttpTracer,
  type TraceContext,
} from "./otelHttpTracer";
import { RequestContext } from "./requestContext";

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
   * Env var name holding the OTLP/HTTP logs endpoint — the primary log
   * transport. Defaults to `"DECO_OTEL_LOGS_ENDPOINT"`. When set (and
   * `otlpLogsEnabled !== false`), `instrumentWorker` patches `console.*`
   * at boot so all application and third-party log calls route through
   * the framework logger → direct-POST to this endpoint.
   */
  otlpLogsEndpointEnvVar?: string;
  /** Set to `false` to disable the OTLP/HTTP logs exporter explicitly. */
  otlpLogsEnabled?: boolean;
  /**
   * Minimum log level forwarded via direct-POST. Defaults to `"info"` per
   * the OpenTelemetry specification. Set to `"warn"` to forward only errors
   * and warnings, or `"debug"` to capture everything (can be high volume).
   *
   * Precedence: env var (`otlpLogsMinLevelEnvVar`, default
   * `DECO_OTEL_LOGS_MIN_LEVEL`) > this option > `"info"`. Invalid env
   * values fall through silently.
   */
  otlpLogsMinLevel?: LogLevel;
  /**
   * Env var name to read the minimum log level from. Defaults to
   * `"DECO_OTEL_LOGS_MIN_LEVEL"`. Value MUST be one of
   * `"debug"`, `"info"`, `"warn"`, `"error"`.
   */
  otlpLogsMinLevelEnvVar?: string;
  /**
   * Extra HTTP headers sent on every OTLP POST (logs, traces, metrics).
   * Merged with the adapter default (`Content-Type: application/json`).
   *
   * Resolved from `DECO_OTEL_HEADERS` env var (format: `key=value,key2=value2`)
   * when not set programmatically. Useful for collector auth:
   *
   * ```
   * DECO_OTEL_HEADERS=Authorization=Bearer <token>
   * ```
   */
  otlpHeaders?: Record<string, string>;
  /**
   * Env var name to read extra OTLP headers from. Defaults to `"DECO_OTEL_HEADERS"`.
   * Format: `key=value,key2=value2`.
   */
  otlpHeadersEnvVar?: string;
  /**
   * Authorization header value sent on every OTLP POST.
   * Equivalent to `otlpHeaders: { authorization: "<value>" }` but intended
   * for secrets: store via `wrangler secret put DECO_OTEL_AUTH_TOKEN` so the
   * token is never committed to the repo. Non-secret headers go in
   * `DECO_OTEL_HEADERS` (plaintext in `wrangler.jsonc`).
   *
   * Example: `DECO_OTEL_AUTH_TOKEN=Bearer eyJhbGci...`
   *
   * Precedence (lowest → highest): auth token env var → `DECO_OTEL_HEADERS`
   * env var → `otlpHeaders` option. An explicit `authorization` key in
   * `DECO_OTEL_HEADERS` or `otlpHeaders` overrides this value.
   */
  otlpAuthToken?: string;
  /**
   * Env var name to read the auth token from. Defaults to `"DECO_OTEL_AUTH_TOKEN"`.
   */
  otlpAuthTokenEnvVar?: string;
  /**
   * Env var name holding the OTLP/HTTP traces endpoint used by the
   * direct-POST span exporter. Defaults to `"DECO_OTEL_TRACES_ENDPOINT"`.
   * When set (and `otlpTracesEnabled !== false`), framework `deco.*`
   * spans created via `withTracing` are captured, sampled, and POSTed
   * directly to this endpoint. Flushed alongside metrics via
   * `ctx.waitUntil`.
   *
   * Without this endpoint configured, `withTracing` falls back to the
   * `@opentelemetry/api` global tracer (the legacy CF auto-instrumentation
   * path). The framework registers BOTH adapters when a traces endpoint
   * is set so CF auto-spans stay intact AND framework spans get
   * direct-POSTed to ClickHouse. See Phase 3 in
   * `MIGRATION_TOOLING_PLAN.md`.
   */
  otlpTracesEndpointEnvVar?: string;
  /** Set to `false` to disable the OTLP/HTTP traces exporter explicitly. */
  otlpTracesEnabled?: boolean;
  /**
   * Head sampling rate for framework spans direct-POSTed via the OTLP
   * traces endpoint. Default `0.01` matches the CF Destinations
   * `traces.head_sampling_rate` recommendation. Decisions are consistent
   * per trace (hash of `trace_id`), so child spans (`deco.cache.lookup`,
   * `deco.cms.resolvePage`, ...) are kept iff their root
   * `deco.http.request` span is kept. Set to `1` to capture every trace
   * (preview / debug only — production cost grows linearly).
   *
   * Precedence: env var (`otlpTracesSamplingRateEnvVar`, default
   * `DECO_OTEL_TRACES_SAMPLING_RATE`) > this option > `0.01`. Reading from
   * env lets local-dev opt into 100% sampling via `.dev.vars` without
   * changing the worker entry.
   */
  otlpTracesSamplingRate?: number;
  /**
   * Env var name to read the head sampling rate from when set on `env`.
   * Defaults to `DECO_OTEL_TRACES_SAMPLING_RATE`. Value MUST be a finite
   * number in `[0, 1]`. Invalid values are ignored (falls back to
   * `otlpTracesSamplingRate` then `0.01`).
   */
  otlpTracesSamplingRateEnvVar?: string;
  /**
   * When `true` (or when `DECO_OTEL_ERROR_PROMOTION=true` is set), any
   * `logger.error()` call with an active trace context marks that trace for
   * export even if head sampling did not select it. Useful for ensuring
   * errors always have a trace in ClickHouse without raising the global
   * sampling rate.
   *
   * Disabled by default — enable via env var or this option once validated
   * in production. Precedence: env var (`otlpTracesErrorPromotionEnvVar`,
   * default `DECO_OTEL_ERROR_PROMOTION`) > this option > `false`.
   */
  otlpTracesErrorPromotion?: boolean;
  /**
   * Env var name to read the error promotion flag from. Defaults to
   * `"DECO_OTEL_ERROR_PROMOTION"`. Value must be `"true"` to enable.
   */
  otlpTracesErrorPromotionEnvVar?: string;
  /**
   * Sampling rate applied to error-promoted traces, 0.0..1.0. Default `0.1`
   * (promote 10% of error traces). Lower values cap ClickHouse volume when
   * errors are frequent. Uses the same FNV-1a hash as head sampling.
   *
   * Precedence: env var (`otlpTracesErrorPromotionRateEnvVar`, default
   * `DECO_OTEL_ERROR_PROMOTION_RATE`) > this option > `0.1`.
   */
  otlpTracesErrorPromotionRate?: number;
  /**
   * Env var name to read the error promotion rate from. Defaults to
   * `"DECO_OTEL_ERROR_PROMOTION_RATE"`. Value must be a finite number in
   * `[0, 1]`. Invalid values are ignored.
   */
  otlpTracesErrorPromotionRateEnvVar?: string;
  /** Test seam — replace the global `fetch` used by the traces exporter. */
  otlpTracesFetchImpl?: typeof fetch;
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
  /** Test seam — replace the global `fetch` used by the logs exporter. */
  otlpLogsFetchImpl?: typeof fetch;
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
// Boot state — pinned to globalThis via Symbol.for so multiple bundled
// copies of this module converge on the SAME state.
//
// Why: Vite (and any bundler chunking by entry) can produce more than one
// inlined copy of this file when multiple package entries — e.g.
// `@decocms/start/sdk/otel` and `@decocms/start/sdk/workerEntry` — both
// pull it transitively. With plain module-scoped `let` variables, the
// auto-wrap path inside `createDecoWorkerEntry` ends up writing the meter
// into Copy A's `otlpMeter` while the per-request `recordRequestMetric`
// closure reads from Copy B's empty `otlpMeter`. Net effect in prod:
// `bootObservability` runs (we observed the very first `POST /v1/metrics`
// from miess-tanstack), but every subsequent request's `flush()` finds an
// empty buffer because the meter the framework writes into is a different
// instance from the one the exporter drains.
//
// `observability.ts` already uses this pattern (see the `STATE_KEY` block
// there); the comment there flags this exact failure mode. The reason it
// took so long to surface here is that until PR #232 added the auto-wrap
// inside `createDecoWorkerEntry`, sites always called `instrumentWorker`
// once from their own `worker-entry.ts` — a single bundle entry — so
// nobody hit the duplication path.
//
// CF Workers guarantee one `globalThis` per isolate, so there's no risk
// of cross-isolate bleed. Symbol.for keeps the registry stable across
// hot reloads in `wrangler dev` too.
// ---------------------------------------------------------------------------

type OrigConsole = Pick<typeof console, "log" | "info" | "warn" | "error" | "debug">;

interface BootState {
  booted: boolean;
  otlpMeter: OtlpHttpMeter | null;
  otlpLog: OtlpHttpLog | null;
  otlpTracer: OtlpHttpTracer | null;
  spanAttributeFloor: Record<string, string>;
  origConsole: OrigConsole | null;
}

const BOOT_STATE_KEY = Symbol.for("@decocms/start/sdk/otel/boot.v1");

function getBootState(): BootState {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[BOOT_STATE_KEY]) {
    g[BOOT_STATE_KEY] = {
      booted: false,
      otlpMeter: null,
      otlpLog: null,
      otlpTracer: null,
      spanAttributeFloor: {},
      origConsole: null,
    } satisfies BootState;
  }
  return g[BOOT_STATE_KEY] as BootState;
}

/**
 * Per-request inbound W3C trace context, parsed from the `traceparent`
 * header at request entry. Read by the OTLP trace exporter when it
 * creates a root span so we honor remote parents and the `sampled`
 * flag. Stored on a request-scoped slot (via `RequestContext.bag`) so
 * concurrent requests in the same isolate don't trample each other.
 */
const TRACE_CTX_BAG_KEY = "deco.observability.traceContext.v1";
const DEBUG_SAMPLED_BAG_KEY = "deco.observability.debugSampled.v1";

function getRequestTraceContext(): TraceContext | null {
  return RequestContext.getBag<TraceContext>(TRACE_CTX_BAG_KEY) ?? null;
}

function getDebugSampled(): boolean {
  return RequestContext.getBag<boolean>(DEBUG_SAMPLED_BAG_KEY) ?? false;
}

/**
 * Public entry point used by `workerEntry.ts` to stash the parsed
 * traceparent for the OTLP tracer to consume. Exported (not just
 * module-local) because the parser lives in `otelHttpTracer.ts` and
 * the call site is `workerEntry.ts`.
 */
export function _setRequestTraceContext(ctx: TraceContext | null): void {
  if (ctx) RequestContext.setBag(TRACE_CTX_BAG_KEY, ctx);
}

/**
 * Called by `workerEntry.ts` when the inbound URL contains `?__d=<any>`.
 * Forces trace sampling for the current request regardless of `headSamplingRate`.
 * Useful for debugging individual requests in production without changing
 * the global sampling rate.
 */
export function _setDebugSampled(): void {
  RequestContext.setBag(DEBUG_SAMPLED_BAG_KEY, true);
}

/**
 * Per-span attribute floor — stamped on every span we create via
 * `configureTracer().startSpan(...)`. Lives on the shared `BootState`
 * (see above) so framework code paths that read it through different
 * bundled copies of this module all see the floor `bootObservability`
 * just installed.
 */

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
  // Default tracer bridge — delegates to `@opentelemetry/api` global. When
  // `bootObservability` discovers `DECO_OTEL_TRACES_ENDPOINT`, it composes
  // this bridge with the direct-POST OTLP tracer so framework spans flow to
  // BOTH the CF dashboard AND ClickHouse (the bridge stays a no-op when CF
  // tracing isn't configured, which is the common case today). See
  // `configureTracerStack` below.
  configureTracer(buildOtelApiTracer());

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
        // Drain the OTLP metrics + error-log + traces buffers via
        // ctx.waitUntil so no POST blocks the response. Each exporter
        // throttles itself per isolate — calling on every request is
        // cheap; the network only fires when the cooldown elapses or
        // the buffer fills.
        const state = getBootState();
        if (state.otlpMeter) {
          try {
            ctx.waitUntil(state.otlpMeter.flush());
          } catch {
            /* ctx.waitUntil throwing is benign — never block the response */
          }
        }
        if (state.otlpLog) {
          try {
            ctx.waitUntil(state.otlpLog.flush());
          } catch {
            /* swallow */
          }
        }
        if (state.otlpTracer) {
          try {
            ctx.waitUntil(state.otlpTracer.flush());
          } catch {
            /* swallow */
          }
        }
      }
    },
  };
}

/**
 * Build the legacy `@opentelemetry/api` global-tracer bridge. Stays a
 * no-op when no global TracerProvider is registered — same outcome as
 * the historical configuration.
 */
function buildOtelApiTracer(): import("../middleware/observability").TracerAdapter {
  return {
    startSpan: (name, attrs) => {
      const merged = { ...getBootState().spanAttributeFloor, ...(attrs ?? {}) };
      const span = trace.getTracer("@decocms/start").startSpan(name, { attributes: merged });
      return {
        end: () => span.end(),
        setError: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof Error) span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message });
        },
        setAttribute: (k, v) => {
          span.setAttribute(k, v);
          if (k === "http.status_code" && typeof v === "number" && v >= 400) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${v}` });
          }
        },
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
  };
}

/**
 * Wire the framework tracer. When the OTLP traces endpoint is configured,
 * compose the direct-POST tracer ALONGSIDE the `@opentelemetry/api` bridge
 * via a fanout adapter so:
 *   1. `withTracing` calls feed BOTH adapters.
 *   2. A child span's `spanContext()` reports the direct-POST span's IDs
 *      (the bridge is best-effort — if CF tracing isn't installed those
 *      IDs are zeros anyway).
 *
 * When no traces endpoint is configured, fall back to the bridge alone —
 * preserves the legacy behavior for sites that haven't bumped wrangler.
 */
function configureTracerStack(otlpAdapter: OtlpHttpTracer | null): void {
  const bridge = buildOtelApiTracer();
  if (!otlpAdapter) {
    configureTracer(bridge);
    return;
  }
  // Compose. The OTLP adapter is the "primary" (its IDs win for
  // `spanContext()` because callers downstream use them for trace
  // propagation). The bridge is best-effort — fed the same name/attrs
  // so CF Workers Observability still sees the spans if that channel
  // is enabled in wrangler.jsonc.
  configureTracer({
    startSpan(name, attrs) {
      const merged = { ...getBootState().spanAttributeFloor, ...(attrs ?? {}) };
      const primary = otlpAdapter.startSpan(name, merged);
      const secondary = bridge.startSpan(name, merged);
      return {
        end(): void {
          try {
            primary.end();
          } finally {
            try {
              secondary.end();
            } catch {
              /* swallow */
            }
          }
        },
        setError(error: unknown): void {
          try {
            primary.setError?.(error);
          } finally {
            try {
              secondary.setError?.(error);
            } catch {
              /* swallow */
            }
          }
        },
        setAttribute(key: string, value: string | number | boolean): void {
          primary.setAttribute?.(key, value);
          try {
            secondary.setAttribute?.(key, value);
          } catch {
            /* swallow */
          }
        },
        spanContext() {
          // The OTLP adapter owns the canonical IDs — those are the IDs
          // we propagate downstream via `traceparent` headers.
          return primary.spanContext?.() ?? secondary.spanContext?.() ?? {
            traceId: "",
            spanId: "",
            traceFlags: 0,
          };
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Boot — wires the loggers/meters once (per worker isolate)
// ---------------------------------------------------------------------------

/**
 * Replaces `console.*` with thin shims that route every call through the
 * framework `logger`, which forwards to the configured adapter (direct-POST
 * OTLP when active). The original functions are saved on `BootState` so
 * `_resetBootStateForTests()` can restore them between test runs.
 *
 * A re-entrancy guard (`busy`) prevents the loop that would occur if the
 * active logger adapter ever calls back into `console.*` (e.g. the
 * `defaultLoggerAdapter` in dev mode). Without the guard:
 *   console.error → logger.error → defaultLoggerAdapter → console.error → …
 *
 * Only called when the OTLP logs endpoint is configured. In dev (no OTLP),
 * `console.*` is left untouched so `wrangler dev` / `wrangler tail` keep
 * showing output normally.
 */
function patchConsole(state: BootState): void {
  if (state.origConsole) return; // already patched this isolate

  const orig: OrigConsole = {
    log:   console.log.bind(console),
    info:  console.info.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
  state.origConsole = orig;

  let busy = false;

  const forward = (level: LogLevel, args: unknown[]): void => {
    if (busy) return;
    busy = true;
    try {
      const msg = args
        .map((a) => {
          if (typeof a === "string") return a;
          try { return JSON.stringify(a); } catch { return String(a); }
        })
        .join(" ");
      logger[level](msg);
    } finally {
      busy = false;
    }
  };

  console.log   = (...args: unknown[]) => forward("info",  args);
  console.info  = (...args: unknown[]) => forward("info",  args);
  console.warn  = (...args: unknown[]) => forward("warn",  args);
  console.error = (...args: unknown[]) => forward("error", args);
  console.debug = (...args: unknown[]) => forward("debug", args);
}

function bootObservability(opts: OtelOptions, env: Record<string, unknown>): void {
  const state = getBootState();
  if (state.booted) return;

  // Capture the original console.warn BEFORE patchConsole() runs. The onError
  // callbacks below need a direct channel to console that bypasses the logger
  // to avoid routing exporter-level warnings back through the OTLP adapter
  // that is currently failing.
  const warnDirect = console.warn.bind(console);

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
  //
  // service.instance.id (OTel SemConv required for distributed services) is a
  // per-isolate UUID generated at boot. Distinguishes parallel isolates on the
  // same deploy — required so the System Health Agent can attribute behavior
  // (memory creep, slow cold starts) to a specific instance.
  //   https://opentelemetry.io/docs/specs/semconv/resource/#service
  //
  // cloud.provider / cloud.platform are stamped statically here because every
  // isolate runs on CF Workers. cloud.region (the CF colo) is per-request, not
  // per-isolate, so it's NOT in the resource floor — it MUST be attached at
  // the span level by the request handler.
  //   https://opentelemetry.io/docs/specs/semconv/resource/cloud/
  //
  // Note: `deco.runtime.version` and `deco.apps.version` are Deco extensions
  // (not in OTel SemConv), so they remain as string literals.
  const floor: Record<string, string> = {
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_INSTANCE_ID]: crypto.randomUUID(),
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: deploymentEnvironment,
    [ATTR_CLOUD_PROVIDER]: "cloudflare",
    [ATTR_CLOUD_PLATFORM]: "cloudflare_workers",
    "deco.runtime.version": decoRuntimeVersion,
  };
  if (serviceVersion) floor[ATTR_SERVICE_VERSION] = serviceVersion;
  if (opts.decoAppsVersion) floor["deco.apps.version"] = opts.decoAppsVersion;

  // Stamp on every span we create. CF-managed trace export emits its own
  // resource attribute set, so legacy resource attrs don't survive.
  // Stamping per-span preserves the dimensions dashboards / saved searches
  // filter on.
  state.spanAttributeFloor = floor;

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
  //  - `otlpLog.adapter`: direct POST to `/v1/logs` for level=error
  //    only, rate-limited (default 100/min, burst 20), buffered, flushed
  //    via `ctx.waitUntil` at request end. Guarantees ≥99% error capture
  //    regardless of the CF Destinations sampling rate. See
  //    `otelHttpLog.ts` for the aggregation + rate-limit details.
  //
  // The two paths land in the SAME `default.otel_logs` table, so the
  // ingestor's existing PII redaction applies uniformly and dashboards
  // need no changes. Records from the direct-POST path are
  // distinguishable from CF-Destinations records by `ScopeName =
  // "@decocms/start"` if needed (CF stamps its own scope).
  const otlpLogsEnvVar = opts.otlpLogsEndpointEnvVar ?? "DECO_OTEL_LOGS_ENDPOINT";
  const otlpLogsEndpoint = (env[otlpLogsEnvVar] as string | undefined) ?? "";
  const otlpLogsEnabled =
    opts.otlpLogsEnabled !== false && otlpLogsEndpoint.length > 0;
  // Minimum log level precedence: env var > options > "info" default (OTel spec).
  // Invalid env values fall through silently.
  const otlpLogsMinLevelEnvVar =
    opts.otlpLogsMinLevelEnvVar ?? "DECO_OTEL_LOGS_MIN_LEVEL";
  const otlpLogsMinLevelFromEnv = (
    (env[otlpLogsMinLevelEnvVar] as string | undefined) ?? ""
  ).toLowerCase();
  const validLogLevels = ["debug", "info", "warn", "error"] as const;
  const otlpLogsMinLevel: LogLevel =
    (validLogLevels as readonly string[]).includes(otlpLogsMinLevelFromEnv)
      ? (otlpLogsMinLevelFromEnv as LogLevel)
      : opts.otlpLogsMinLevel ?? "info";
  // Sync the logger gate so logger.debug() calls are not silently dropped
  // before reaching the OTLP adapter when minLevel is "debug" or "info".
  setLogLevel(otlpLogsMinLevel);
  const otlpHeadersEnvVar = opts.otlpHeadersEnvVar ?? "DECO_OTEL_HEADERS";
  const otlpHeadersFromEnv = (env[otlpHeadersEnvVar] as string | undefined) ?? "";
  const parsedEnvHeaders: Record<string, string> = {};
  for (const pair of otlpHeadersFromEnv.split(",")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx > 0) {
      parsedEnvHeaders[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
    }
  }
  const otlpAuthTokenEnvVar = opts.otlpAuthTokenEnvVar ?? "DECO_OTEL_AUTH_TOKEN";
  const otlpAuthToken = (env[otlpAuthTokenEnvVar] as string | undefined) ?? opts.otlpAuthToken ?? "";
  const authHeader: Record<string, string> = otlpAuthToken ? { authorization: otlpAuthToken } : {};
  // Priority: auth token (lowest) → DECO_OTEL_HEADERS env → otlpHeaders option (highest).
  const otlpHeaders: Record<string, string> = { ...authHeader, ...parsedEnvHeaders, ...(opts.otlpHeaders ?? {}) };

  const errorPromotionEnvVar =
    opts.otlpTracesErrorPromotionEnvVar ?? "DECO_OTEL_ERROR_PROMOTION";
  const errorPromotionEnabled =
    (env[errorPromotionEnvVar] as string | undefined) === "true" ||
    (opts.otlpTracesErrorPromotion ?? false);

  if (otlpLogsEnabled) {
    state.otlpLog = createOtlpHttpLogAdapter({
      endpoint: otlpLogsEndpoint,
      resourceAttributes: floor,
      scopeVersion: decoRuntimeVersion,
      minLevel: otlpLogsMinLevel,
      headers: otlpHeaders,
      fetchImpl: opts.otlpLogsFetchImpl,
      promoteTrace: errorPromotionEnabled
        ? (traceId) => state.otlpTracer?.promoteTrace(traceId)
        : undefined,
      onError: (kind, err) => {
        // Use warnDirect (pre-patch console.warn) to avoid routing this
        // warning back through the OTLP adapter that is currently failing.
        try {
          warnDirect(
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
    state.otlpLog = null;
  }

  if (otlpLogsEnabled) {
    // OTLP active: direct-POST is the sole log transport.
    // console.* will be intercepted by patchConsole() below so all
    // application and third-party console calls route here too.
    // defaultLoggerAdapter is excluded to prevent workerd from capturing
    // framework logs (which would make them visible to the tail worker a
    // second time — the tail worker only needs to see what the worker
    // itself cannot capture: exceededCpu / exceededMemory / isolate crashes).
    configureLogger(createCompositeLogger([state.otlpLog!.adapter]));
  } else {
    // No OTLP endpoint — dev mode. Keep writing to console so wrangler dev /
    // wrangler tail show output normally. No monkey-patch applied.
    configureLogger(createCompositeLogger([defaultLoggerAdapter]));
  }

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
    state.otlpMeter = createOtlpHttpMeterAdapter({
      endpoint: otlpEndpoint,
      resourceAttributes: floor,
      scopeVersion: decoRuntimeVersion,
      headers: otlpHeaders,
      fetchImpl: opts.otlpMetricsFetchImpl,
      metricMetadata: METRIC_METADATA,
      onError: (kind, err) => {
        try {
          warnDirect(
            JSON.stringify({
              level: "warn",
              msg: "otlp metrics exporter",
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
    state.otlpMeter = null;
  }

  const composedMeter = createCompositeMeter([aeAdapter, state.otlpMeter]);
  // Composite meter is always installed — when both backends are absent the
  // composite becomes a 0-element no-op via createCompositeMeter's filter.
  configureMeter(composedMeter);

  // Traces — direct-POST exporter for framework `deco.*` spans. Without
  // this, `withTracing` delegates to the no-op `@opentelemetry/api`
  // global tracer and every framework span silently disappears (the
  // Phase 3 gap documented in `MIGRATION_TOOLING_PLAN.md`). Same
  // transport pattern as metrics/error-logs — buffered, sampled by
  // trace-id hash, flushed via `ctx.waitUntil`.
  const otlpTracesEnvVar = opts.otlpTracesEndpointEnvVar ?? "DECO_OTEL_TRACES_ENDPOINT";
  const otlpTracesEndpoint = (env[otlpTracesEnvVar] as string | undefined) ?? "";
  const otlpTracesEnabled =
    opts.otlpTracesEnabled !== false && otlpTracesEndpoint.length > 0;
  if (otlpTracesEnabled) {
    // Sampling rate precedence: env var > options > 0.01 default.
    // Invalid env values (NaN, < 0, > 1) fall through silently.
    const otlpTracesSamplingRateEnvVar =
      opts.otlpTracesSamplingRateEnvVar ?? "DECO_OTEL_TRACES_SAMPLING_RATE";
    const samplingRateFromEnv = Number.parseFloat(
      (env[otlpTracesSamplingRateEnvVar] as string | undefined) ?? "",
    );
    const samplingRateOverride =
      Number.isFinite(samplingRateFromEnv) &&
      samplingRateFromEnv >= 0 &&
      samplingRateFromEnv <= 1
        ? samplingRateFromEnv
        : undefined;
    const errorPromotionRateEnvVar =
      opts.otlpTracesErrorPromotionRateEnvVar ?? "DECO_OTEL_ERROR_PROMOTION_RATE";
    const errorPromotionRateFromEnv = Number.parseFloat(
      (env[errorPromotionRateEnvVar] as string | undefined) ?? "",
    );
    const errorPromotionRate =
      Number.isFinite(errorPromotionRateFromEnv) &&
      errorPromotionRateFromEnv >= 0 &&
      errorPromotionRateFromEnv <= 1
        ? errorPromotionRateFromEnv
        : (opts.otlpTracesErrorPromotionRate ?? 0.1);

    state.otlpTracer = createOtlpHttpTracerAdapter({
      endpoint: otlpTracesEndpoint,
      resourceAttributes: floor,
      scopeVersion: decoRuntimeVersion,
      headSamplingRate: samplingRateOverride ?? opts.otlpTracesSamplingRate ?? 0.01,
      errorPromotionRate,
      headers: otlpHeaders,
      fetchImpl: opts.otlpTracesFetchImpl,
      getActiveSpanForParent: () => getActiveSpan(),
      getRequestTraceContext,
      getForceSampled: getDebugSampled,
      onError: (kind, err) => {
        try {
          warnDirect(
            JSON.stringify({
              level: "warn",
              msg: "otlp traces exporter",
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
    state.otlpTracer = null;
  }

  // Wire the tracer stack — composes the OTLP direct-POST adapter (when
  // configured) with the @opentelemetry/api bridge. See
  // `configureTracerStack` for the fanout semantics.
  configureTracerStack(state.otlpTracer);

  state.booted = true;

  // Intercept console.* only when OTLP is active (production). In dev mode
  // (no OTLP endpoint) console is left untouched so wrangler dev / wrangler
  // tail keep showing output normally.
  if (otlpLogsEnabled) {
    patchConsole(state);
  }

  // Boot breadcrumb — infra telemetry, not application telemetry. Goes to the
  // original console (pre-patch) so it shows in wrangler dev / wrangler tail
  // without polluting the OTLP buffer (where it would interfere with trace-
  // based sampling — there is no active span at boot time).
  try {
    warnDirect(
      JSON.stringify({
        level: "info",
        msg: "observability booted",
        service: serviceName,
        analyticsEngine: aeEnabled,
        otlpMetrics: otlpEnabled,
        otlpLogs: otlpLogsEnabled,
        otlpLogsMinLevel: otlpLogsMinLevel,
        otlpTraces: otlpTracesEnabled,
        consolePatch: otlpLogsEnabled,
        runtimeVersion: decoRuntimeVersion,
        deploymentEnvironment,
        ...(serviceVersion ? { serviceVersion } : {}),
      }),
    );
  } catch {
    /* swallow */
  }
}

/**
 * Test-only: clear boot state so successive tests can re-boot
 * `instrumentWorker` with different options. Do not call from app code.
 */
export function _resetBootStateForTests(): void {
  const state = getBootState();
  state.booted = false;
  state.spanAttributeFloor = {};
  state.otlpMeter = null;
  state.otlpLog = null;
  state.otlpTracer = null;
  if (state.origConsole) {
    console.log   = state.origConsole.log;
    console.info  = state.origConsole.info;
    console.warn  = state.origConsole.warn;
    console.error = state.origConsole.error;
    console.debug = state.origConsole.debug;
    state.origConsole = null;
  }
  setLoggerAttributeFloor({});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @decocms/start version, read from package.json so it stays in sync
 * automatically with every semantic-release cut.
 */
import pkg from "../../package.json";
const DECO_RUNTIME_VERSION = pkg.version;
