/**
 * Observability utilities for deco middleware.
 *
 * Pluggable adapters for tracing (spans) and metrics (counters, gauges,
 * histograms). Works with any backend: OpenTelemetry, Sentry, Datadog, etc.
 *
 * @example
 * ```ts
 * import { configureTracer, configureMeter } from "@decocms/start/middleware";
 * import { trace, metrics } from "@opentelemetry/api";
 *
 * configureTracer({
 *   startSpan: (name, attrs) => {
 *     const span = trace.getTracer("deco").startSpan(name, { attributes: attrs });
 *     return {
 *       end: () => span.end(),
 *       setError: (e) => span.recordException(e),
 *       setAttribute: (k, v) => span.setAttribute(k, v),
 *     };
 *   },
 * });
 *
 * configureMeter({
 *   counterInc: (name, value, labels) => metrics.getMeter("deco").createCounter(name).add(value, labels),
 *   histogramRecord: (name, value, labels) => metrics.getMeter("deco").createHistogram(name).record(value, labels),
 * });
 * ```
 */

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

import * as asyncHooks from "node:async_hooks";

export interface Span {
  end(): void;
  setError?(error: unknown): void;
  setAttribute?(key: string, value: string | number | boolean): void;
}

export interface TracerAdapter {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): Span;
}

let tracer: TracerAdapter | null = null;

// Per-request active span stored in AsyncLocalStorage so concurrent requests
// cannot overwrite each other's span when `withTracing` awaits async work.
// The namespace import + runtime guard mirrors loader.ts to stay safe in client builds.
const ALS = (asyncHooks as any).AsyncLocalStorage as
  | (new <T>() => { getStore(): T | undefined; run<R>(store: T, fn: () => R): R })
  | undefined;
const spanStorage: {
  getStore(): Span | null | undefined;
  run<R>(store: Span | null, fn: () => R): R;
} = ALS ? new ALS<Span | null>() : { getStore: () => undefined, run: (_s: any, fn: any) => fn() };

export function configureTracer(t: TracerAdapter) {
  tracer = t;
}

export function getTracer(): TracerAdapter | null {
  return tracer;
}

/** Get the currently active span for the current async context, if any. */
export function getActiveSpan(): Span | null {
  return spanStorage.getStore() ?? null;
}

/** Set an attribute on the active span, if one exists. */
export function setSpanAttribute(key: string, value: string | number | boolean) {
  getActiveSpan()?.setAttribute?.(key, value);
}

export async function withTracing<T>(
  name: string,
  fn: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  if (!tracer) return fn();

  const span = tracer.startSpan(name, attributes);

  try {
    const result = await spanStorage.run(span, fn);
    span.end();
    return result;
  } catch (error) {
    span.setError?.(error);
    span.end();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------

type Labels = Record<string, string | number | boolean>;

export interface MeterAdapter {
  counterInc(name: string, value?: number, labels?: Labels): void;
  gaugeSet?(name: string, value: number, labels?: Labels): void;
  histogramRecord?(name: string, value: number, labels?: Labels): void;
}

let meter: MeterAdapter | null = null;

export function configureMeter(m: MeterAdapter) {
  meter = m;
}

export function getMeter(): MeterAdapter | null {
  return meter;
}

/** Pre-defined metric names for consistency. */
export const MetricNames = {
  HTTP_REQUESTS_TOTAL: "http_requests_total",
  HTTP_REQUEST_DURATION_MS: "http_request_duration_ms",
  HTTP_REQUEST_ERRORS: "http_request_errors_total",
  CACHE_HIT: "cache_hit_total",
  CACHE_MISS: "cache_miss_total",
  RESOLVE_DURATION_MS: "resolve_duration_ms",
  FETCH_DURATION_MS: "fetch_duration_ms",
} as const;

/**
 * Record an HTTP request metric.
 * Call in middleware after the response is produced.
 */
export function recordRequestMetric(
  method: string,
  path: string,
  status: number,
  durationMs: number,
) {
  if (!meter) return;
  const labels: Labels = { method, path: normalizePath(path), status };
  meter.counterInc(MetricNames.HTTP_REQUESTS_TOTAL, 1, labels);
  meter.histogramRecord?.(MetricNames.HTTP_REQUEST_DURATION_MS, durationMs, labels);
  if (status >= 500) {
    meter.counterInc(MetricNames.HTTP_REQUEST_ERRORS, 1, labels);
  }
}

/**
 * Record a cache hit/miss metric.
 */
export function recordCacheMetric(hit: boolean, profile?: string) {
  if (!meter) return;
  const labels: Labels = profile ? { profile } : {};
  meter.counterInc(hit ? MetricNames.CACHE_HIT : MetricNames.CACHE_MISS, 1, labels);
}

function normalizePath(path: string): string {
  // Collapse dynamic segments to reduce cardinality
  return path
    .replace(/\/[0-9a-f]{8,}/gi, "/:id")
    .replace(/\/\d+/g, "/:id")
    .replace(/\/[^/]+\/p$/, "/:slug/p");
}

// ---------------------------------------------------------------------------
// Request logging
// ---------------------------------------------------------------------------

const isDev =
  typeof globalThis.process !== "undefined" && globalThis.process.env?.NODE_ENV === "development";

/**
 * Structured request log entry.
 * JSON in production, colorized in development.
 * Includes traceId when available.
 */
export function logRequest(
  request: Request,
  status: number,
  durationMs: number,
  extra?: Record<string, unknown>,
) {
  const url = new URL(request.url);

  if (isDev) {
    const color = status >= 500 ? "\x1b[31m" : status >= 400 ? "\x1b[33m" : "\x1b[32m";
    const extraStr = extra ? ` ${JSON.stringify(extra)}` : "";
    console.log(
      `${color}${request.method}\x1b[0m ${url.pathname} ${status} ${durationMs.toFixed(0)}ms${extraStr}`,
    );
  } else {
    console.log(
      JSON.stringify({
        level: status >= 500 ? "error" : "info",
        method: request.method,
        path: url.pathname,
        status,
        durationMs: Math.round(durationMs),
        timestamp: new Date().toISOString(),
        ...extra,
      }),
    );
  }
}
