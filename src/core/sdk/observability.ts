/**
 * Observability utilities for deco middleware.
 *
 * Pluggable adapters for tracing (spans) and metrics (counters, gauges,
 * histograms). Works with any backend: OpenTelemetry, Sentry, Datadog, etc.
 *
 * **Framework-agnostic.** This file lives in `core/` and never imports
 * `node:async_hooks` directly. Hosts that want AsyncLocalStorage-backed
 * span propagation install one via `setObservabilitySpanStore()` (see
 * `tanstack/runtime/alsRequestStore.ts`). When no store is installed,
 * spans still work — they just don't propagate across `await` boundaries
 * inside `withTracing`, which is acceptable for hosts that don't need it.
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

import { noopRequestStore, type RequestStore } from "../runtime/requestStore";

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

export interface Span {
  end(): void;
  setError?(error: unknown): void;
  setAttribute?(key: string, value: string | number | boolean): void;
  /**
   * Return W3C trace context for the current span. Used by helpers that
   * need to correlate logs to traces (`logger`) or propagate context to
   * downstream services (`injectTraceContext`). Optional — adapters that
   * can't expose it simply leave it off and callers no-op gracefully.
   */
  spanContext?(): { traceId: string; spanId: string; traceFlags: number };
}

export interface TracerAdapter {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): Span;
}

let tracer: TracerAdapter | null = null;

// Per-request active span propagation. Hosts that want AsyncLocalStorage
// semantics call `setObservabilitySpanStore` with an ALS-backed store; the
// default is a noop store, which means `withTracing` still records spans
// but `getActiveSpan()` returns null outside the immediate sync frame.
let spanStore: RequestStore<Span | null> = noopRequestStore as RequestStore<Span | null>;

/**
 * Install the runtime-specific RequestStore for active-span propagation.
 *
 * Pass `undefined` to reset to the noop store (useful in tests).
 */
export function setObservabilitySpanStore(s: RequestStore<Span | null> | undefined): void {
  spanStore = s ?? (noopRequestStore as RequestStore<Span | null>);
}

export function configureTracer(t: TracerAdapter) {
  tracer = t;
}

export function getTracer(): TracerAdapter | null {
  return tracer;
}

/** Get the currently active span for the current async context, if any. */
export function getActiveSpan(): Span | null {
  return spanStore.get() ?? null;
}

/** Set an attribute on the active span, if one exists. */
export function setSpanAttribute(key: string, value: string | number | boolean) {
  getActiveSpan()?.setAttribute?.(key, value);
}

/**
 * Inject the active span's W3C trace context into outbound request headers
 * as a `traceparent` header (RFC W3C-tracecontext format
 * `version-traceId-parentId-flags`). Call this from outbound `fetch`
 * wrappers (e.g. `createInstrumentedFetch` in `@decocms/apps`) so upstream
 * services that participate in OTel can correlate their spans with ours.
 *
 * No-op when no active span exists, when the active span has no
 * `spanContext()` adapter method, or when the trace/span IDs aren't
 * populated. Never throws.
 *
 * @example
 * ```ts
 * import { injectTraceContext } from "@decocms/start/sdk/observability";
 *
 * async function tracedFetch(url: string, init?: RequestInit) {
 *   const headers = new Headers(init?.headers);
 *   injectTraceContext(headers);
 *   return fetch(url, { ...init, headers });
 * }
 * ```
 */
export function injectTraceContext(headers: Headers): void {
  const ctx = getActiveSpan()?.spanContext?.();
  if (!ctx || !ctx.traceId || !ctx.spanId) return;
  const flags = (ctx.traceFlags & 0xff).toString(16).padStart(2, "0");
  headers.set("traceparent", `00-${ctx.traceId}-${ctx.spanId}-${flags}`);
}

export async function withTracing<T>(
  name: string,
  fn: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  if (!tracer) return fn();

  const span = tracer.startSpan(name, attributes);

  try {
    const result = await spanStore.run(span, fn);
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
 * Cache decision label. Mirrors the `X-Cache` response header we set in
 * `workerEntry.ts` so dashboards can join on it.
 *  - `HIT`         — fresh entry returned from cache
 *  - `STALE-HIT`   — stale entry served, async revalidation kicked off (SWR)
 *  - `STALE-ERROR` — stale entry served because origin errored (SIE)
 *  - `MISS`        — cache lookup returned nothing, origin fetched
 *  - `BYPASS`      — request not eligible for caching (private, cookies, etc.)
 */
export type CacheDecision = "HIT" | "STALE-HIT" | "STALE-ERROR" | "MISS" | "BYPASS";

/**
 * Record a cache hit/miss metric.
 *
 * `decision` is optional — when omitted, the metric still records HIT vs MISS
 * but dashboards can't distinguish SWR/SIE paths. Pass it whenever known.
 */
export function recordCacheMetric(hit: boolean, profile?: string, decision?: CacheDecision) {
  if (!meter) return;
  const labels: Labels = {};
  if (profile) labels.profile = profile;
  if (decision) labels.decision = decision;
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
    const ctx = getActiveSpan()?.spanContext?.();
    console.log(
      JSON.stringify({
        level: status >= 500 ? "error" : "info",
        method: request.method,
        path: url.pathname,
        status,
        durationMs: Math.round(durationMs),
        timestamp: new Date().toISOString(),
        ...(ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {}),
        ...extra,
      }),
    );
  }
}
