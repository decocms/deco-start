/**
 * Composite adapters — fan out to multiple backends with try/catch isolation.
 *
 * Used by `instrumentWorker()` so the same logger/meter can dual-emit to
 * (e.g.) console-JSON + OTLP, or AE + OTLP, without any one backend's
 * failure taking down the others.
 *
 * The "always include console-JSON logger" guarantee in the observability
 * plan relies on this: even if HyperDX is down, the local console adapter
 * still records the line.
 */

import type { MeterAdapter } from "../../tanstack/middleware/observability";
import type { LoggerAdapter, LogLevel } from "./logger";

type Labels = Record<string, string | number | boolean>;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Returns a single LoggerAdapter that fans every call out to all
 * provided adapters. Falsy entries (e.g. `otelEnabled ? otelAdapter : null`)
 * are filtered out so call sites can write:
 *
 * ```ts
 * createCompositeLogger([defaultLoggerAdapter, otelEnabled ? otelLogger : null]);
 * ```
 *
 * Each downstream `.log()` call is isolated in try/catch so a thrown
 * error in one backend cannot suppress the others.
 */
export function createCompositeLogger(
  adapters: Array<LoggerAdapter | null | undefined | false>,
): LoggerAdapter {
  const list = adapters.filter((a): a is LoggerAdapter => Boolean(a));

  if (list.length === 1) return list[0];

  return {
    log(level: LogLevel, msg: string, attrs?: Record<string, unknown>) {
      for (const adapter of list) {
        try {
          adapter.log(level, msg, attrs);
        } catch (error) {
          // Use console.error directly — calling logger here would recurse.
          try {
            console.error("[composite-logger] adapter failed", String(error));
          } catch {
            /* swallow */
          }
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------

/**
 * Returns a single MeterAdapter that fans counter/gauge/histogram writes
 * out to all provided meters. Same semantics as `createCompositeLogger`:
 * falsy entries are dropped, each downstream call is try/catch isolated.
 */
export function createCompositeMeter(
  adapters: Array<MeterAdapter | null | undefined | false>,
): MeterAdapter {
  const list = adapters.filter((a): a is MeterAdapter => Boolean(a));

  if (list.length === 1) return list[0];

  return {
    counterInc(name: string, value?: number, labels?: Labels) {
      for (const m of list) {
        try {
          m.counterInc(name, value, labels);
        } catch (error) {
          warn("counterInc", name, error);
        }
      }
    },
    gaugeSet(name: string, value: number, labels?: Labels) {
      for (const m of list) {
        if (!m.gaugeSet) continue;
        try {
          m.gaugeSet(name, value, labels);
        } catch (error) {
          warn("gaugeSet", name, error);
        }
      }
    },
    histogramRecord(name: string, value: number, labels?: Labels) {
      for (const m of list) {
        if (!m.histogramRecord) continue;
        try {
          m.histogramRecord(name, value, labels);
        } catch (error) {
          warn("histogramRecord", name, error);
        }
      }
    },
  };
}

function warn(op: string, metric: string, error: unknown) {
  try {
    console.error(`[composite-meter] ${op}(${metric}) adapter failed`, String(error));
  } catch {
    /* swallow */
  }
}
