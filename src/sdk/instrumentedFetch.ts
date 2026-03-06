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

import { getTracer } from "../middleware/observability";

export interface FetchInstrumentationOptions {
  /** Tag for log/trace grouping (e.g., "vtex", "shopify"). */
  name: string;
  /** Enable request/response logging. Default: true in development. */
  logging?: boolean;
  /** Enable tracing via the configured TracerAdapter. Default: true. */
  tracing?: boolean;
  /** Callback when a request completes (for custom metrics). */
  onComplete?: (info: FetchMetrics) => void;
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
    typeof nameOrOptions === "string"
      ? { name: nameOrOptions }
      : nameOrOptions;

  const { name, logging = isDev, tracing = true, onComplete } = options;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || "GET";
    const startTime = performance.now();

    const doFetch = async (): Promise<Response> => {
      if (logging) {
        console.log(`[${name}] ${method} ${truncateUrl(url)}`);
      }

      const response = await globalThis.fetch(input, init);
      const durationMs = performance.now() - startTime;
      const cached = response.headers.get("x-cache") === "HIT";

      if (logging) {
        const color = response.ok ? "\x1b[32m" : "\x1b[31m";
        console.log(
          `[${name}] ${color}${response.status}\x1b[0m ${method} ${truncateUrl(url)} ${durationMs.toFixed(0)}ms${cached ? " (cached)" : ""}`,
        );
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
 * Wraps an existing commerce client's fetch calls by monkey-patching
 * the fetch function it uses. For clients that expose `fetch` as a param.
 */
export function instrumentFetch(
  originalFetch: typeof fetch,
  name: string,
): typeof fetch {
  const instrumented = createInstrumentedFetch(name);
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    return instrumented(input, init);
  }) as typeof fetch;
}
