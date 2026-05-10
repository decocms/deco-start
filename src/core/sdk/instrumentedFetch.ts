/**
 * Instrumented fetch wrapper that adds logging and tracing to outbound HTTP calls.
 *
 * Designed to be wired into commerce clients (VTEX, Shopify) so all
 * API calls become visible in dev logs and production traces.
 *
 * @example
 * ```ts
 * import { createInstrumentedFetch } from "@decocms/start/sdk/instrumentedFetch";
 *
 * const vtexFetch = createInstrumentedFetch("vtex");
 *
 * // Use it instead of global fetch:
 * const response = await vtexFetch("https://account.vtexcommercestable.com.br/api/...");
 * ```
 */

import { getTracer } from "../../tanstack/middleware/observability";
import { logger } from "./logger";

/**
 * Cloudflare / VTEX response headers that operators want to see as span
 * attributes when debugging cache behavior. Mirrors `applyCustomAttributesOnSpan`
 * in `deco-cx/deco/observability/otel/`.
 */
const CACHE_HEADERS_TO_SPAN: Array<{ header: string; attr: string }> = [
  { header: "cf-cache-status", attr: "cf.cache.status" },
  { header: "cf-ray", attr: "cf.ray" },
  { header: "x-vtex-io-cluster-id", attr: "vtex.io.cluster.id" },
  { header: "x-edge-cache-status", attr: "edge.cache.status" },
];

const TRUE_LITERAL = "true";

function envFlag(name: string): boolean {
  const env = typeof globalThis.process !== "undefined" ? globalThis.process.env : undefined;
  return env?.[name] === TRUE_LITERAL;
}

export interface FetchInstrumentationOptions {
  /** Tag for log/trace grouping (e.g., "vtex", "shopify"). */
  name: string;
  /** Enable request/response logging. Default: true in development. */
  logging?: boolean;
  /** Enable tracing via the configured TracerAdapter. Default: true. */
  tracing?: boolean;
  /** Callback when a request completes (for custom metrics). */
  onComplete?: (info: FetchMetrics) => void;
  /**
   * Underlying fetch implementation to wrap. Defaults to `globalThis.fetch`.
   * Use this when the client already has a custom fetch (e.g. with cookies,
   * custom headers, or a proxy) that must be preserved.
   */
  baseFetch?: typeof fetch;
}

export interface FetchMetrics {
  name: string;
  url: string;
  method: string;
  status: number;
  durationMs: number;
  cached: boolean;
}

const isDev =
  typeof globalThis.process !== "undefined" && globalThis.process.env?.NODE_ENV === "development";

/**
 * Creates a fetch wrapper that instruments all requests for a given integration.
 */
export function createInstrumentedFetch(
  nameOrOptions: string | FetchInstrumentationOptions,
): typeof fetch {
  const options: FetchInstrumentationOptions =
    typeof nameOrOptions === "string" ? { name: nameOrOptions } : nameOrOptions;

  const {
    name,
    logging = isDev,
    tracing = true,
    onComplete,
    baseFetch = globalThis.fetch,
  } = options;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || "GET";
    const startTime = performance.now();

    const doFetch = async (): Promise<Response> => {
      if (logging) {
        console.log(`[${name}] ${method} ${truncateUrl(url)}`);
      }

      const response = await baseFetch(input, init);
      const durationMs = performance.now() - startTime;
      const cached = response.headers.get("x-cache") === "HIT";

      if (logging) {
        const color = response.ok ? "\x1b[32m" : "\x1b[31m";
        console.log(
          `[${name}] ${color}${response.status}\x1b[0m ${method} ${truncateUrl(url)} ${durationMs.toFixed(0)}ms${cached ? " (cached)" : ""}`,
        );
      }

      // Structured outgoing-fetch breadcrumb. Same field shape as the Fresh
      // `@deco/deco/o11y` impl so log pipelines built off the old stack
      // keep working unchanged. Off by default to avoid log explosion;
      // enable with `OTEL_LOG_OUTGOING_FETCH=true`.
      if (envFlag("OTEL_LOG_OUTGOING_FETCH")) {
        let host = "";
        let path = "";
        try {
          const u = new URL(url);
          host = u.host;
          path = u.pathname;
        } catch {
          /* unparseable URL — leave host/path blank */
        }
        logger.info("outgoing fetch", {
          app: name,
          host,
          path,
          method,
          status: response.status,
          ok: response.ok,
          durationMs: Math.round(durationMs),
          cached,
        });
      }

      onComplete?.({
        name,
        url,
        method,
        status: response.status,
        durationMs,
        cached,
      });

      return response;
    };

    if (tracing) {
      const tracer = getTracer();
      if (tracer) {
        const span = tracer.startSpan(`${name}.fetch`, {
          "http.method": method,
          "http.url": url,
          "fetch.integration": name,
        });

        try {
          const response = await doFetch();
          // Promote CF / VTEX cache headers as span attributes — the plan
          // calls out these four. `@microlabs/otel-cf-workers` does not
          // expose the response inside its own fetch span lifecycle, so
          // capturing them here on our wrapper span is the practical
          // place to do it.
          for (const { header, attr } of CACHE_HEADERS_TO_SPAN) {
            const value = response.headers.get(header);
            if (value) span.setAttribute?.(attr, value);
          }
          span.setAttribute?.("http.status_code", response.status);
          span.end();
          return response;
        } catch (error) {
          span.setError?.(error);
          span.end();
          throw error;
        }
      }
    }

    return doFetch();
  };
}

function truncateUrl(url: string, maxLen = 120): string {
  if (url.length <= maxLen) return url;
  return url.slice(0, maxLen - 3) + "...";
}

/**
 * Wraps an existing fetch function with logging and tracing instrumentation.
 * Unlike `createInstrumentedFetch`, this preserves the original fetch's
 * behavior (custom headers, cookies, proxy logic) and adds observability on top.
 */
export function instrumentFetch(originalFetch: typeof fetch, name: string): typeof fetch {
  return createInstrumentedFetch({ name, baseFetch: originalFetch });
}
