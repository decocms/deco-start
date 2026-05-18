# Observability

`@decocms/start` ships a thin, opinionated observability layer for Deco storefronts on Cloudflare Workers. Spans, logs, and metrics flow through Cloudflare's managed export — there is no in-Worker OTLP exporter. The framework's job is to emit a well-shaped signal; transport is solved by Cloudflare Destinations and the `deco-otel-ingest` Worker.

## Architecture

```
┌────────────────────────────┐
│ site Worker                │  instrumentWorker(handler, ...) wires:
│   instrumentWorker(...)    │   - structured JSON logger → console.* (capture by CF Logs)
│   withTracing(...)         │   - AE meter (when DECO_METRICS binding present)
│   logger.info|warn|error   │   - bridge to @opentelemetry/api global tracer
└─────────────┬──────────────┘
              │ OTLP/HTTP JSON via observability.{logs,traces}.destinations
              ▼
┌────────────────────────────┐
│ deco-otel-ingest (Worker)  │   Maps OTLP → ClickHouse clickhouseexporter schema,
│   redacts PII (cookie,     │   redacts sensitive headers, persists to stats-lake.
│   authorization, x-vtex-*) │
└─────────────┬──────────────┘
              ▼
┌────────────────────────────┐
│ stats-lake ClickHouse      │   default.otel_traces / default.otel_logs (30-day TTL)
└─────────────┬──────────────┘
              ▼
┌────────────────────────────┐
│ ClickStack UI              │   hyperdx.clickhouse.cloud
│  (HyperDX-compatible)      │
└────────────────────────────┘
```

## What's instrumented

| Span                              | Source                                        | Key attributes                                                         |
| --------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| `deco.http.request`               | `workerEntry` root                            | `http.method`, `url.path`                                              |
| `deco.cms.resolvePage`            | `resolveDecoPage`                             | `deco.route`                                                           |
| `deco.section.loaders.batch`      | `runSectionLoaders`                           | `section.count`                                                        |
| `deco.section.loader`             | `runSingleSectionLoader` (per section)        | `deco.section`                                                         |
| `deco.section.deferred.load`      | `loadDeferredSection` (server fn)             | `section.name`, `section.index`, `page.path`                           |
| `deco.cache.lookup`               | edge cache `cache.match`                      | `cache.profile`, `cache.kind` (`html` \| `serverFn`)                   |
| `deco.cache.store`                | edge cache `cache.put` (background)           | `cache.profile`, `cache.kind`                                          |
| `deco.admin.meta`                 | `/live/_meta`, `/deco/meta`                   | —                                                                      |
| `deco.admin.decofile.read`        | `GET /.decofile`                              | —                                                                      |
| `deco.admin.decofile.reload`      | `POST /.decofile`                             | —                                                                      |
| `deco.admin.render`               | `/live/previews/*`, `/deco/render`            | `cms.component`                                                        |
| `deco.admin.invoke`               | `/deco/invoke/$`                              | `invoke.key`, `invoke.batch`                                           |

All framework spans also carry the per-span attribute floor described under **Identity**.

## What's measured

The meter is plugged at boot when `DECO_METRICS` (Workers Analytics Engine) is bound:

| Metric                         | Type      | Source                              | Labels                          |
| ------------------------------ | --------- | ----------------------------------- | ------------------------------- |
| `http_requests_total`          | counter   | `workerEntry`                       | `method`, `path`, `status`      |
| `http_request_duration_ms`     | histogram | `workerEntry`                       | `method`, `path`, `status`      |
| `http_request_errors_total`    | counter   | `workerEntry` (status >= 500)       | `method`, `path`, `status`      |
| `cache_hit_total`              | counter   | edge cache decision                 | `profile`, `decision`           |
| `cache_miss_total`             | counter   | edge cache decision                 | `profile`, `decision`           |
| `resolve_duration_ms`          | histogram | `resolveDecoPage`                   | —                               |

`decision` values mirror the `X-Cache` response header: `HIT`, `STALE-HIT`, `STALE-ERROR`, `MISS`, `BYPASS`.

## Identity stamped on every span and log

`instrumentWorker(handler, { serviceName: "my-store" })` stamps the following on every framework-created span AND every log line via the logger attribute floor:

- `service.name` — the value passed to `instrumentWorker`, or `env.DECO_SITE_NAME`, or `"deco-site"`
- `service.version` — `env.CF_VERSION_METADATA?.id` (omitted when the binding isn't present)
- `deco.runtime.version` — `@decocms/start` build-time constant
- `deployment.environment` — `env.DECO_ENV_NAME` or `"production"`
- `deco.apps.version` — optional, passed via `OtelOptions.decoAppsVersion`

In addition, every log emitted inside a `withTracing(...)` scope carries:

- `trace_id` and `span_id` — pulled from the active span's `spanContext()`

That makes it possible to jump from any log line straight to its trace in ClickStack/HyperDX.

## Required `wrangler.jsonc` shape

```jsonc
{
  "name": "my-store",
  "main": "./src/worker-entry.ts",
  "compatibility_date": "2026-02-14",
  "compatibility_flags": ["nodejs_compat", "no_handle_cross_request_promise_resolution"],
  "observability": {
    "enabled": true,
    "logs": {
      "enabled": true,
      "invocation_logs": true,
      "head_sampling_rate": 1,
      "persist": true,
      "destinations": [
        {
          "id": "deco-otel-ingest-logs",
          "kind": "otlp_http",
          "endpoint": "https://deco-otel-ingest.deco-cx.workers.dev/v1/logs"
        }
      ]
    },
    "traces": {
      "enabled": true,
      "head_sampling_rate": 0.1,
      "persist": true,
      "destinations": [
        {
          "id": "deco-otel-ingest-traces",
          "kind": "otlp_http",
          "endpoint": "https://deco-otel-ingest.deco-cx.workers.dev/v1/traces"
        }
      ]
    }
  },
  "version_metadata": { "binding": "CF_VERSION_METADATA" },
  "analytics_engine_datasets": [
    { "binding": "DECO_METRICS", "dataset": "deco_metrics_my_store" }
  ]
}
```

The `version_metadata` binding is what makes `service.version` show up on spans and logs — without it, the framework still works but you can't correlate regressions to a specific deployment.

## Wiring `instrumentWorker`

```ts
// src/worker-entry.ts
import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
import { instrumentWorker } from "@decocms/start/sdk/otel";
import serverEntry from "./server";

const handler = createDecoWorkerEntry(serverEntry, options);
export default instrumentWorker(handler, { serviceName: "my-store" });
```

`OtelOptions` also accepts a function `(env) => OtelOptions` if your service name comes from env.

## Log shape (and how to query it)

Cloudflare Destinations wraps every `console.log` line into an OTLP `LogRecord` with the JSON body in `body.stringValue`. The ingest Worker maps that to ClickHouse's `otel_logs.Body` verbatim. To filter logs by a structured field, use `JSONExtract` in ClickHouse:

```sql
-- Error rate by service over the last hour
SELECT
  ServiceName,
  countIf(JSONExtractString(Body, 'level') = 'error') AS errors,
  count()                                              AS total,
  errors / total                                        AS error_rate
FROM otel_logs
WHERE Timestamp > now() - INTERVAL 1 HOUR
GROUP BY ServiceName
ORDER BY error_rate DESC;
```

```sql
-- All logs for a given trace
SELECT Timestamp, SeverityText, Body
FROM otel_logs
WHERE JSONExtractString(Body, 'trace_id') = '0123456789abcdef0123456789abcdef'
ORDER BY Timestamp ASC;
```

In the ClickStack UI you can also filter logs panel by `trace_id` directly — paste the ID from a span and the matching log lines appear.

## Outbound trace propagation

For any outbound `fetch` issued during a request (VTEX, Shopify, internal APIs), inject a W3C `traceparent` header so upstream services that participate in OTel can join your trace:

```ts
import { injectTraceContext } from "@decocms/start/sdk/observability";

async function tracedFetch(url: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  injectTraceContext(headers);
  return fetch(url, { ...init, headers });
}
```

`injectTraceContext` is a no-op when no span is active and when the active span doesn't expose `spanContext()` — safe to call unconditionally. In `@decocms/apps`, the canonical `createInstrumentedFetch` helper calls this for every outbound call, so most sites don't have to think about it.

## Sampling

`head_sampling_rate` on `observability.traces` decides at trace start whether to forward to the destination. Cloudflare Destinations does NOT support tail sampling (status-aware filtering). The current pragmatic default is:

- `traces.head_sampling_rate: 0.1` — keep 10% of traces
- `logs.head_sampling_rate: 1.0` — keep 100% of logs (logs are cheap, error context comes from here)

When dashboards need 100% of error traces, the upgrade path is **ingest-side filtering**: set `head_sampling_rate: 1.0` and let `deco-otel-ingest` drop OK traces deterministically by `TraceId` while keeping all error traces. Lives in the ingest Worker, not the framework.

## Identity & cardinality notes

- `path` labels on `http_*` metrics are normalized via `normalizePath` (dynamic IDs collapsed to `:id`, PDP slugs to `:slug/p`) to keep AE label cardinality bounded.
- `cache.profile` is one of the built-in profiles (`product`, `listing`, `search`, `static`, `cart`, `private`, `none`) plus any custom profile registered via the site's `cacheHeaders` overrides. Small, fixed set — safe as a label.
- `deco.section` carries the section component key (e.g. `site/sections/ProductShelf.tsx`). Cardinality scales with the number of sections in the catalog — typically <100, fine for ClickHouse but **not** safe as an AE metric label (use it as a span attribute only).

## Out of scope

- **In-Worker OTLP exporter.** Removed in 5.0.0. CF Destinations handles transport; the framework only emits.
- **Tail-on-error sampling.** Lives in `deco-otel-ingest` or a CF Tail Worker if/when needed.
- **Commerce-specific spans.** Per-app (VTEX, Shopify) HTTP spans live in `@decocms/apps` via `createInstrumentedFetch`.
- **PII redaction.** Handled at the ingest Worker; no per-site code required.
