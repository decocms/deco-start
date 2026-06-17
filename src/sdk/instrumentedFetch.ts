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

import { logger } from "./logger";
import { getTracer, injectTraceContext } from "./observability";
import { redactUrl } from "./urlRedaction";

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
  /**
   * Query parameter names whose value should NOT be redacted in logs +
   * span attributes. Default: empty — every value is redacted. Use for
   * structural params that don't carry secrets, e.g. `["page", "sort"]`.
   * See `redactUrl` in `./urlRedaction.ts`.
   */
  keepQueryKeys?: ReadonlyArray<string>;
  /**
   * Inject the active span's W3C `traceparent` header onto outbound
   * requests so downstream services that participate in OTel can join
   * our trace. Default: true. Set to false for calls to endpoints that
   * reject unknown headers (rare).
   */
  injectTraceparent?: boolean;
  /**
   * Fallback operation name used when a call doesn't supply one via
   * `init.operation`. Span name becomes `${name}.${defaultOperation}`.
   * Useful when a client is single-purpose, e.g. a Resend client where
   * every call is the literal `"emails.send"`. Default: not set (the
   * resolver below runs next, then the literal `"fetch"`).
   */
  defaultOperation?: string;
  /**
   * URL-derived operation router. Called when neither `init.operation`
   * nor `defaultOperation` is set. Receives the rawUrl + method, returns
   * an operation string or `undefined` to opt out (in which case the
   * span falls back to `${name}.fetch`). Centralizes the long-tail of
   * commerce endpoints that don't merit a hand-authored operation name
   * at the call site while staying visibly debuggable in spans.
   *
   * Resolution precedence:
   *   `init.operation` ?? `defaultOperation` ?? `resolveOperation(url, method)` ?? `"fetch"`
   */
  resolveOperation?: (url: string, method: string) => string | undefined;
}

export interface FetchMetrics {
  name: string;
  url: string;
  method: string;
  status: number;
  durationMs: number;
  cached: boolean;
  /** Resolved operation name (post-precedence-resolution). */
  operation: string;
}

/**
 * Init shape accepted by an instrumented fetch. Strictly a superset of
 * `RequestInit` (the only extra property is optional), so an
 * `InstrumentedFetch` is assignable wherever a `typeof fetch` is
 * expected — existing callers that don't author an operation string
 * keep compiling unchanged.
 */
export type InstrumentedFetchInit = RequestInit & {
  /**
   * Per-call operation override. Produces a span named
   * `${name}.${operation}` instead of the default `${name}.fetch`.
   * Stripped from the init before reaching `baseFetch` so it never
   * surfaces to the network as a request property.
   */
  operation?: string;
};

/**
 * Fetch with an optional per-call `operation` extension on init. Returned
 * by `createInstrumentedFetch`. Assignable to `typeof fetch` because the
 * extra property is optional.
 */
export type InstrumentedFetch = (
  input: RequestInfo | URL,
  init?: InstrumentedFetchInit,
) => Promise<Response>;

const isDev =
  typeof globalThis.process !== "undefined" && globalThis.process.env?.NODE_ENV === "development";

/**
 * Creates a fetch wrapper that instruments all requests for a given integration.
 */
export function createInstrumentedFetch(
  nameOrOptions: string | FetchInstrumentationOptions,
): InstrumentedFetch {
  const options: FetchInstrumentationOptions =
    typeof nameOrOptions === "string" ? { name: nameOrOptions } : nameOrOptions;

  const {
    name,
    logging = isDev,
    tracing = true,
    onComplete,
    baseFetch = globalThis.fetch,
    keepQueryKeys,
    injectTraceparent = true,
    defaultOperation,
    resolveOperation,
  } = options;

  return async (input: RequestInfo | URL, init?: InstrumentedFetchInit): Promise<Response> => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const safeUrl = redactUrl(rawUrl, { keepQueryKeys });
    // Per the Fetch spec, when both a Request and an `init.method` are
    // passed to `fetch()`, init.method replaces the Request's method.
    // When init.method is omitted, the Request's method survives. So:
    //
    //  - explicit `init.method` wins
    //  - else, if `input` is a Request, fall back to `input.method`
    //  - else, "GET" (matches `new Request(url).method` default)
    //
    // Without this, a caller like `fetch(new Request(url, { method: "POST" }))`
    // would surface as a GET in `http.method` on the span AND in the URL
    // router's `resolveOperation(url, method)` callback — mislabeling
    // POST traffic as GET in dashboards and routing decisions.
    const method =
      init?.method ??
      (typeof input !== "string" && !(input instanceof URL) ? input.method : undefined) ??
      "GET";
    const startTime = performance.now();

    // Resolve the operation BEFORE we touch init, then strip `operation`
    // off init so it never reaches `baseFetch` as an unknown RequestInit
    // property (some runtimes warn / future runtimes might reject).
    const explicitOp = init?.operation;
    let initForFetch: RequestInit | undefined = init;
    if (init && "operation" in init) {
      const { operation: _drop, ...rest } = init;
      initForFetch = rest;
    }
    const operation =
      explicitOp ?? defaultOperation ?? resolveOperation?.(rawUrl, method) ?? "fetch";
    const spanName = `${name}.${operation}`;

    // Inject W3C traceparent onto outbound requests so upstream services
    // that participate in OTel join our trace. No-op when no span is
    // active; never throws (see `injectTraceContext`).
    //
    // Header semantics follow the Fetch spec: when both a Request and an
    // `init` are passed to `fetch()`, `init.headers` REPLACES the
    // Request's headers — they do NOT union. So:
    //
    //  - If the caller supplied `init.headers`, start from those (the
    //    caller's explicit choice wins; we don't smuggle in Request
    //    headers behind their back).
    //  - Otherwise, if `input` is a Request, start from its headers (so
    //    its existing headers reach the wire alongside the injected
    //    traceparent).
    //  - Otherwise, start empty.
    //
    // In all cases, we mutate a fresh Headers object and pass it via the
    // returned `init` — Request objects are immutable in modern runtimes
    // and accepting `RequestInfo` means we may not own them.
    let finalInit: RequestInit | undefined = initForFetch;
    if (injectTraceparent) {
      const base =
        initForFetch?.headers !== undefined
          ? initForFetch.headers
          : typeof input !== "string" && !(input instanceof URL)
            ? input.headers
            : undefined;
      const headers = new Headers(base ?? undefined);
      injectTraceContext(headers);
      finalInit = { ...(initForFetch ?? {}), headers };
    }

    const doFetch = async (): Promise<Response> => {
      if (logging) {
        console.log(`[${name}] ${method} ${truncateUrl(safeUrl)}`);
      }

      const response = await baseFetch(input, finalInit);
      const durationMs = performance.now() - startTime;
      const cached = response.headers.get("x-cache") === "HIT";

      if (logging) {
        const color = response.ok ? "\x1b[32m" : "\x1b[31m";
        console.log(
          `[${name}] ${color}${response.status}\x1b[0m ${method} ${truncateUrl(safeUrl)} ${durationMs.toFixed(0)}ms${cached ? " (cached)" : ""}`,
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
          const u = new URL(rawUrl);
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
        url: safeUrl,
        method,
        status: response.status,
        durationMs,
        cached,
        operation,
      });

      return response;
    };

    if (tracing) {
      const tracer = getTracer();
      if (tracer) {
        const span = tracer.startSpan(spanName, {
          "http.method": method,
          // Redacted URL on the span attribute — once a CF Trace lands in
          // the dashboard, we can't redact retroactively.
          "http.url": safeUrl,
          "fetch.integration": name,
          // Stamp the resolved operation so it's queryable independent of
          // span name (e.g. "GROUP BY SpanAttributes['fetch.operation']").
          "fetch.operation": operation,
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
          if (response.status >= 400) {
            span.setError?.(new Error(`HTTP ${response.status} ${response.statusText}`));
          }
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
 *
 * Accepts the same options as `createInstrumentedFetch` (sans `name` and
 * `baseFetch`, which are positional), so callers can supply
 * `defaultOperation` / `resolveOperation` here as well.
 */
export function instrumentFetch(
  originalFetch: typeof fetch,
  name: string,
  options?: Omit<FetchInstrumentationOptions, "name" | "baseFetch">,
): InstrumentedFetch {
  return createInstrumentedFetch({ ...(options ?? {}), name, baseFetch: originalFetch });
}
