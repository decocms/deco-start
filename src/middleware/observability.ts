/**
 * Observability utilities for deco middleware.
 *
 * These are thin wrappers that storefronts compose into their own
 * `createMiddleware()` chain. They work with any tracing backend
 * (Sentry, OpenTelemetry, Datadog) through a pluggable adapter.
 *
 * @example
 * ```ts
 * import { createMiddleware } from "@tanstack/react-start";
 * import { requestLogger, configureTracer } from "@decocms/start/middleware/observability";
 *
 * // Optional: plug in OTel
 * import { trace } from "@opentelemetry/api";
 * configureTracer({
 *   startSpan: (name, attrs) => {
 *     const span = trace.getTracer("deco").startSpan(name, { attributes: attrs });
 *     return { end: () => span.end(), setError: (e) => span.recordException(e) };
 *   },
 * });
 * ```
 */

export interface TracerAdapter {
  startSpan(
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): { end(): void; setError?(error: unknown): void };
}

let tracer: TracerAdapter | null = null;

/** Configure a tracer adapter (OTel, Sentry, etc.). */
export function configureTracer(t: TracerAdapter) {
  tracer = t;
}

/** Get the configured tracer, if any. */
export function getTracer(): TracerAdapter | null {
  return tracer;
}

/**
 * Wraps a function with tracing (if a tracer is configured).
 * Falls back to just calling the function if no tracer is set.
 */
export async function withTracing<T>(
  name: string,
  fn: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  if (!tracer) return fn();

  const span = tracer.startSpan(name, attributes);
  try {
    const result = await fn();
    span.end();
    return result;
  } catch (error) {
    span.setError?.(error);
    span.end();
    throw error;
  }
}

/**
 * Structured request log entry for server-side logging.
 * Outputs JSON in production, human-readable in development.
 */
export function logRequest(
  request: Request,
  status: number,
  durationMs: number,
) {
  const url = new URL(request.url);
  const isDev =
    typeof process !== "undefined" && process.env.NODE_ENV === "development";

  if (isDev) {
    const color = status >= 500 ? "\x1b[31m" : status >= 400 ? "\x1b[33m" : "\x1b[32m";
    console.log(
      `${color}${request.method}\x1b[0m ${url.pathname} ${status} ${durationMs.toFixed(0)}ms`,
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
      }),
    );
  }
}
