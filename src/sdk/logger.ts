/**
 * Pluggable structured logger for @decocms/start.
 *
 * Mirrors the public shape of `@deco/deco/o11y` logger so site code that
 * does `logger.info("...", { key: "value" })` keeps working unchanged
 * after the Fresh → TanStack migration.
 *
 * Backed by a `LoggerAdapter`. The default adapter writes one JSON line
 * to `console.log` per call — that line is what Cloudflare Logs / Logpush
 * captures, so logging works out of the box on Workers without any
 * additional configuration.
 *
 * To dual-emit to OTLP (HyperDX, etc.), wrap the default with
 * `createCompositeLogger([defaultLoggerAdapter, otelLoggerAdapter])`
 * inside `instrumentWorker()`.
 *
 * @example
 * ```ts
 * import { logger } from "@decocms/start/sdk/logger";
 *
 * logger.info("checkout started", { orderFormId, items: cart.items.length });
 * logger.warn("retrying vtex call", { attempt, host });
 * logger.error("payment failed", { reason, code, traceId });
 * ```
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LoggerAdapter {
  log(level: LogLevel, msg: string, attrs?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Default adapter — structured JSON to console.log
// ---------------------------------------------------------------------------

/**
 * Cloudflare-Logs-friendly default. One JSON object per call, on stdout.
 * Always safe to use — never throws, never depends on env, never makes
 * a network call.
 */
export const defaultLoggerAdapter: LoggerAdapter = {
  log(level, msg, attrs) {
    const payload: Record<string, unknown> = {
      level,
      msg,
      timestamp: new Date().toISOString(),
    };
    if (attrs) {
      // Spread last so explicit attrs win over our defaults except
      // for `level` / `msg` / `timestamp` which we always want canonical.
      for (const [k, v] of Object.entries(attrs)) {
        if (k !== "level" && k !== "msg" && k !== "timestamp") {
          payload[k] = v;
        }
      }
    }
    // Route by level so Cloudflare's log dashboard colorises correctly.
    const fn =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : level === "debug"
            ? console.debug
            : console.log;
    try {
      fn(JSON.stringify(payload));
    } catch {
      // Last-resort: fall back to plain string. Never crash the request
      // because of a circular-ref or non-serialisable attribute.
      fn(`${level} ${msg}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Configurable global state
// ---------------------------------------------------------------------------

let activeAdapter: LoggerAdapter = defaultLoggerAdapter;
let minLevel: LogLevel = "info";

/**
 * Replace the active logger adapter.
 * Call once at worker boot from `instrumentWorker()`.
 */
export function configureLogger(adapter: LoggerAdapter): void {
  activeAdapter = adapter;
}

/**
 * Get the current active logger adapter (for tests / advanced wiring).
 */
export function getLoggerAdapter(): LoggerAdapter {
  return activeAdapter;
}

/**
 * Set the minimum log level. Calls below this level are dropped before
 * reaching any adapter — useful to silence `debug` in production.
 *
 * Defaults to `info`. Override per environment via `setLogLevel("debug")`
 * or by reading an env var at boot.
 */
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function getLogLevel(): LogLevel {
  return minLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[minLevel];
}

// ---------------------------------------------------------------------------
// Public logger surface
// ---------------------------------------------------------------------------

/**
 * Mirrors `@deco/deco/o11y` logger:
 *  - first arg is the message
 *  - optional second arg is a flat attributes object
 *
 * Adapters decide the destination (stdout JSON, OTLP, both, …).
 */
export interface Logger {
  debug(msg: string, attrs?: Record<string, unknown>): void;
  info(msg: string, attrs?: Record<string, unknown>): void;
  warn(msg: string, attrs?: Record<string, unknown>): void;
  error(msg: string, attrs?: Record<string, unknown>): void;
}

function emit(level: LogLevel, msg: string, attrs?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  try {
    activeAdapter.log(level, msg, attrs);
  } catch {
    // Adapter blew up. Fall back to default so we don't lose the line.
    if (activeAdapter !== defaultLoggerAdapter) {
      try {
        defaultLoggerAdapter.log(level, msg, attrs);
      } catch {
        /* swallow */
      }
    }
  }
}

export const logger: Logger = {
  debug: (msg, attrs) => emit("debug", msg, attrs),
  info: (msg, attrs) => emit("info", msg, attrs),
  warn: (msg, attrs) => emit("warn", msg, attrs),
  error: (msg, attrs) => emit("error", msg, attrs),
};

export default logger;
