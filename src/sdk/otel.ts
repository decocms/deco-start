/**
 * OpenTelemetry integration for Cloudflare Workers via @microlabs/otel-cf-workers.
 *
 * Opt-in module that wraps a Worker handler with auto-instrumentation and
 * wires traces into @decocms/start's pluggable TracerAdapter.
 *
 * Requires peer dependencies:
 * - `@microlabs/otel-cf-workers`
 * - `@opentelemetry/api`
 *
 * @example
 * ```ts
 * import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
 * import { instrumentWorker } from "@decocms/start/sdk/otel";
 *
 * const handler = createDecoWorkerEntry(serverEntry, options);
 *
 * export default instrumentWorker(handler, { serviceName: "my-store" });
 * ```
 *
 * Environment variables (read from `env` at request time):
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` — OTLP endpoint (e.g. `https://in-otel.hyperdx.io`)
 * - `OTEL_EXPORTER_OTLP_HEADERS` — comma-separated `key=value` auth headers
 */

import { instrument, type ResolveConfigFn } from "@microlabs/otel-cf-workers";
import { trace } from "@opentelemetry/api";
import { configureTracer } from "../middleware/observability";

export interface OtelOptions {
  serviceName: string;
  /** OTLP endpoint. Defaults to env.OTEL_EXPORTER_OTLP_ENDPOINT. */
  endpoint?: string;
  /** OTLP auth headers. Defaults to env.OTEL_EXPORTER_OTLP_HEADERS parsed. */
  headers?: Record<string, string>;
}

/** Minimal Cloudflare Worker execution context. */
interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/** Handler shape returned by createDecoWorkerEntry. */
interface WorkerHandler {
  fetch(
    request: Request,
    env: Record<string, unknown>,
    ctx: WorkerExecutionContext,
  ): Promise<Response>;
}

/**
 * Wraps a Cloudflare Worker handler with OpenTelemetry auto-instrumentation
 * (fetch, KV, D1, waitUntil) and connects to @decocms/start's TracerAdapter
 * so that `withTracing()` / `createInstrumentedFetch()` emit real OTel spans.
 */
export function instrumentWorker(
  handler: WorkerHandler,
  options: OtelOptions | ((env: Record<string, unknown>) => OtelOptions),
) {
  // Bridge @decocms/start TracerAdapter → @opentelemetry/api
  configureTracer({
    startSpan: (name, attrs) => {
      const span = trace.getTracer("deco").startSpan(name, { attributes: attrs });
      return {
        end: () => span.end(),
        setError: (error) => {
          if (error instanceof Error) span.recordException(error);
        },
        setAttribute: (k, v) => span.setAttribute(k, v),
      };
    },
  });

  const resolveConfig: ResolveConfigFn = (env, _trigger) => {
    const opts = typeof options === "function" ? options(env as Record<string, unknown>) : options;
    const endpoint = opts.endpoint || (env.OTEL_EXPORTER_OTLP_ENDPOINT as string);
    const headers = opts.headers || parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS as string | undefined);

    return {
      exporter: { url: endpoint, headers },
      service: { name: opts.serviceName },
    };
  };

  // Cast through `any` — @microlabs/otel-cf-workers expects Cloudflare's
  // ExportedHandler type, but we avoid depending on @cloudflare/workers-types.
  // deno-lint-ignore no-explicit-any
  return instrument(handler as any, resolveConfig);
}

function parseHeaders(str?: string): Record<string, string> {
  if (!str) return {};
  return Object.fromEntries(
    str.split(",").map((kv) => {
      const [k, ...v] = kv.split("=");
      return [k.trim(), v.join("=").trim()];
    }),
  );
}
