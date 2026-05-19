/**
 * Observability utilities for deco middleware.
 *
 * Pluggable adapters for tracing (spans) and metrics (counters, gauges,
 * histograms). Works with any backend: OpenTelemetry, Sentry, Datadog, etc.
 *
 * Per-request active spans are propagated via an injectable `RequestStore`
 * — by default an AsyncLocalStorage-backed implementation. Tests can swap
 * it via `setObservabilitySpanStore()` to assert span lifecycle without
 * relying on `node:async_hooks` semantics in the test runner.
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

import * as asyncHooks from "node:async_hooks";

// ---------------------------------------------------------------------------
// RequestStore — minimal per-request context abstraction. Inlined here so
// the observability module has zero cross-package dependencies and tests
// can inject a custom implementation via `setObservabilitySpanStore`.
// ---------------------------------------------------------------------------

export interface RequestStore<T> {
  get(): T | undefined;
  run<R>(value: T, fn: () => R): R;
}

class NoopRequestStore implements RequestStore<unknown> {
  get(): undefined {
    return undefined;
  }
  run<R>(_value: unknown, fn: () => R): R {
    return fn();
  }
}

const noopRequestStore: RequestStore<unknown> = new NoopRequestStore();

class AlsRequestStore<T> implements RequestStore<T> {
  private readonly als:
    | { getStore(): T | undefined; run<R>(store: T, fn: () => R): R }
    | null;
  constructor() {
    const ALS = (asyncHooks as { AsyncLocalStorage?: new <U>() => {
      getStore(): U | undefined;
      run<R>(store: U, fn: () => R): R;
    } }).AsyncLocalStorage;
    this.als = ALS ? new ALS<T>() : null;
  }
  get(): T | undefined {
    return this.als?.getStore();
  }
  run<R>(value: T, fn: () => R): R {
    return this.als ? this.als.run(value, fn) : fn();
  }
}

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

// ---------------------------------------------------------------------------
// Shared module state — pinned to globalThis via Symbol.for so multiple
// inlined copies of this module (one per bundled entry file if/when
// bundling is ever reintroduced) converge on the SAME state. Without this
// indirection, `configureMeter()` from one entry's copy writes to a meter
// that `getMeter()` in another entry's copy never sees, and direct-POST
// telemetry silently no-ops.
//
// Pattern borrowed from @opentelemetry/api / Sentry — both solve the same
// "library with multiple entry exports re-bundles internal state modules"
// problem. Cloudflare Workers guarantee one `globalThis` per isolate, so
// there's no risk of cross-isolate bleed. Defensive against future
// bundling changes; harmless when consumers import from src/ as today.
// ---------------------------------------------------------------------------

interface ObservabilityState {
  tracer: TracerAdapter | null;
  meter: MeterAdapter | null;
  spanStore: RequestStore<Span | null>;
}

const STATE_KEY = Symbol.for("@decocms/start/observability/state.v1");

function getState(): ObservabilityState {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      tracer: null,
      meter: null,
      spanStore: new AlsRequestStore<Span | null>(),
    } satisfies ObservabilityState;
  }
  return g[STATE_KEY] as ObservabilityState;
}

/**
 * Swap the RequestStore used for active-span propagation.
 *
 * Pass `undefined` to reset to the default AsyncLocalStorage-backed store.
 * Primarily intended for tests that need deterministic span access without
 * setting up an actual ALS context.
 */
export function setObservabilitySpanStore(s: RequestStore<Span | null> | undefined): void {
  getState().spanStore = s ?? new AlsRequestStore<Span | null>();
}

export function configureTracer(t: TracerAdapter) {
  getState().tracer = t;
}

export function getTracer(): TracerAdapter | null {
  return getState().tracer;
}

/** Get the currently active span for the current async context, if any. */
export function getActiveSpan(): Span | null {
  return getState().spanStore.get() ?? null;
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
  const s = getState();
  if (!s.tracer) return fn();

  const span = s.tracer.startSpan(name, attributes);

  try {
    const result = await s.spanStore.run(span, fn);
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

export function configureMeter(m: MeterAdapter) {
  getState().meter = m;
}

export function getMeter(): MeterAdapter | null {
  return getState().meter;
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
  const m = getState().meter;
  if (!m) return;
  const labels: Labels = { method, path: normalizePath(path), status };
  m.counterInc(MetricNames.HTTP_REQUESTS_TOTAL, 1, labels);
  m.histogramRecord?.(MetricNames.HTTP_REQUEST_DURATION_MS, durationMs, labels);
  if (status >= 500) {
    m.counterInc(MetricNames.HTTP_REQUEST_ERRORS, 1, labels);
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
 * Record a cache hit/miss metric. Also stamps the decision on the active
 * trace span (when one exists) as `deco.cache.decision` / `deco.cache.profile`
 * so operators can filter ClickStack traces by cache decision directly,
 * without joining to metrics.
 *
 * `decision` is optional — when omitted, the metric still records HIT vs MISS
 * but dashboards can't distinguish SWR/SIE paths. Pass it whenever known.
 */
export function recordCacheMetric(hit: boolean, profile?: string, decision?: CacheDecision) {
  // Stamp on the active span FIRST so the attribute survives even if the
  // meter is a no-op (e.g. on tests, or in dev without DECO_METRICS).
  const active = getActiveSpan();
  if (active) {
    if (decision) active.setAttribute?.("deco.cache.decision", decision);
    if (profile) active.setAttribute?.("deco.cache.profile", profile);
  }

  const m = getState().meter;
  if (!m) return;
  const labels: Labels = {};
  if (profile) labels.profile = profile;
  if (decision) labels.decision = decision;
  m.counterInc(hit ? MetricNames.CACHE_HIT : MetricNames.CACHE_MISS, 1, labels);
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

// noopRequestStore is kept as a no-op fallback for advanced tests; not
// re-exported because consumers should reach for `setObservabilitySpanStore`
// instead.
void noopRequestStore;
