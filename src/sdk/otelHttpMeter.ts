/**
 * OTLP/HTTP JSON metrics exporter — direct POST from a Cloudflare Worker
 * to `deco-otel-ingest` `/v1/metrics`.
 *
 * Why direct POST and not Cloudflare Destinations? CF Destinations supports
 * OTLP for `logs` and `traces` only; there is no `observability.metrics`
 * block. Metrics travel from the site Worker to the ingestor over a normal
 * outbound `fetch`. Sub-requests are free on the paid plan, and the
 * ingestor's per-POST charge is captured in the cost model in
 * `docs/observability.md`.
 *
 * **Aggregation model.** Buffers are per-isolate, accumulated forever (until
 * the isolate dies), and exported with `AggregationTemporality = CUMULATIVE`
 * (matching the `clickhouseexporter` schema used by the ingestor's
 * `otel_metrics_{sum,gauge,histogram}` tables).
 *
 * **Flush triggers.**
 *  1. `flush()` — caller-driven, used by `workerEntry` inside
 *     `ctx.waitUntil(...)` at request end. Throttled by `minFlushIntervalMs`
 *     per-isolate so a 1000-req/s isolate doesn't fire 1000 POSTs/s.
 *  2. Buffer-size cap — when total pending datapoints exceeds
 *     `maxBufferDatapoints`, the next `flush()` ignores the cooldown.
 *  3. Worker isolate shutdown — there is no "before-shutdown" hook on
 *     Workers; instead, every request's `ctx.waitUntil(flush())` keeps the
 *     buffer drained to roughly within one cooldown window of real time.
 *
 * **Data loss profile.** Documented in `docs/observability.md` under
 * "Worker isolate lifecycle". Worst case is the cooldown window of
 * datapoints lost on isolate teardown — for `minFlushIntervalMs: 5000`,
 * that's ≤ 5s of metrics from one isolate. At fleet scale this is well
 * under the 0.01% loss budget we agreed on.
 */

import type { MeterAdapter } from "./observability";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Labels = Record<string, string | number | boolean>;

export interface OtlpHttpMeterOptions {
  /** Full OTLP/HTTP JSON metrics endpoint, e.g. `https://.../v1/metrics`. */
  endpoint: string;
  /** Resource attributes stamped on every OTLP payload (service.name etc.). */
  resourceAttributes: Record<string, string>;
  /** Scope name advertised in `scopeMetrics[].scope.name`. */
  scopeName?: string;
  /** Scope version. */
  scopeVersion?: string;
  /**
   * Explicit histogram bounds. Default targets HTTP/sub-fetch latency in ms.
   * Datapoints below the first bound land in bucket 0; above the last bound
   * in the overflow bucket (length = bounds.length + 1).
   */
  histogramBounds?: number[];
  /** Hard cap on pending datapoints across all metric kinds. Default: 2000. */
  maxBufferDatapoints?: number;
  /** Cooldown between successful flushes (ms). Default: 5000. */
  minFlushIntervalMs?: number;
  /** Per-flush HTTP timeout (ms). Default: 5000. */
  flushTimeoutMs?: number;
  /**
   * Extra HTTP headers merged into every OTLP POST (e.g. `Authorization: Bearer …`).
   * `Content-Type: application/json` is always set and cannot be overridden here.
   */
  headers?: Record<string, string>;
  /**
   * Test seam — override fetch for the flush path so unit tests can
   * inspect the OTLP payload without going to the network.
   */
  fetchImpl?: typeof fetch;
  /**
   * Test seam — override Date.now() for deterministic timestamps in
   * snapshot tests.
   */
  nowMs?: () => number;
  /** Optional sink for transport errors so callers can surface them. */
  onError?: (kind: "flush" | "overflow" | "kind-mismatch", err: unknown) => void;
  /**
   * Per-metric metadata emitted in the OTLP payload's `description` and
   * `unit` fields. Looked up by metric name at flush time. Names absent
   * from the map flush with empty description/unit (still valid OTLP).
   * The framework owns the lookup; callers MUST NOT pass metadata at
   * record time. See `MetricNames` / `METRIC_METADATA` in
   * `middleware/observability.ts`.
   */
  metricMetadata?: Record<string, { description?: string; unit?: string }>;
}

export interface OtlpHttpMeter extends MeterAdapter {
  /** Always defined on this adapter — declared required to drop the `?.` at call sites. */
  gaugeSet(name: string, value: number, labels?: Labels): void;
  /** Always defined on this adapter — declared required to drop the `?.` at call sites. */
  histogramRecord(name: string, value: number, labels?: Labels): void;
  /** Force a flush, subject to the per-isolate cooldown. */
  flush(): Promise<void>;
  /** Pending datapoint count across all metric kinds. For tests + audit. */
  pendingDatapointCount(): number;
}

// ---------------------------------------------------------------------------
// Internal buffer shapes
// ---------------------------------------------------------------------------

type MetricKind = "counter" | "gauge" | "histogram";

interface CounterPoint {
  value: number;
  attrs: Labels;
  startTimeUnixNano: string;
}
interface GaugePoint {
  value: number;
  attrs: Labels;
  timeUnixNano: string;
}
interface HistogramPoint {
  count: number;
  sum: number;
  min: number;
  max: number;
  bucketCounts: number[];
  attrs: Labels;
  startTimeUnixNano: string;
}

interface MetricEntry {
  kind: MetricKind;
  counter?: Map<string, CounterPoint>;
  gauge?: Map<string, GaugePoint>;
  histogram?: Map<string, HistogramPoint>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_HISTOGRAM_BOUNDS = [
  // ms — tuned for HTTP/sub-fetch latency. Coarser bounds than VTEX-specific
  // commerce histograms; sites that need finer buckets can register their
  // own histogram bounds in a follow-up.
  5, 10, 25, 50, 75, 100, 250, 500, 1000,
];

export function createOtlpHttpMeterAdapter(options: OtlpHttpMeterOptions): OtlpHttpMeter {
  const endpoint = options.endpoint;
  const resourceAttributes = options.resourceAttributes;
  const scopeName = options.scopeName ?? "@decocms/start";
  const scopeVersion = options.scopeVersion ?? "";
  const histogramBounds = options.histogramBounds ?? DEFAULT_HISTOGRAM_BOUNDS;
  const maxBuffer = options.maxBufferDatapoints ?? 2000;
  const minFlushIntervalMs = options.minFlushIntervalMs ?? 5000;
  const flushTimeoutMs = options.flushTimeoutMs ?? 5000;
  const extraHeaders = options.headers ?? {};
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.nowMs ?? (() => Date.now());
  const onError = options.onError;
  const metricMetadata = options.metricMetadata ?? {};

  // Buffer state — per-isolate, never reset (CUMULATIVE temporality).
  const metrics = new Map<string, MetricEntry>();
  // Isolate boot wall-clock — counters/histograms anchor their startTime here.
  const isolateStartMs = now();
  // Per-isolate flush throttle.
  let lastFlushAt = 0;
  let inflight: Promise<void> | null = null;

  function attrKey(attrs?: Labels): string {
    if (!attrs) return "";
    const keys = Object.keys(attrs).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = attrs[k];
      if (v === undefined || v === null) continue;
      parts.push(`${k}=${String(v)}`);
    }
    return parts.join("\u0001");
  }

  /**
   * Look up an existing entry without creating one. The two helpers below
   * (`checkAdmissibility`, `materializeEntry`) split what was a single
   * `getOrCreate` so the overflow check can run BEFORE we materialize a
   * new entry — otherwise a dropped datapoint leaves a permanent empty
   * `MetricEntry` in the `metrics` map that gets serialized as an empty
   * OTLP envelope each flush, inflating payloads and leaking memory.
   */
  function checkAdmissibility(
    name: string,
    kind: MetricKind,
  ): { entry: MetricEntry | null; isNewName: boolean } {
    const existing = metrics.get(name);
    if (!existing) return { entry: null, isNewName: true };
    if (existing.kind !== kind) {
      onError?.(
        "kind-mismatch",
        new Error(`metric "${name}" already registered as ${existing.kind}`),
      );
      return { entry: null, isNewName: false };
    }
    return { entry: existing, isNewName: false };
  }

  function materializeEntry(name: string, kind: MetricKind): MetricEntry {
    const entry: MetricEntry = { kind };
    if (kind === "counter") entry.counter = new Map();
    else if (kind === "gauge") entry.gauge = new Map();
    else entry.histogram = new Map();
    metrics.set(name, entry);
    return entry;
  }

  function pendingDatapointCount(): number {
    let n = 0;
    for (const entry of metrics.values()) {
      if (entry.counter) n += entry.counter.size;
      if (entry.gauge) n += entry.gauge.size;
      if (entry.histogram) n += entry.histogram.size;
    }
    return n;
  }

  function counterInc(name: string, value = 1, labels?: Labels) {
    const { entry: existing, isNewName } = checkAdmissibility(name, "counter");
    if (existing === null && !isNewName) return; // kind mismatch
    const key = attrKey(labels);
    const isNewDatapoint = !existing?.counter?.has(key);
    if (isNewDatapoint && pendingDatapointCount() >= maxBuffer) {
      onError?.("overflow", new Error(`metric buffer at cap (${maxBuffer}) — dropping "${name}"`));
      return;
    }
    const entry = existing ?? materializeEntry(name, "counter");
    if (!entry.counter) return;
    let point = entry.counter.get(key);
    if (!point) {
      point = {
        value: 0,
        attrs: labels ? { ...labels } : {},
        startTimeUnixNano: msToNs(isolateStartMs),
      };
      entry.counter.set(key, point);
    }
    point.value += value;
  }

  function gaugeSet(name: string, value: number, labels?: Labels) {
    const { entry: existing, isNewName } = checkAdmissibility(name, "gauge");
    if (existing === null && !isNewName) return; // kind mismatch
    const key = attrKey(labels);
    const isNewDatapoint = !existing?.gauge?.has(key);
    if (isNewDatapoint && pendingDatapointCount() >= maxBuffer) {
      onError?.("overflow", new Error(`metric buffer at cap (${maxBuffer}) — dropping "${name}"`));
      return;
    }
    const entry = existing ?? materializeEntry(name, "gauge");
    if (!entry.gauge) return;
    entry.gauge.set(key, {
      value,
      attrs: labels ? { ...labels } : {},
      timeUnixNano: msToNs(now()),
    });
  }

  function histogramRecord(name: string, value: number, labels?: Labels) {
    const { entry: existing, isNewName } = checkAdmissibility(name, "histogram");
    if (existing === null && !isNewName) return; // kind mismatch
    const key = attrKey(labels);
    const isNewDatapoint = !existing?.histogram?.has(key);
    if (isNewDatapoint && pendingDatapointCount() >= maxBuffer) {
      onError?.("overflow", new Error(`metric buffer at cap (${maxBuffer}) — dropping "${name}"`));
      return;
    }
    const entry = existing ?? materializeEntry(name, "histogram");
    if (!entry.histogram) return;
    let point = entry.histogram.get(key);
    if (!point) {
      point = {
        count: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        bucketCounts: new Array(histogramBounds.length + 1).fill(0),
        attrs: labels ? { ...labels } : {},
        startTimeUnixNano: msToNs(isolateStartMs),
      };
      entry.histogram.set(key, point);
    }
    point.count += 1;
    point.sum += value;
    if (value < point.min) point.min = value;
    if (value > point.max) point.max = value;
    // Locate bucket. histogramBounds is small (<=20); linear scan is fine.
    let bucketIdx = histogramBounds.length;
    for (let i = 0; i < histogramBounds.length; i++) {
      if (value <= histogramBounds[i]) {
        bucketIdx = i;
        break;
      }
    }
    point.bucketCounts[bucketIdx] += 1;
  }

  async function doFlush(): Promise<void> {
    if (metrics.size === 0) return;

    const flushAtNs = msToNs(now());
    const payload = serializeOtlp(metrics, {
      resourceAttributes,
      scopeName,
      scopeVersion,
      histogramBounds,
      flushAtNs,
      metricMetadata,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), flushTimeoutMs);
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { ...extraHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Drain the body so the underlying connection can be reused, then
        // surface as a flush error. Don't throw — flush failures must never
        // surface on the request hot path.
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
    // If a flush is in flight, reuse it — concurrent requests should not
    // pile up POSTs. The in-flight POST already snapshotted the buffer at
    // its enqueue time; new datapoints land in the buffer and will go out
    // on the next flush.
    if (inflight) return inflight;

    const elapsed = now() - lastFlushAt;
    const overCap = pendingDatapointCount() >= maxBuffer;
    if (!overCap && elapsed < minFlushIntervalMs) {
      // Cooldown not elapsed and buffer is not at the cap — skip.
      return;
    }

    inflight = doFlush().finally(() => {
      lastFlushAt = now();
      inflight = null;
    });
    return inflight;
  }

  return {
    counterInc,
    gaugeSet,
    histogramRecord,
    flush,
    pendingDatapointCount,
  };
}

// ---------------------------------------------------------------------------
// OTLP/HTTP JSON serialization
// ---------------------------------------------------------------------------

function msToNs(ms: number): string {
  // OTLP wants nanoseconds-since-epoch as a string (uint64). Workers don't
  // give us better than ms precision in `Date.now()`; we pad with zeros.
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
  histogramBounds: number[];
  flushAtNs: string;
  metricMetadata: Record<string, { description?: string; unit?: string }>;
}

function serializeOtlp(
  metrics: Map<string, MetricEntry>,
  opts: SerializeOpts,
): { resourceMetrics: unknown[] } {
  const otlpMetrics: unknown[] = [];

  for (const [name, entry] of metrics) {
    const meta = opts.metricMetadata[name];
    const description = meta?.description ?? "";
    const unit = meta?.unit ?? "";
    if (entry.kind === "counter" && entry.counter) {
      const dataPoints: unknown[] = [];
      for (const point of entry.counter.values()) {
        dataPoints.push({
          attributes: attrsToOtlp(point.attrs),
          startTimeUnixNano: point.startTimeUnixNano,
          timeUnixNano: opts.flushAtNs,
          asDouble: point.value,
        });
      }
      otlpMetrics.push({
        name,
        description,
        unit,
        sum: {
          aggregationTemporality: 2, // CUMULATIVE
          isMonotonic: true,
          dataPoints,
        },
      });
    } else if (entry.kind === "gauge" && entry.gauge) {
      const dataPoints: unknown[] = [];
      for (const point of entry.gauge.values()) {
        dataPoints.push({
          attributes: attrsToOtlp(point.attrs),
          timeUnixNano: point.timeUnixNano,
          asDouble: point.value,
        });
      }
      otlpMetrics.push({
        name,
        description,
        unit,
        gauge: { dataPoints },
      });
    } else if (entry.kind === "histogram" && entry.histogram) {
      const dataPoints: unknown[] = [];
      for (const point of entry.histogram.values()) {
        dataPoints.push({
          attributes: attrsToOtlp(point.attrs),
          startTimeUnixNano: point.startTimeUnixNano,
          timeUnixNano: opts.flushAtNs,
          count: String(point.count),
          sum: point.sum,
          min: point.min === Number.POSITIVE_INFINITY ? 0 : point.min,
          max: point.max === Number.NEGATIVE_INFINITY ? 0 : point.max,
          bucketCounts: point.bucketCounts.map((c) => String(c)),
          explicitBounds: opts.histogramBounds,
        });
      }
      otlpMetrics.push({
        name,
        description,
        unit,
        histogram: {
          aggregationTemporality: 2, // CUMULATIVE
          dataPoints,
        },
      });
    }
  }

  const resourceAttrs: Array<{
    key: string;
    value: { stringValue: string };
  }> = [];
  for (const k of Object.keys(opts.resourceAttributes).sort()) {
    resourceAttrs.push({ key: k, value: { stringValue: opts.resourceAttributes[k] } });
  }

  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttrs },
        scopeMetrics: [
          {
            scope: { name: opts.scopeName, version: opts.scopeVersion },
            metrics: otlpMetrics,
          },
        ],
      },
    ],
  };
}
