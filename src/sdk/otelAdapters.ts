/**
 * Metric adapters for `@decocms/start`.
 *
 * The OTLP logger and OTLP meter adapters that lived here through 4.x were
 * removed in 5.0.0. The framework now relies on:
 *  - Cloudflare's platform-managed log capture (`console.*` → CF dashboard
 *    via `observability.logs`) for log shipping
 *  - Cloudflare's auto-instrumented + global-tracer-bridged trace export
 *    (`observability.traces`) for trace shipping
 *  - Workers Analytics Engine — implemented in this file — for metrics
 *
 * Forwarding to a co-deployed OTel collector (the path to ClickHouse)
 * lives in `./otelAdapters/clickhouseCollector.ts`. That file is a
 * documented stub today; the implementation will reintroduce a thin
 * OTLP/HTTP exporter aimed at the collector — never directly at a
 * destination — when the collector is deployed.
 *
 * The `setRuntimeEnv` / `getRuntimeEnv` helpers stay here because
 * `workerEntry.ts` and the AE adapter both depend on them.
 */

import type { MeterAdapter } from "../middleware/observability";
import { MetricNames } from "../middleware/observability";
import { RequestContext } from "./requestContext";

// ---------------------------------------------------------------------------
// Env / binding access
// ---------------------------------------------------------------------------

/**
 * Per-request access to the Cloudflare Worker `env` bag. Stashed by
 * `workerEntry.ts` at the top of every request via
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
// AnalyticsEngineMeterAdapter
// ---------------------------------------------------------------------------

/**
 * Workers Analytics Engine binding shape. Defined here so we don't need
 * `@cloudflare/workers-types` as a dep.
 */
export interface AnalyticsEngineDataset {
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
  // schema: `indexes[0]=path`). For other metrics, fall back to the metric
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
