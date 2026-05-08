/**
 * Single observability entry point for `@decocms/start` on Cloudflare Workers.
 *
 * `instrumentWorker(handler, options)` wraps a Worker handler with:
 *  - structured JSON logger (stdout → Cloudflare Logs / Logpush) — always
 *  - OTLP/HTTP logs exporter (HyperDX) — when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
 *  - OTLP/HTTP metrics exporter (HyperDX) — same condition
 *  - Workers Analytics Engine metrics — when `env.DECO_METRICS` binding exists
 *  - OTel traces via `@microlabs/otel-cf-workers` — when OTLP endpoint is set,
 *    or always-on for the framework's internal `withTracing()` calls.
 *  - URL-based head sampler from `OTEL_SAMPLING_CONFIG`
 *  - OTel `Resource` with service.* / cloud.* / deployment.environment /
 *    deco.runtime.version attributes
 *
 * Removing HyperDX = unsetting `OTEL_EXPORTER_OTLP_ENDPOINT`. The console-JSON
 * logger and AE metrics keep flowing — this is the "no vendor lock-in" guarantee.
 *
 * @example
 * ```ts
 * import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
 * import { instrumentWorker } from "@decocms/start/sdk/otel";
 *
 * const handler = createDecoWorkerEntry(serverEntry, options);
 *
 * export default instrumentWorker(handler, { serviceName: "my-store" });
 * ```
 *
 * Wrangler bindings to add when enabling OTLP + AE:
 * ```jsonc
 * "version_metadata":         { "binding": "CF_VERSION_METADATA" },
 * "analytics_engine_datasets": [{ "binding": "DECO_METRICS", "dataset": "deco_metrics_my_site" }]
 * ```
 *
 * Required Worker secrets when OTLP is enabled:
 *   wrangler secret put OTEL_EXPORTER_OTLP_ENDPOINT  # https://in-otel.hyperdx.io
 *   wrangler secret put OTEL_EXPORTER_OTLP_HEADERS   # authorization=<token>
 */

import { instrument, type ResolveConfigFn } from "@microlabs/otel-cf-workers";
import { trace } from "@opentelemetry/api";
import { type Resource, resourceFromAttributes } from "@opentelemetry/resources";

import { configureMeter, configureTracer } from "../middleware/observability";
import { createCompositeLogger, createCompositeMeter } from "./composite";
import { configureLogger, defaultLoggerAdapter, type LogLevel, logger } from "./logger";
import {
  createAnalyticsEngineMeterAdapter,
  createOtelLoggerAdapter,
  createOtelMeterAdapter,
  flushOtelProviders,
  setRuntimeEnv,
} from "./otelAdapters";
import { RequestContext } from "./requestContext";
import { createUrlBasedHeadSampler, decodeSamplingConfig } from "./sampler";

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
   * Minimum severity to forward to OTLP logs (HyperDX). Below the floor
   * the framework still writes a structured JSON line to `console.*`
   * (Cloudflare Workers Logs), so nothing is silently lost.
   *
   * Defaults to `"warn"`. Falls back to env `OTEL_LOG_MIN_SEVERITY` when
   * unset. Set to `"debug"` to forward everything.
   */
  otlpMinSeverity?: LogLevel;
  /**
   * Version of `@decocms/start` to advertise as `deco.runtime.version`.
   * Falls back to a build-time constant; override only for tests.
   */
  decoRuntimeVersion?: string;
  /** Optional `@decocms/apps` version, advertised as `deco.apps.version`. */
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

// ---------------------------------------------------------------------------
// instrumentWorker
// ---------------------------------------------------------------------------

/**
 * Wraps a Cloudflare Worker handler with the full @decocms/start
 * observability stack. Idempotent — calling twice on the same handler
 * is a no-op (returns the already-instrumented handler).
 */
export function instrumentWorker(
  handler: WorkerHandler,
  options: OtelOptions | ((env: Record<string, unknown>) => OtelOptions) = {},
): WorkerHandler {
  // Bridge our pluggable TracerAdapter onto @opentelemetry/api so
  // framework-internal `withTracing()` calls produce real OTel spans
  // for whatever exporter is configured (OTLP, console, etc.).
  configureTracer({
    startSpan: (name, attrs) => {
      const span = trace.getTracer("@decocms/start").startSpan(name, { attributes: attrs });
      return {
        end: () => span.end(),
        setError: (error) => {
          if (error instanceof Error) span.recordException(error);
        },
        setAttribute: (k, v) => span.setAttribute(k, v),
      };
    },
  });

  const resolveConfig: ResolveConfigFn = (env, _trigger) => {
    const opts = typeof options === "function" ? options(env as Record<string, unknown>) : options;
    bootObservability(opts, env as Record<string, unknown>);

    const state = bootState!;

    // Sampling — base64 JSON via OTEL_SAMPLING_CONFIG, see sdk/sampler.ts
    const samplingConfig = decodeSamplingConfig(env.OTEL_SAMPLING_CONFIG as string | undefined);
    const headSampler = createUrlBasedHeadSampler(samplingConfig);

    // microlabs requires an exporter even when we only want internal
    // tracing. When OTLP isn't configured, we still set up a no-op
    // collector — the URL we'd never reach so spans simply drop.
    const exporterUrl = state.otlpEndpoint ?? "http://127.0.0.1:0/v1/traces";

    return {
      exporter: {
        url: joinPath(exporterUrl, "/v1/traces"),
        headers: state.otlpHeaders,
      },
      service: {
        name: state.serviceName,
        version: (env.CF_VERSION_METADATA as { id?: string } | undefined)?.id,
      },
      sampling: { headSampler },
      // microlabs auto-instruments globalThis.fetch + KV + waitUntil.
      instrumentation: {
        instrumentGlobalFetch: true,
        instrumentGlobalCache: true,
      },
    };
  };

  const innerHandler: WorkerHandler = {
    async fetch(request, env, ctx) {
      // Stash env so request-scoped adapters (AE) can resolve their bindings.
      // Done inside RequestContext.run wrapping in workerEntry.ts as well, but
      // for instrumentWorker we re-stash in case this handler is wrapped over
      // the top of a Worker that doesn't go through createDecoWorkerEntry.
      const wrap = async () => {
        setRuntimeEnv(env);
        return handler.fetch(request, env, ctx);
      };

      try {
        // RequestContext may already be active (createDecoWorkerEntry sets it
        // up). If so, run inline; otherwise wrap. Cheap to detect via current.
        if (RequestContext.current) {
          return await wrap();
        }
        return await RequestContext.run(request, wrap);
      } finally {
        // Drain OTLP logger + meter batches inside the post-response window
        // the platform guarantees via `waitUntil`. Without this hook,
        // BatchLogRecordProcessor (5s flush) and PeriodicExportingMetricReader
        // (60s flush) batches usually die with the isolate before the timer
        // fires and never reach HyperDX. `flushOtelProviders` is a no-op when
        // OTLP isn't configured, so this is safe in every code path.
        try {
          ctx.waitUntil(flushOtelProviders());
        } catch {
          // `waitUntil` only throws if `ctx` isn't a real ExecutionContext
          // (e.g. test stubs). Telemetry flush failures are not request-fatal.
        }
      }
    },
  };

  // deno-lint-ignore no-explicit-any
  return instrument(innerHandler as any, resolveConfig) as unknown as WorkerHandler;
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

  const resource = buildResource({
    serviceName,
    serviceVersion: (env.CF_VERSION_METADATA as { id?: string } | undefined)?.id,
    serviceInstanceId: cryptoRandomId(),
    deploymentEnvironment: (env.DECO_ENV_NAME as string | undefined) ?? "production",
    decoRuntimeVersion: opts.decoRuntimeVersion ?? DECO_RUNTIME_VERSION,
    decoAppsVersion: opts.decoAppsVersion,
  });

  // ---- Logger ----------------------------------------------------------
  const otlpMinSeverity =
    opts.otlpMinSeverity ?? parseLogLevel(env.OTEL_LOG_MIN_SEVERITY) ?? "warn";

  const otelLogger =
    otlpEndpoint != null
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
  // glance from CF Logs without enabling debug.
  logger.info("observability booted", {
    service: serviceName,
    otlp: Boolean(otlpEndpoint),
    otlpMinSeverity: otlpEndpoint != null ? otlpMinSeverity : null,
    analyticsEngine: aeEnabled,
    sampling: Boolean(env.OTEL_SAMPLING_CONFIG),
    runtimeVersion: opts.decoRuntimeVersion ?? DECO_RUNTIME_VERSION,
  });
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
const DECO_RUNTIME_VERSION = "2.28.2";

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

function joinPath(base: string, path: string): string {
  if (!base) return path;
  if (base.endsWith("/")) base = base.slice(0, -1);
  if (!path.startsWith("/")) path = "/" + path;
  if (base.toLowerCase().endsWith(path.toLowerCase())) return base;
  return base + path;
}

function cryptoRandomId(): string {
  // crypto.randomUUID is universally available in CF Workers + Node 19+.
  try {
    return crypto.randomUUID();
  } catch {
    return `inst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}
