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

import { getActiveSpan } from "./observability";
import { RequestContext } from "./requestContext";

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

// ---------------------------------------------------------------------------
// Shared module state — pinned to globalThis via Symbol.for so multiple
// inlined copies of this module (one per bundled entry file in dist/) all
// converge on the SAME state. See the matching comment in
// `observability.ts` for the rationale — `configureLogger()` from one
// entry file's copy of this module would otherwise write to an
// `activeAdapter` that `logger.error()` in another entry's copy never
// reads, and direct-POST error-log capture silently no-ops.
// ---------------------------------------------------------------------------

interface LoggerState {
  activeAdapter: LoggerAdapter;
  minLevel: LogLevel;
  attributeFloor: Record<string, unknown>;
}

const STATE_KEY = Symbol.for("@decocms/start/logger/state.v1");

function getState(): LoggerState {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      activeAdapter: defaultLoggerAdapter,
      minLevel: "info" as LogLevel,
      attributeFloor: {},
    } satisfies LoggerState;
  }
  return g[STATE_KEY] as LoggerState;
}

/**
 * Replace the active logger adapter.
 * Call once at worker boot from `instrumentWorker()`.
 */
export function configureLogger(adapter: LoggerAdapter): void {
  getState().activeAdapter = adapter;
}

/**
 * Replace the per-record attribute floor — keys here will be added to
 * every log line UNLESS the caller passes the same key in their `attrs`
 * (caller wins). Set once at worker boot from `instrumentWorker()`.
 *
 * Used to stamp `deco.runtime.version`, `deco.apps.version`,
 * `deployment.environment` on every log so HyperDX panels filtering on
 * these dimensions keep working under Cloudflare-managed log export
 * (which otherwise strips our resource attributes — only the JSON record
 * body survives).
 */
export function setLoggerAttributeFloor(attrs: Record<string, unknown>): void {
  getState().attributeFloor = { ...attrs };
}

/**
 * Test-only: read the current attribute floor. Do not call from app code.
 */
export function _getLoggerAttributeFloorForTests(): Record<string, unknown> {
  return { ...getState().attributeFloor };
}

/**
 * Get the current active logger adapter (for tests / advanced wiring).
 */
export function getLoggerAdapter(): LoggerAdapter {
  return getState().activeAdapter;
}

/**
 * Set the minimum log level. Calls below this level are dropped before
 * reaching any adapter — useful to silence `debug` in production.
 *
 * Defaults to `info`. Override per environment via `setLogLevel("debug")`
 * or by reading an env var at boot.
 */
export function setLogLevel(level: LogLevel): void {
  getState().minLevel = level;
}

export function getLogLevel(): LogLevel {
  return getState().minLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[getState().minLevel];
}

// ---------------------------------------------------------------------------
// Public logger surface
// ---------------------------------------------------------------------------

/**
 * Strict structured logger. Mirrors `@deco/deco/o11y`:
 *  - first arg is a human-readable message string
 *  - optional second arg is a flat attributes object
 *
 * Adapters decide the destination (stdout JSON, OTLP, both, …). The
 * contract is intentionally narrow so structured output stays predictable
 * across all sinks.
 *
 * @example
 * ```ts
 * logger.info("checkout started", { orderFormId, items });
 * logger.warn("retrying vtex call", { attempt, host });
 *
 * // For Errors, serialize explicitly into the attrs payload:
 * try { ... } catch (err) {
 *   const e = serializeError(err);
 *   logger.error(e.message, { error: e, stage: "checkout" });
 * }
 * ```
 */
export interface Logger {
  debug(msg: string, attrs?: Record<string, unknown>): void;
  info(msg: string, attrs?: Record<string, unknown>): void;
  warn(msg: string, attrs?: Record<string, unknown>): void;
  error(msg: string, attrs?: Record<string, unknown>): void;
}

/**
 * Normalised, JSON-safe error shape suitable for inclusion in logger
 * attributes. `serializeError` always returns this shape regardless of
 * what was thrown.
 */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

/**
 * Convert any thrown value into a flat, structured object that survives
 * `JSON.stringify` and round-trips cleanly to OTel / Cloudflare Logs.
 * Strict logger sites should call this from their catch blocks rather
 * than passing the Error directly.
 *
 * @example
 * ```ts
 * try { ... } catch (err) {
 *   const e = serializeError(err);
 *   logger.error(e.message, { error: e });
 * }
 * ```
 */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  if (err && typeof err === "object") {
    let body: string;
    try {
      body = JSON.stringify(err);
    } catch {
      body = String(err);
    }
    return { name: "NonError", message: body };
  }
  return { name: "NonError", message: String(err) };
}

function emit(level: LogLevel, msg: string, attrs?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  // Pull trace context from the active span so every log line correlates
  // to its trace in ClickStack/HyperDX. No active span → no-op; caller
  // attrs always win so explicit `trace_id` overrides keep working.
  const ctx = getActiveSpan()?.spanContext?.();
  // Pull request.id from the AsyncLocalStorage-backed RequestContext so
  // every log line in the request also carries the join key used by
  // direct-POST metrics + tail-worker rows. Single read, no allocation
  // when outside a request scope.
  const requestId = RequestContext.requestId;
  const requestAttrs: Record<string, unknown> | undefined =
    ctx || requestId
      ? {
          ...(ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {}),
          ...(requestId ? { "request.id": requestId } : {}),
        }
      : undefined;
  // Merge order: floor → trace / request context → caller attrs. Caller
  // wins; the request-scoped context only overrides floor keys (which
  // never set `trace_id` / `request.id` anyway).
  const s = getState();
  const hasFloor = Object.keys(s.attributeFloor).length > 0;
  let merged: Record<string, unknown> | undefined;
  if (!hasFloor && !requestAttrs && !attrs) {
    merged = undefined;
  } else {
    merged = {
      ...(hasFloor ? s.attributeFloor : {}),
      ...(requestAttrs ?? {}),
      ...(attrs ?? {}),
    };
  }
  try {
    s.activeAdapter.log(level, msg, merged);
  } catch {
    // Adapter blew up. Fall back to default so we don't lose the line.
    if (s.activeAdapter !== defaultLoggerAdapter) {
      try {
        defaultLoggerAdapter.log(level, msg, merged);
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
