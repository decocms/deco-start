/**
 * OpenTelemetry adapter implementations for `@decocms/start`.
 *
 * These adapters plug into the framework's existing pluggable interfaces:
 *  - `LoggerAdapter`  (from `./logger`)        ← OTLP logs
 *  - `MeterAdapter`   (from `../middleware/observability`) ← OTLP metrics
 *  - `MeterAdapter`                              ← Cloudflare Workers Analytics Engine
 *
 * Mirrors the metrics views and TTLs from `deco-cx/deco`'s
 * `observability/otel/metrics.ts` so dashboards built against the Fresh
 * stack keep working after the migration.
 *
 * All three adapters are no-op safe: missing env vars / missing AE binding
 * means the adapter does nothing rather than throwing. The fan-out wrapper
 * in `./composite` provides additional try/catch isolation.
 */

import {
  type Counter,
  type Histogram,
  metrics as metricsApi,
  type ObservableGauge,
} from "@opentelemetry/api";
import { type AnyValue, logs as logsApi, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import type { Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import {
  type AggregationOption,
  AggregationType,
  InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ViewOptions,
} from "@opentelemetry/sdk-metrics";
import type { MeterAdapter } from "../middleware/observability";
import { MetricNames } from "../middleware/observability";
import type { LoggerAdapter, LogLevel } from "./logger";
import { RequestContext } from "./requestContext";

// ---------------------------------------------------------------------------
// Env / binding access
// ---------------------------------------------------------------------------

/**
 * Per-request access to the Cloudflare Worker `env` bag. Stashed by
 * `instrumentWorker()` at the top of every request via
 * `RequestContext.setBag("__deco_env", env)`.
 *
 * Adapters use this to look up the AE binding (or any future binding-driven
 * destination) without forcing site code to thread `env` through every
 * call site.
 */
const ENV_BAG_KEY = "__deco_env";

export function setRuntimeEnv(env: Record<string, unknown>): void {
  RequestContext.setBag(ENV_BAG_KEY, env);
}

export function getRuntimeEnv(): Record<string, unknown> | undefined {
  return RequestContext.getBag<Record<string, unknown>>(ENV_BAG_KEY);
}

// ---------------------------------------------------------------------------
// OtelLoggerAdapter
// ---------------------------------------------------------------------------

const SEVERITY: Record<LogLevel, { number: SeverityNumber; text: string }> = {
  debug: { number: SeverityNumber.DEBUG, text: "DEBUG" },
  info: { number: SeverityNumber.INFO, text: "INFO" },
  warn: { number: SeverityNumber.WARN, text: "WARN" },
  error: { number: SeverityNumber.ERROR, text: "ERROR" },
};

export interface OtelLoggerAdapterOptions {
  endpoint: string;
  headers?: Record<string, string>;
  resource?: Resource;
  /** OTel logger name. Defaults to "@decocms/start". */
  name?: string;
}

/**
 * Streams `logger.*` calls to an OTLP/HTTP logs endpoint (e.g. HyperDX).
 *
 * Returns `null` when no endpoint is configured — `instrumentWorker()`
 * uses that signal to skip registering this adapter.
 */
export function createOtelLoggerAdapter(
  options: OtelLoggerAdapterOptions | null,
): LoggerAdapter | null {
  if (!options || !options.endpoint) return null;

  const exporter = new OTLPLogExporter({
    url: joinPath(options.endpoint, "/v1/logs"),
    headers: options.headers,
  });

  const provider = new LoggerProvider({
    resource: options.resource,
  });
  provider.addLogRecordProcessor(new BatchLogRecordProcessor(exporter));

  // Register globally so `@opentelemetry/api-logs` consumers (if any)
  // also pick it up. Idempotent — safe across multiple worker reloads.
  try {
    logsApi.setGlobalLoggerProvider(provider);
  } catch {
    /* already set */
  }

  const otelLogger = provider.getLogger(options.name ?? "@decocms/start");

  return {
    log(level, msg, attrs) {
      const sev = SEVERITY[level];
      otelLogger.emit({
        severityNumber: sev.number,
        severityText: sev.text,
        body: msg,
        attributes: attrs ? sanitizeAttributes(attrs) : undefined,
      });
    },
  };
}

/**
 * Coerce an arbitrary `Record<string, unknown>` into the strict `AnyValueMap`
 * the OTel logs API expects. Drops anything that can't be safely
 * represented (functions, symbols, circular structures via stringify guard).
 */
function sanitizeAttributes(attrs: Record<string, unknown>): Record<string, AnyValue> {
  const out: Record<string, AnyValue> = {};
  for (const [k, v] of Object.entries(attrs)) {
    out[k] = toAnyValue(v);
  }
  return out;
}

function toAnyValue(v: unknown): AnyValue {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map(toAnyValue);
  if (typeof v === "object") {
    const out: Record<string, AnyValue> = {};
    for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
      out[k] = toAnyValue(vv);
    }
    return out;
  }
  // Functions, symbols, bigint — stringify so the operator still sees something.
  try {
    return String(v);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// OtelMeterAdapter
// ---------------------------------------------------------------------------

/**
 * Histogram bucket boundaries for millisecond timings.
 * Mirrors `deco-cx/deco/observability/otel/metrics.ts` so HyperDX
 * panels built off the Fresh stack keep working unchanged.
 */
const MS_BOUNDARIES = [10, 100, 500, 1000, 5000, 10000, 15000];
/** Histogram bucket boundaries for second timings. */
const SECONDS_BOUNDARIES = [1, 5, 10, 50];

export interface OtelMeterAdapterOptions {
  endpoint: string;
  headers?: Record<string, string>;
  resource?: Resource;
  /** Push interval in ms. Defaults to env.OTEL_EXPORT_INTERVAL or 60_000. */
  exportIntervalMillis?: number;
  /** OTel meter name. Defaults to "@decocms/start". */
  name?: string;
}

/**
 * Streams metric writes to an OTLP/HTTP metrics endpoint with a
 * `PeriodicExportingMetricReader`.
 *
 * Two histogram views are pre-registered:
 *  - any metric ending with `_ms` → millisecond bucket boundaries
 *  - any metric ending with `_s`  → second bucket boundaries
 *
 * Returns `null` when no endpoint is configured.
 */
export function createOtelMeterAdapter(
  options: OtelMeterAdapterOptions | null,
): MeterAdapter | null {
  if (!options || !options.endpoint) return null;

  const exporter = new OTLPMetricExporter({
    url: joinPath(options.endpoint, "/v1/metrics"),
    headers: options.headers,
  });

  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: options.exportIntervalMillis ?? 60_000,
  });

  const histogramAggregation = (boundaries: number[]): AggregationOption => ({
    type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
    options: { boundaries, recordMinMax: true },
  });

  const views: ViewOptions[] = [
    {
      instrumentName: "*_ms",
      instrumentType: InstrumentType.HISTOGRAM,
      aggregation: histogramAggregation(MS_BOUNDARIES),
    },
    {
      instrumentName: "*_s",
      instrumentType: InstrumentType.HISTOGRAM,
      aggregation: histogramAggregation(SECONDS_BOUNDARIES),
    },
  ];

  const provider = new MeterProvider({
    resource: options.resource,
    readers: [reader],
    views,
  });

  try {
    metricsApi.setGlobalMeterProvider(provider);
  } catch {
    /* already set */
  }

  const meter = provider.getMeter(options.name ?? "@decocms/start");

  // Lazy-create instruments by name so we don't pay the create cost on
  // every recordRequestMetric / recordCacheMetric invocation.
  const counters = new Map<string, Counter>();
  const histograms = new Map<string, Histogram>();
  const gauges = new Map<string, ObservableGauge>();
  const gaugeValues = new Map<string, { value: number; labels?: Record<string, unknown> }>();

  function getCounter(name: string): Counter {
    let c = counters.get(name);
    if (!c) {
      c = meter.createCounter(name);
      counters.set(name, c);
    }
    return c;
  }
  function getHistogram(name: string): Histogram {
    let h = histograms.get(name);
    if (!h) {
      h = meter.createHistogram(name);
      histograms.set(name, h);
    }
    return h;
  }
  function ensureGauge(name: string): void {
    if (gauges.has(name)) return;
    const g = meter.createObservableGauge(name);
    g.addCallback((result) => {
      const last = gaugeValues.get(name);
      if (last)
        result.observe(last.value, last.labels as Record<string, string | number | boolean>);
    });
    gauges.set(name, g);
  }

  return {
    counterInc(name, value, labels) {
      getCounter(name).add(value ?? 1, labels);
    },
    histogramRecord(name, value, labels) {
      getHistogram(name).record(value, labels);
    },
    gaugeSet(name, value, labels) {
      ensureGauge(name);
      gaugeValues.set(name, { value, labels });
    },
  };
}

// ---------------------------------------------------------------------------
// AnalyticsEngineMeterAdapter
// ---------------------------------------------------------------------------

/**
 * Workers Analytics Engine binding shape. Defined here so we don't need
 * `@cloudflare/workers-types` as a dep.
 */
interface AnalyticsEngineDataset {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

export interface AnalyticsEngineMeterAdapterOptions {
  /** Env var name holding the AE binding. Defaults to "DECO_METRICS". */
  bindingName?: string;
  /** Pre-resolved binding (mainly for tests). Bypasses RequestContext lookup. */
  binding?: AnalyticsEngineDataset;
}

/**
 * Writes one Analytics Engine data point per metric call.
 *
 * Schema (must stay stable — dashboards and SQL queries depend on it):
 *  - `indexes[0]`: a low-cardinality dimension. For request metrics that's
 *    the normalized URL path; for cache/resolve metrics that's the metric
 *    name itself.
 *  - `blobs[0]`: metric name (so a single dataset can hold many metrics).
 *  - `blobs[1..]`: stringified label values, in stable label-name order.
 *  - `doubles[0]`: the metric value (count, ms, gauge value).
 *
 * AE truncates / charges per data point, so this adapter is intentionally
 * coarse: one point per `counterInc` / `histogramRecord` / `gaugeSet`.
 */
export function createAnalyticsEngineMeterAdapter(
  options: AnalyticsEngineMeterAdapterOptions = {},
): MeterAdapter {
  const bindingName = options.bindingName ?? "DECO_METRICS";

  function resolveBinding(): AnalyticsEngineDataset | null {
    if (options.binding) return options.binding;
    const env = getRuntimeEnv();
    const b = env?.[bindingName] as AnalyticsEngineDataset | undefined;
    return b ?? null;
  }

  function write(name: string, value: number, labels?: Record<string, unknown>): void {
    const binding = resolveBinding();
    if (!binding) return; // No-op when binding is missing — never throw.

    const indexValue = pickIndex(name, labels);
    const blobs: string[] = [name];
    if (labels) {
      // Stable order — sort keys so the same blob index always means the
      // same label across requests. AE has no schema; we enforce one here.
      const keys = Object.keys(labels).sort();
      for (const k of keys) {
        const v = labels[k];
        if (v !== undefined && v !== null) blobs.push(String(v));
      }
    }

    try {
      binding.writeDataPoint({
        indexes: indexValue ? [indexValue] : undefined,
        blobs,
        doubles: [value],
      });
    } catch {
      /* AE write failed — never fail the request */
    }
  }

  return {
    counterInc(name, value, labels) {
      write(name, value ?? 1, labels);
    },
    histogramRecord(name, value, labels) {
      write(name, value, labels);
    },
    gaugeSet(name, value, labels) {
      write(name, value, labels);
    },
  };
}

function pickIndex(metricName: string, labels?: Record<string, unknown>): string | undefined {
  if (!labels) return metricName;
  // For HTTP request metrics the natural index is the path (matches the
  // plan: `indexes[0]=path`). For other metrics, fall back to the metric
  // name so the dataset is always queryable by index.
  if (
    metricName === MetricNames.HTTP_REQUESTS_TOTAL ||
    metricName === MetricNames.HTTP_REQUEST_DURATION_MS ||
    metricName === MetricNames.HTTP_REQUEST_ERRORS
  ) {
    const p = labels.path;
    if (typeof p === "string" && p.length > 0) return p;
  }
  return metricName;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function joinPath(base: string, path: string): string {
  if (!base) return path;
  if (base.endsWith("/")) base = base.slice(0, -1);
  if (!path.startsWith("/")) path = "/" + path;
  // Already includes the path? Don't double-append.
  if (base.toLowerCase().endsWith(path.toLowerCase())) return base;
  return base + path;
}
