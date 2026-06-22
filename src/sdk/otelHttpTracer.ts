/**
 * OTLP/HTTP JSON trace exporter — direct POST from a Cloudflare Worker
 * to `deco-otel-ingest` `/v1/traces`.
 *
 * Mirrors `otelHttpMeter.ts` in shape: per-isolate buffer, flush via
 * `ctx.waitUntil` at request end, cooldown + buffer cap.
 *
 * **Why direct POST instead of CF Destinations + `@opentelemetry/api` bridge.**
 * The bridge tracer in `otel.ts` delegates to `trace.getTracer(...)`. Without
 * a registered `TracerProvider`, that's a no-op proxy and every framework
 * `deco.*` span we create silently disappears. Empirical verification (May
 * 2026) on prod sites confirmed: zero `deco.*` rows in `otel_traces` despite
 * `withTracing` being called on every request. This adapter ships those
 * spans direct-POST, same channel as metrics + error logs.
 *
 * **Sampling.** Consistent per-trace decision via FNV-1a hash of the
 * trace-id. Caller passes `headSamplingRate` (default 0.01 = 1%) to match
 * the CF Destinations `traces.head_sampling_rate` default and keep volume
 * within budget. Parent-based override: if an incoming W3C `traceparent`
 * header carried `flags=01` (sampled), every span in that trace is
 * exported regardless of the rate.
 *
 * **Buffer.** Spans are buffered per-isolate until `flush()` ships them.
 * Unlike metrics (CUMULATIVE temporality, lifelong buffer), traces are
 * one-shot per span: buffer drains on flush and starts empty for the next
 * window. Cap (`maxBufferSpans`) protects against runaway trace volume.
 *
 * **Parent linkage.** `startSpan` reads the active span from a caller-
 * supplied accessor (`getActiveSpanForParent`) — the framework wires this
 * to `getActiveSpan` from `middleware/observability.ts` so child spans
 * inherit `trace_id` + record `parent_span_id` automatically. Root spans
 * (no active parent) consult `getRequestTraceContext` to pick up the
 * incoming W3C traceparent, or generate a fresh trace.
 */

import type { Span, TracerAdapter } from "../middleware/observability";

// ---------------------------------------------------------------------------
// W3C traceparent parsing
// ---------------------------------------------------------------------------

/**
 * Trace context lifted from an inbound W3C `traceparent` header (RFC
 * tracecontext, `version-traceId-parentId-flags`). `remoteParent: true`
 * indicates the parent span lives in another service.
 */
export interface TraceContext {
  traceId: string;
  parentSpanId: string;
  /** Parent's `traceFlags & 0x01` — the W3C "sampled" bit. */
  sampled: boolean;
  /** True when the context came from an inbound header (remote parent). */
  remoteParent: boolean;
}

/**
 * Parse a W3C `traceparent` value. Returns `null` on any structural
 * violation, including the well-known all-zero IDs (which OTel treats
 * as invalid — see W3C tracecontext §3.2.2).
 */
export function parseTraceparent(value: string | null | undefined): TraceContext | null {
  if (!value) return null;
  const parts = value.split("-");
  if (parts.length !== 4) return null;
  const [version, traceId, parentId, flags] = parts;
  if (version !== "00") return null;
  if (!/^[0-9a-f]{32}$/.test(traceId)) return null;
  if (traceId === "0".repeat(32)) return null;
  if (!/^[0-9a-f]{16}$/.test(parentId)) return null;
  if (parentId === "0".repeat(16)) return null;
  if (!/^[0-9a-f]{2}$/.test(flags)) return null;
  const sampled = (Number.parseInt(flags, 16) & 0x01) === 0x01;
  return { traceId, parentSpanId: parentId, sampled, remoteParent: true };
}

// ---------------------------------------------------------------------------
// ID generation + sampling
// ---------------------------------------------------------------------------

function randomHex(bytes: number): string {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    let out = "";
    for (let i = 0; i < buf.length; i++) {
      out += buf[i].toString(16).padStart(2, "0");
    }
    return out;
  }
  // Fallback for runtimes without crypto.getRandomValues (tests, some
  // sandboxes). Lower-entropy but the function still satisfies the
  // length contract — collisions in this branch are operational
  // breadcrumbs, not a security threat.
  let out = "";
  while (out.length < bytes * 2) {
    out += Math.floor(Math.random() * 0xffff)
      .toString(16)
      .padStart(4, "0");
  }
  return out.slice(0, bytes * 2);
}

export function newTraceId(): string {
  return randomHex(16);
}

export function newSpanId(): string {
  return randomHex(8);
}

/**
 * FNV-1a 32-bit hash over the trace ID (hex string). Cheap, dependency-
 * free, and produces a uniform distribution over 32-bit unsigned ints —
 * good enough for consistent head sampling.
 */
function hashTraceId(traceId: string): number {
  let h = 2166136261;
  for (let i = 0; i < traceId.length; i++) {
    h ^= traceId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Consistent head-sampling decision: every span in a trace gets the same
 * answer because the input is `traceId`, not `spanId`. Caller is
 * responsible for parent-based overrides (see `shouldExportSpan`).
 */
export function shouldSampleTrace(traceId: string, rate: number): boolean {
  if (!Number.isFinite(rate) || rate >= 1) return true;
  if (rate <= 0) return false;
  return hashTraceId(traceId) / 0xffffffff < rate;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Labels = Record<string, string | number | boolean>;

/** OTel `SpanKind` enum. We only ever emit INTERNAL spans. */
const SPAN_KIND_INTERNAL = 1;
/** OTel `StatusCode.OK` = 1, `ERROR` = 2 (and `UNSET` = 0). */
const STATUS_OK = 1;
const STATUS_ERROR = 2;

interface SpanEvent {
  name: string;
  timeUnixNano: string;
  attributes: Labels;
}

interface SpanRecord {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Labels;
  events: SpanEvent[];
  status: { code: number; message: string };
}

export interface OtlpHttpTracerOptions {
  /** Full OTLP/HTTP JSON traces endpoint, e.g. `https://.../v1/traces`. */
  endpoint: string;
  /** Resource attributes stamped on every OTLP payload (service.name etc.). */
  resourceAttributes: Record<string, string>;
  /** Scope name advertised in `scopeSpans[].scope.name`. */
  scopeName?: string;
  /** Scope version. */
  scopeVersion?: string;
  /**
   * Head sampling rate, 0.0..1.0. Default 0.01 to match the
   * CF Destinations `traces.head_sampling_rate` recommendation. Set to
   * 1 to capture every trace; set to 0 to disable export entirely.
   *
   * Decisions are consistent per trace (FNV-1a hash of the trace ID),
   * so a `deco.cms.resolvePage` child span is sampled iff the
   * `deco.http.request` root for the same trace is sampled.
   */
  headSamplingRate?: number;
  /** Hard cap on pending spans. Default: 2000. */
  maxBufferSpans?: number;
  /** Cooldown between successful flushes (ms). Default: 5000. */
  minFlushIntervalMs?: number;
  /** Per-flush HTTP timeout (ms). Default: 5000. */
  flushTimeoutMs?: number;
  /**
   * Test seam — override `fetch` for the flush path. Same role as in
   * `otelHttpMeter.ts`.
   */
  fetchImpl?: typeof fetch;
  /** Test seam — override `Date.now()` for deterministic timestamps. */
  nowMs?: () => number;
  /** Optional sink for transport errors. */
  onError?: (kind: "flush" | "overflow", err: unknown) => void;
  /**
   * Accessor for the currently-active span at the moment `startSpan` is
   * called. The framework wires this to `getActiveSpan()` from
   * `middleware/observability.ts` so child spans inherit `trace_id` and
   * record `parent_span_id`. Returns `null` for root spans.
   */
  getActiveSpanForParent: () => Span | null;
  /**
   * Accessor for the per-request trace context (parsed from inbound
   * `traceparent`). Read at root-span creation time so we honor remote
   * parents and the `sampled` flag.
   */
  getRequestTraceContext?: () => TraceContext | null;
}

export interface OtlpHttpTracer extends TracerAdapter {
  /** Drain the buffer (subject to cooldown). */
  flush(): Promise<void>;
  /** For tests + the audit channel. */
  pendingSpanCount(): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOtlpHttpTracerAdapter(options: OtlpHttpTracerOptions): OtlpHttpTracer {
  const endpoint = options.endpoint;
  const resourceAttributes = options.resourceAttributes;
  const scopeName = options.scopeName ?? "@decocms/start";
  const scopeVersion = options.scopeVersion ?? "";
  const headSamplingRate = options.headSamplingRate ?? 0.01;
  const maxBuffer = options.maxBufferSpans ?? 2000;
  const minFlushIntervalMs = options.minFlushIntervalMs ?? 5000;
  const flushTimeoutMs = options.flushTimeoutMs ?? 5000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.nowMs ?? (() => Date.now());
  const onError = options.onError;
  const getActiveSpanForParent = options.getActiveSpanForParent;
  const getRequestTraceContext = options.getRequestTraceContext;

  // Buffer of completed spans waiting to ship. Sampling decision is taken
  // at span-end (not span-start) so attribute mutations during the span
  // lifetime are captured in the record we drop or keep.
  const spans: SpanRecord[] = [];
  let lastFlushAt = 0;
  let inflight: Promise<void> | null = null;

  function pendingSpanCount(): number {
    return spans.length;
  }

  function startSpan(name: string, attributes?: Labels): Span {
    const parent = getActiveSpanForParent();
    const parentCtx = parent?.spanContext?.();

    // Inherit trace ID from the parent (in-process or remote). Only root
    // spans with no parent context generate a fresh trace ID.
    const remoteCtx = parentCtx ? null : (getRequestTraceContext?.() ?? null);
    const traceId = parentCtx?.traceId ?? remoteCtx?.traceId ?? newTraceId();
    const parentSpanId = parentCtx?.spanId ?? remoteCtx?.parentSpanId ?? "";

    // Sampling decision at startSpan() — OTel-spec-compliant. Setting
    // traceFlags here (not at end()) means spanContext().traceFlags is
    // correct during the entire span lifetime, which lets the log adapter
    // use it for trace-based log sampling.
    //
    // Priority:
    //  1. Remote parent sampled=true  → always sample (join external traces)
    //  2. Remote parent sampled=false → don't sample (honor external decision)
    //  3. In-process parent → inherit its traceFlags (consistent per-trace)
    //  4. Root span, no parent → FNV-1a hash of traceId vs headSamplingRate
    const sampled: boolean =
      remoteCtx !== null
        ? remoteCtx.sampled
        : parentCtx != null
          ? (parentCtx.traceFlags & 0x01) === 0x01
          : shouldSampleTrace(traceId, headSamplingRate);
    const traceFlags = sampled ? 0x01 : 0x00;

    const spanId = newSpanId();
    const startTimeNs = msToNs(now());
    const record: SpanRecord = {
      name,
      traceId,
      spanId,
      parentSpanId,
      startTimeUnixNano: startTimeNs,
      endTimeUnixNano: startTimeNs, // overwritten on end()
      attributes: { ...(attributes ?? {}) },
      events: [],
      status: { code: 0, message: "" },
    };

    let ended = false;

    return {
      end(): void {
        if (ended) return;
        ended = true;
        record.endTimeUnixNano = msToNs(now());

        // Sampling decision was already made at startSpan() — traceFlags
        // carries the result. Child spans inherit it from their parent so
        // the entire trace is kept or dropped consistently.
        if (!sampled) return;

        if (spans.length >= maxBuffer) {
          onError?.("overflow", new Error(`trace buffer at cap (${maxBuffer}) — dropping span`));
          return;
        }
        spans.push(record);
      },
      setError(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        record.status = { code: STATUS_ERROR, message };
        record.attributes["exception.type"] =
          error instanceof Error ? error.constructor.name : "unknown";
        record.attributes["exception.message"] = message;
        if (error instanceof Error && error.stack) {
          record.attributes["exception.stacktrace"] = error.stack;
        }
        record.events.push({
          name: "exception",
          timeUnixNano: msToNs(now()),
          attributes: {
            "exception.type":
              error instanceof Error ? error.constructor.name : "unknown",
            "exception.message": message,
            ...(error instanceof Error && error.stack
              ? { "exception.stacktrace": error.stack }
              : {}),
          },
        });
      },
      setAttribute(key: string, value: string | number | boolean): void {
        record.attributes[key] = value;
        // Status promotion driven by http.status_code:
        //   < 400 → OK   (explicit success so dashboards don't show UNSET)
        //   ≥ 400 → ERROR (upstream returned an error; fetch() itself didn't
        //           throw, so the catch path never ran — this is the only
        //           place we can promote the status correctly)
        if (key === "http.status_code" && typeof value === "number") {
          if (value < 400 && record.status.code === 0) {
            record.status = { code: STATUS_OK, message: "" };
          } else if (value >= 400) {
            record.status = { code: STATUS_ERROR, message: `HTTP ${value}` };
          }
        }
      },
      spanContext(): { traceId: string; spanId: string; traceFlags: number } {
        return { traceId, spanId, traceFlags };
      },
    };
  }

  async function doFlush(): Promise<void> {
    if (spans.length === 0) return;

    // Snapshot + reset buffer before the network call so concurrent
    // span ends during the POST land in the next window.
    const batch = spans.splice(0, spans.length);

    const payload = serializeOtlpTraces(batch, {
      resourceAttributes,
      scopeName,
      scopeVersion,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), flushTimeoutMs);
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        try {
          await res.text();
        } catch {
          /* swallow */
        }
        onError?.("flush", new Error(`POST ${endpoint} → ${res.status}`));
      }
    } catch (err) {
      onError?.("flush", err);
    } finally {
      clearTimeout(timer);
    }
  }

  async function flush(): Promise<void> {
    if (inflight) return inflight;
    const elapsed = now() - lastFlushAt;
    const overCap = spans.length >= maxBuffer;
    if (!overCap && elapsed < minFlushIntervalMs) return;
    inflight = doFlush().finally(() => {
      lastFlushAt = now();
      inflight = null;
    });
    return inflight;
  }

  return {
    startSpan,
    flush,
    pendingSpanCount,
  };
}

// ---------------------------------------------------------------------------
// OTLP/HTTP JSON serialization for traces
// ---------------------------------------------------------------------------

function msToNs(ms: number): string {
  return `${Math.floor(ms)}000000`;
}

function attrsToOtlp(attrs: Labels): Array<{
  key: string;
  value:
    | { stringValue: string }
    | { intValue: string }
    | { doubleValue: number }
    | { boolValue: boolean };
}> {
  const out: ReturnType<typeof attrsToOtlp> = [];
  for (const k of Object.keys(attrs).sort()) {
    const v = attrs[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") out.push({ key: k, value: { stringValue: v } });
    else if (typeof v === "boolean") out.push({ key: k, value: { boolValue: v } });
    else if (Number.isInteger(v)) out.push({ key: k, value: { intValue: String(v) } });
    else out.push({ key: k, value: { doubleValue: v } });
  }
  return out;
}

interface SerializeOpts {
  resourceAttributes: Record<string, string>;
  scopeName: string;
  scopeVersion: string;
}

function serializeOtlpTraces(
  batch: SpanRecord[],
  opts: SerializeOpts,
): { resourceSpans: unknown[] } {
  const otlpSpans = batch.map((s) => ({
    traceId: s.traceId,
    spanId: s.spanId,
    parentSpanId: s.parentSpanId,
    name: s.name,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: s.startTimeUnixNano,
    endTimeUnixNano: s.endTimeUnixNano,
    attributes: attrsToOtlp(s.attributes),
    status: {
      code: s.status.code,
      ...(s.status.message ? { message: s.status.message } : {}),
    },
    events: s.events.map((e) => ({
      timeUnixNano: e.timeUnixNano,
      name: e.name,
      attributes: attrsToOtlp(e.attributes),
    })),
  }));

  const resourceAttrs: Array<{ key: string; value: { stringValue: string } }> = [];
  for (const k of Object.keys(opts.resourceAttributes).sort()) {
    resourceAttrs.push({ key: k, value: { stringValue: opts.resourceAttributes[k] } });
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [
          {
            scope: { name: opts.scopeName, version: opts.scopeVersion },
            spans: otlpSpans,
          },
        ],
      },
    ],
  };
}

/**
 * Test seam: internals exposed for unit tests only. Never use from app
 * code — the surface is unstable and might change between minor releases.
 */
export const _internals = {
  parseTraceparent,
  shouldSampleTrace,
  newTraceId,
  newSpanId,
};
