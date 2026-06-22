/**
 * Direct OTLP/HTTP JSON error-log exporter.
 *
 * Errors are too important to leave to head sampling. When CF Destinations'
 * `logs.head_sampling_rate` drops below 1.0 (the cost model in
 * `docs/observability.md` lowers it to `0.01` once this channel lands),
 * a 1%-sampled log pipe would lose 99 of every 100 errors emitted by
 * `logger.error(...)`. Sites lose the one signal they care about most.
 *
 * This adapter solves it by carrying `level: "error"` log records over a
 * separate, framework-controlled pipe direct to `deco-otel-ingest`
 * `/v1/logs`, the same endpoint CF Destinations targets. The two pipes
 * write to the same `otel_logs` table — the ingestor doesn't know or
 * care which transport the record arrived on, and dashboards / SQL
 * queries are unchanged.
 *
 * Design:
 *
 *  - Filters out `debug`/`info`/`warn` upstream of the buffer — only
 *    errors travel through this transport. Calls below "error" are a
 *    no-op on this adapter; the composite logger fans them out to the
 *    default console-JSON adapter which CF Destinations then samples
 *    according to `logs.head_sampling_rate`.
 *  - Per-isolate token-bucket rate limiter prevents log storms (a
 *    pathological error loop blasting 10K errors/sec into the ingestor
 *    would be a self-inflicted denial-of-service against stats-lake).
 *    Default: 100 errors per minute, burst capacity of 20.
 *  - Buffer + flush + cooldown identical to `otelHttpMeter.ts`. The
 *    same `ctx.waitUntil(flush())` in `instrumentWorker` drains both.
 *  - Wire format: OTLP/HTTP JSON `ResourceLogs` payload matching the
 *    shape CF Destinations produces, so the existing ingestor handler
 *    accepts both transports unchanged.
 *
 * Why a separate adapter and not a sampling-bypass flag on
 * `defaultLoggerAdapter`: the default writes via `console.error` which
 * is what CF Destinations samples. Bypassing CF Destinations means
 * NOT writing via `console.*` — a different transport, different
 * code path, different failure modes. Better as a dedicated adapter
 * composed onto the active logger via `createCompositeLogger`.
 */

import { getActiveSpan } from "./observability";
import type { LoggerAdapter, LogLevel } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OtlpHttpLogOptions {
  /** Full OTLP/HTTP JSON logs endpoint, e.g. `https://.../v1/logs`. */
  endpoint: string;
  /** Resource attributes stamped on every payload (service.name etc.). */
  resourceAttributes: Record<string, string>;
  /** Scope name advertised in `scopeLogs[].scope.name`. */
  scopeName?: string;
  /** Scope version. */
  scopeVersion?: string;
  /** Hard cap on pending log records. Default: 500. */
  maxBufferRecords?: number;
  /** Cooldown between successful flushes (ms). Default: 5000. */
  minFlushIntervalMs?: number;
  /** Per-flush HTTP timeout (ms). Default: 5000. */
  flushTimeoutMs?: number;
  /**
   * Token-bucket parameters. The bucket holds up to `burstCapacity`
   * tokens and refills at `refillPerMinute` per minute. Each log record
   * costs one token. When the bucket is empty, records are dropped (with
   * `onError("rate-limit", ...)`) until refill resumes.
   * Defaults: 500 burst, 1000/min — sized for console monkey-patch, which
   * routes ALL console.* (including third-party libs at boot) through this
   * adapter. The old 20/100 defaults were sized for error-only traffic.
   */
  rateLimitBurstCapacity?: number;
  rateLimitRefillPerMinute?: number;
  /**
   * Minimum log level that this adapter forwards to OTLP. Levels below
   * this threshold are silently dropped at ingress. Defaults to `"error"`
   * — production-safe (only errors travel direct-POST; info/warn flow
   * through CF Destinations sampling). Set to `"info"` or `"debug"` in
   * local dev to capture lower-severity logs in the same channel.
   * Resolved from `DECO_OTEL_LOGS_MIN_LEVEL` in `bootObservability`.
   */
  minLevel?: LogLevel;
  /** Test seam — override fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam — override Date.now(). */
  nowMs?: () => number;
  /**
   * Test seam — override getActiveSpan. Production code uses the
   * framework's AsyncLocalStorage-backed getActiveSpan automatically.
   */
  getActiveSpanFn?: () => { spanContext?: () => { traceFlags?: number } } | undefined | null;
  /** Optional sink for transport / rate-limit / overflow errors. */
  onError?: (kind: "flush" | "overflow" | "rate-limit", err: unknown) => void;
}

export interface OtlpHttpLog {
  adapter: LoggerAdapter;
  /** Force a flush, subject to the per-isolate cooldown. */
  flush(): Promise<void>;
  /** Pending log record count. For tests + audit. */
  pendingRecordCount(): number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: string;
  attributes: Record<string, unknown>;
}

// OTel SeverityNumber values, OTel spec. See
// https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber
const SEVERITY_NUMBER: Record<LogLevel, number> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOtlpHttpLogAdapter(options: OtlpHttpLogOptions): OtlpHttpLog {
  const endpoint = options.endpoint;
  const resourceAttributes = options.resourceAttributes;
  const scopeName = options.scopeName ?? "@decocms/start";
  const scopeVersion = options.scopeVersion ?? "";
  const maxBuffer = options.maxBufferRecords ?? 500;
  const minFlushIntervalMs = options.minFlushIntervalMs ?? 5000;
  const flushTimeoutMs = options.flushTimeoutMs ?? 5000;
  const burstCapacity = options.rateLimitBurstCapacity ?? 500;
  const refillPerMinute = options.rateLimitRefillPerMinute ?? 1000;
  const minSeverity = SEVERITY_NUMBER[options.minLevel ?? "warn"];
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.nowMs ?? (() => Date.now());
  const onError = options.onError;
  const getSpan = options.getActiveSpanFn ?? getActiveSpan;

  const buffer: PendingRecord[] = [];
  // Token bucket — starts full.
  let tokens = burstCapacity;
  let tokensLastRefilledAt = now();

  let lastFlushAt = 0;
  let inflight: Promise<void> | null = null;

  function refillTokens(): void {
    const t = now();
    const elapsedMs = t - tokensLastRefilledAt;
    if (elapsedMs <= 0) return;
    // refillPerMinute tokens per 60_000ms.
    const refill = (elapsedMs / 60_000) * refillPerMinute;
    tokens = Math.min(burstCapacity, tokens + refill);
    tokensLastRefilledAt = t;
  }

  function tryConsumeToken(): boolean {
    refillTokens();
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  const adapter: LoggerAdapter = {
    log(level, msg, attrs) {
      // Filter by severity threshold. Levels below minLevel are dropped.
      if (SEVERITY_NUMBER[level] < minSeverity) return;

      // Trace-based sampling for info/debug: only forward when the current
      // request's trace is sampled (W3C traceFlags bit 0x01). This keeps
      // log-trace correlation intact — if you have the trace you have the
      // logs; if the trace was dropped, the info/debug logs have no context
      // and are dropped too. Errors and warnings always pass regardless.
      if (level === "info" || level === "debug") {
        const flags = getSpan()?.spanContext?.()?.traceFlags;
        if (!((flags ?? 0) & 0x01)) return;
      }

      if (!tryConsumeToken()) {
        onError?.(
          "rate-limit",
          new Error(`rate limit exceeded: ${refillPerMinute}/min, burst ${burstCapacity}`),
        );
        return;
      }

      if (buffer.length >= maxBuffer) {
        onError?.(
          "overflow",
          new Error(`error-log buffer at cap (${maxBuffer}) — dropping record`),
        );
        return;
      }

      const t = msToNs(now());
      buffer.push({
        timeUnixNano: t,
        observedTimeUnixNano: t,
        severityNumber: SEVERITY_NUMBER[level],
        severityText: level,
        body: msg,
        attributes: attrs ? { ...attrs } : {},
      });
    },
  };

  async function doFlush(): Promise<void> {
    if (buffer.length === 0) return;
    // Snapshot + remove BEFORE the network call so concurrent records
    // landing during the POST don't get reset on success. On failure we
    // restore the snapshot to the FRONT of the buffer (preserving order
    // and prioritizing the originating-error context). The `maxBuffer`
    // cap on the `log()` path still bounds total memory if the endpoint
    // stays down — newest records are dropped via `onError("overflow")`.
    const snapshot = buffer.splice(0, buffer.length);
    const payload = serializeOtlp(snapshot, {
      resourceAttributes,
      scopeName,
      scopeVersion,
    });

    const restoreOnFailure = () => {
      // The snapshot was buffered BEFORE any records that landed during
      // the failed POST — its contents are older and more likely to be
      // the originating-error context operators care about. Restore
      // policy preserves the snapshot first, evicts the NEWEST records
      // when the cap is tight:
      //
      //  1. If snapshot + current buffer fit under the cap → unshift,
      //     done.
      //  2. Otherwise, drop newest-tail records from the current buffer
      //     (records that arrived during the failed POST). If that
      //     suffices, unshift the full snapshot.
      //  3. Only if the snapshot ALONE exceeds the cap do we truncate
      //     the snapshot — and even then, we keep its OLDEST end
      //     (`snapshot.length = maxBuffer`) and drop the newest tail.
      //
      // This is the inverse of the original (buggy) restore which kept
      // newer records by truncating the older snapshot.
      const total = snapshot.length + buffer.length;
      if (total <= maxBuffer) {
        buffer.unshift(...snapshot);
        return;
      }

      let overflow = total - maxBuffer;
      let droppedFromBuffer = 0;
      if (buffer.length > 0 && overflow > 0) {
        droppedFromBuffer = Math.min(buffer.length, overflow);
        buffer.length -= droppedFromBuffer;
        overflow -= droppedFromBuffer;
      }
      let droppedFromSnapshot = 0;
      if (overflow > 0) {
        // Snapshot alone exceeds the cap. Keep the oldest `maxBuffer`
        // entries and drop the rest from the newest tail.
        droppedFromSnapshot = Math.min(snapshot.length, overflow);
        snapshot.length -= droppedFromSnapshot;
      }
      buffer.unshift(...snapshot);

      const parts = [`dropped ${droppedFromBuffer} newer records from buffer`];
      if (droppedFromSnapshot > 0) {
        parts.push(`${droppedFromSnapshot} newest-tail records from snapshot`);
      }
      onError?.(
        "overflow",
        new Error(
          `error-log buffer overflow on restore — ${parts.join(" and ")} (preserved ${snapshot.length} originating-error records)`,
        ),
      );
    };

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
        restoreOnFailure();
        onError?.("flush", new Error(`POST ${endpoint} → ${res.status}`));
      }
    } catch (err) {
      restoreOnFailure();
      onError?.("flush", err);
    } finally {
      clearTimeout(timer);
    }
  }

  async function flush(): Promise<void> {
    if (inflight) return inflight;

    const elapsed = now() - lastFlushAt;
    const overCap = buffer.length >= maxBuffer;
    if (!overCap && elapsed < minFlushIntervalMs) return;

    inflight = doFlush().finally(() => {
      lastFlushAt = now();
      inflight = null;
    });
    return inflight;
  }

  return {
    adapter,
    flush,
    pendingRecordCount: () => buffer.length,
  };
}

// ---------------------------------------------------------------------------
// OTLP/HTTP JSON serialization
// ---------------------------------------------------------------------------

function msToNs(ms: number): string {
  return `${Math.floor(ms)}000000`;
}

function attrToOtlpValue(
  v: unknown,
):
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean } {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number" && Number.isFinite(v)) {
    if (Number.isInteger(v)) return { intValue: String(v) };
    return { doubleValue: v };
  }
  // Fallback — JSON-stringify so structured attrs round-trip as strings.
  // `JSON.stringify` returns `undefined` for `undefined`, functions, and
  // symbols. OTLP requires `stringValue` to be a string, so coerce with
  // `String(v)` whenever serialization yields nothing parseable.
  try {
    const s = JSON.stringify(v);
    return { stringValue: typeof s === "string" ? s : String(v) };
  } catch {
    return { stringValue: String(v) };
  }
}

interface SerializeOpts {
  resourceAttributes: Record<string, string>;
  scopeName: string;
  scopeVersion: string;
}

function serializeOtlp(records: PendingRecord[], opts: SerializeOpts): { resourceLogs: unknown[] } {
  const otlpRecords = records.map((r) => ({
    timeUnixNano: r.timeUnixNano,
    observedTimeUnixNano: r.observedTimeUnixNano,
    severityNumber: r.severityNumber,
    severityText: r.severityText,
    body: { stringValue: r.body },
    attributes: Object.entries(r.attributes)
      .filter(([_, v]) => v !== undefined && v !== null)
      .map(([k, v]) => ({ key: k, value: attrToOtlpValue(v) })),
  }));

  const resourceAttrs = Object.entries(opts.resourceAttributes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => ({ key: k, value: { stringValue: v } }));

  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttrs },
        scopeLogs: [
          {
            scope: { name: opts.scopeName, version: opts.scopeVersion },
            logRecords: otlpRecords,
          },
        ],
      },
    ],
  };
}
