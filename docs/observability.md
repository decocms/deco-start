# Observability

`@decocms/start` ships a thin, opinionated observability layer for Deco storefronts on Cloudflare Workers. Three signals — spans, logs, and metrics — flow to the same downstream (stats-lake / ClickStack) along two complementary transport paths:

1. **CF Destinations (head-sampled, indirect):** spans + info/warn logs are captured by Cloudflare's managed pipeline at `head_sampling_rate` and pushed to `deco-otel-ingest`.
2. **Direct POST (un-sampled, in-Worker):** metrics (no CF Destinations support) and error logs (`level: "error"`, bypassing head sampling for 100% capture) are batched in-isolate and POSTed directly to `deco-otel-ingest` via `ctx.waitUntil`.

The framework's job is to emit a well-shaped signal on whichever path makes sense for the signal — never on both. No in-Worker OTLP exporter for spans/info-logs; no CF-Destinations path for metrics/errors.

## Architecture

```
┌──────────────────────────────────────────────┐
│ site Worker (instrumentWorker + withTracing) │
│                                              │
│   logger.info / .warn ──┐    traces ─────┐   │
│   logger.error ────┐    │                │   │
│   meter.counter / .histogram ──────┐     │   │
└────────────────────┬───┬───────────┬─────┬───┘
                     │   │           │     │
       direct POST   │   │ CF        │     │ CF
       (waitUntil)   │   │ Logs      │     │ Traces
                     ▼   ▼ Dest.     ▼     ▼ Dest.
                  ┌────────────────────────────┐
                  │ deco-otel-ingest (Worker)  │
                  │   /v1/traces  /v1/logs     │
                  │   /v1/metrics              │
                  │   redacts cookie, auth,    │
                  │   x-vtex-* headers          │
                  └─────────────┬──────────────┘
                                ▼
                  ┌────────────────────────────┐
                  │ stats-lake ClickHouse      │
                  │   otel_traces              │
                  │   otel_logs                │
                  │   otel_metrics_{sum,       │
                  │     gauge, histogram}      │
                  └─────────────┬──────────────┘
                                ▼
                  ┌────────────────────────────┐
                  │ ClickStack UI              │
                  │  hyperdx.clickhouse.cloud  │
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

When a request makes a cache decision, the **active span** is also stamped with:

- `deco.cache.decision` — `HIT` | `STALE-HIT` | `STALE-ERROR` | `MISS` | `BYPASS`
- `deco.cache.profile` — the cache profile name (`product`, `listing`, etc.)

This makes it possible to filter traces by cache decision directly in ClickStack without joining to the metric tables. The stamp lives on the closest enclosing span — typically `deco.http.request` for the page-level decision, and the local `deco.cache.lookup` / `deco.cache.store` spans for cache operations they wrap.

## What's measured

| Metric                          | Type      | Source                              | Labels (canonical, Phase 2 / D-11)                                                              |
| ------------------------------- | --------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `http_requests_total`           | counter   | `workerEntry`                       | `method`, `route_pattern`, `status`, `status_class`, `outcome?`, `cache_decision?`, `cache_layer?`, `region?` |
| `http_request_duration_ms`      | histogram | `workerEntry`                       | same as `http_requests_total`                                                                  |
| `http_request_errors_total`     | counter   | `workerEntry` (status >= 500)       | same as `http_requests_total`                                                                  |
| `cache_hit_total`               | counter   | edge cache decision                 | `profile`, `decision`, `layer` (`edge` \| `cachedLoader` \| `vtex-swr`)                         |
| `cache_miss_total`              | counter   | edge cache decision                 | `profile`, `decision`, `layer`                                                                  |
| `commerce_request_duration_ms`  | histogram | commerce clients (vtex/shopify/…)   | `provider`, `operation`, `status_class?`, `cached?`                                             |
| `resolve_duration_ms`           | histogram | `resolveDecoPage`                   | —                                                                                              |

`decision` values mirror the `X-Cache` response header: `HIT`, `STALE-HIT`, `STALE-ERROR`, `MISS`, `BYPASS`.

`route_pattern` is the TanStack route pattern (e.g. `/_products/$slug/p`) rather than the raw URL path — bounded cardinality, joinable to the route table. Callers that don't supply one get a normalized path with dynamic segments collapsed (`/products/:slug/p`).

`status_class` is the canonical `2xx`/.../`5xx`/`unknown` bucket. Dashboards aggregate by `status_class` for SLO panels and by `status` for incident drill-down.

`commerce_request_duration_ms` owned by the framework (Phase 2 / D-11) so every site emits it as soon as `@decocms/start` is bumped, regardless of `@decocms/apps` version. Apps register operation strings via `recordCommerceMetric`; the framework owns the cardinality contract.

### Metrics: AE vs OTLP (the two-meter split)

`instrumentWorker` plugs **up to two meters in parallel**, composed via `createCompositeMeter`:

| Path                                            | Destination                                | When wired                                          |
| ----------------------------------------------- | ------------------------------------------ | --------------------------------------------------- |
| **AE (Analytics Engine)**                       | `DECO_METRICS` AE binding                  | When the binding exists in `wrangler.jsonc`         |
| **OTLP/HTTP (direct POST)**                     | `${DECO_OTEL_METRICS_ENDPOINT}/v1/metrics` | When the env var resolves; off otherwise            |

Each emitted metric goes to **both** (composite). They serve different jobs:

- **AE** is the hot-path operator dashboard: high-cardinality, sub-second query, raw datapoints retained for `~30` days. Best for short-window incident triage from the CF dashboard. Cost scales with **datapoint writes** — pricing is well below ClickHouse Cloud for write-heavy metrics.
- **OTLP → ClickHouse** is the long-horizon, cross-source analytical store: SQL-joinable with `otel_traces` / `otel_logs`, multi-month retention, hooks into ClickStack panels. Best for cross-fleet rollups (per-tenant, per-deploy, per-app-version), and for any metric an operator wants to chart alongside spans.

Dropping AE entirely is supported (don't bind `DECO_METRICS`) — you lose the hot-path CF dashboard view but the ClickStack panel still works. Dropping OTLP is the default until `DECO_OTEL_METRICS_ENDPOINT` is set. Running both is the recommended posture and what the cost model in this doc assumes.

CF Destinations does **not** support OTLP metrics natively (only traces + logs). That's why the OTLP metrics channel is a direct POST from the Worker, batched in-isolate and flushed via `ctx.waitUntil` rather than carried by CF.

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
      "head_sampling_rate": 0.01,
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

The direct-POST channels are wired automatically when the relevant env vars resolve. Defaults work for the standard fleet ingestor URL — explicit overrides are only needed for staging or private ingestors:

| Env var (default name)             | Channel              | Default                | Behavior when unset                                  |
| ---------------------------------- | -------------------- | ---------------------- | ---------------------------------------------------- |
| `DECO_OTEL_METRICS_ENDPOINT`       | OTLP metrics POST    | `""` (unset)           | OTLP meter is not created; AE-only metrics           |
| `DECO_OTEL_LOGS_ENDPOINT`          | OTLP error-log POST  | `""` (unset)           | Error logs ride CF Destinations only (head-sampled)  |
| `DECO_OTEL_TRACES_ENDPOINT`        | OTLP traces POST     | `""` (unset)           | Framework `deco.*` spans drop unless CF Traces is on |

All three are opt-out via `OtelOptions.otlpMetricsEnabled: false` / `otlpErrorLogsEnabled: false` / `otlpTracesEnabled: false` if you need to disable them at boot for a specific environment without changing the env vars. Traces honor `OtelOptions.otlpTracesSamplingRate` (default `0.01` to match CF Destinations) — sampling decisions are consistent per trace (`FNV-1a` hash of `trace_id`), so child spans are kept iff their root is kept. Remote parents that arrive sampled (`traceparent` flags `01`) override the rate and are always exported.

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

For commerce clients (VTEX, Shopify), `createInstrumentedFetch` injects the W3C `traceparent` header by default. To opt out for a specific endpoint that rejects unknown headers, pass `injectTraceparent: false`.

For any other outbound `fetch` issued during a request, inject a `traceparent` header manually so upstream services that participate in OTel can join your trace:

```ts
import { injectTraceContext } from "@decocms/start/sdk/observability";

async function tracedFetch(url: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  injectTraceContext(headers);
  return fetch(url, { ...init, headers });
}
```

`injectTraceContext` is a no-op when no span is active and when the active span doesn't expose `spanContext()` — safe to call unconditionally. In `@decocms/apps`, the canonical `createInstrumentedFetch` helper calls this for every outbound call, so most sites don't have to think about it.

### Per-call operation names on outbound fetches

`createInstrumentedFetch(name)` from `@decocms/start/sdk/instrumentedFetch` produces spans named `${name}.fetch` by default. For commerce calls where operators want to query by SEMANTIC endpoint (`vtex.intelligent-search.product_search`, `vtex.checkout.orderForm`) rather than by URL, supply an `operation` per call or wire a URL-derived router on the integration:

```ts
const vtexFetch = createInstrumentedFetch({
  name: "vtex",
  // Long-tail fallback: URL → operation. Returns undefined to opt out
  // (span falls back to `vtex.fetch`).
  resolveOperation: (url) => {
    const path = new URL(url).pathname;
    if (path.startsWith("/api/io/_v/intelligent-search/")) return "intelligent-search";
    if (path.startsWith("/api/checkout/pub/orderForm")) return "checkout.orderForm";
    return undefined;
  },
  // Or set a default when every call is the same operation:
  // defaultOperation: "emails.send",
});

// Hot path — explicit operation wins over the router.
await vtexFetch("https://account.vtexcommercestable.com.br/api/io/_v/intelligent-search/product_search", {
  operation: "intelligent-search.product_search",
});
```

Resolution precedence is `init.operation` → `defaultOperation` → `resolveOperation(url, method)` → the literal `"fetch"`. The resolved value lands on the span as `fetch.operation` (so dashboards can `GROUP BY SpanAttributes['fetch.operation']` independent of span name) and is included in the `onComplete` callback payload (so per-app duration histograms can label by operation). `operation` is stripped from `init` before reaching the underlying `fetch` — it never surfaces to the network.

## Error capture — three-channel model

100% capture of errors is achieved across three complementary channels, each owning a different slice of "what failed":

| Error source                              | Channel               | Coverage           | Why it's needed                                                                                                                                                                                  |
| ---                                       | ---                   | ---                | ---                                                                                                                                                                                              |
| Framework `logger.error(...)`             | Direct POST           | 100% (rate-limited)| Framework owns the call site, can attach structured context (traceId, route, attrs), and can fire before the request finishes. Latency-sensitive.                                                  |
| Framework span errors (`setError`)        | CF Destinations + tail| 1% sampled + 100% tail | Spans ride the CF Destinations pipe; tail worker picks them up again if the request finished `outcome != "ok"`. Together they give per-span detail at scale + 100% capture on regressions.       |
| **Uncaught throws** escaping the handler  | **Tail Worker**       | **100%**           | Direct-POST can't fire — by the time the throw bubbles past `instrumentWorker`, the worker isolate is unwinding. The tail worker runs AFTER the worker terminates and receives the captured exception. |
| **`exceededCpu` / `exceededMemory`**      | **Tail Worker**       | **100%**           | The producer is killed before any in-Worker code can run. Only the CF runtime can surface these outcomes, and it does so through the tail handler.                                                |
| **Raw `console.error(...)`** outside framework | **Tail Worker** | **100%**           | Third-party SDKs (analytics, payment, observability libs that aren't ours) call `console.error` directly, bypassing the framework logger. CF captures every `console.*` line into the TraceItem. |
| Info / warn logs                          | CF Destinations       | 1% sampled         | Bulk volume. Sampled to keep CF Destinations cost in check at fleet scale.                                                                                                                       |
| OTel spans                                | CF Destinations       | 1% sampled         | Same as above — spans are 95% of the event volume.                                                                                                                                                |
| OTel metrics                              | Direct POST           | 100% (buffered)    | CF Destinations doesn't support OTLP metrics. Direct-POST is the only path.                                                                                                                       |

The tail-worker channel is implemented by [`deco-otel-tail`](https://github.com/decocms/stats-lake/tree/main/ingestion/otel-tail) (in the stats-lake repo). The producer wrangler opts in with:

```jsonc
"tail_consumers": [
  { "service": "deco-otel-tail" }
]
```

Rows from the tail worker land in `otel_logs` with `Attributes['_source'] = 'tail-worker'`, so dashboards can split out tail-captured errors from direct-POST and CF-Destinations errors as needed.

## Sampling

`head_sampling_rate` on `observability.traces` and `observability.logs` decides at the very start of a trace/log whether Cloudflare Destinations forwards it to the deco-otel-ingest endpoint. CF Destinations does NOT support tail sampling — the framework instead uses the three-channel error-capture model documented above to achieve 100% error capture independent of `head_sampling_rate`.

**Recommended defaults:**

- `traces.head_sampling_rate: 0.01` — 1% of traces forward via CF Destinations.
- `logs.head_sampling_rate: 0.01` — 1% of info/warn logs forward via CF Destinations. **Errors are not subject to this rate** — they are fully covered by (a) the direct-POST channel for framework `logger.error(...)` (100%, rate-limited), and (b) the tail worker for everything else (uncaught throws, exhaustion outcomes, raw `console.error`). The earlier `logs.head_sampling_rate: 1.0` default was retired when the tail worker landed.

**Per-site override tier (heavy traffic only):**

- `traces.head_sampling_rate: 0.001` — 0.1% — for sites projected over 100M requests/month, with explicit team sign-off in the site repo's commit message or PR. NOT a codemod default, NOT documented as a recommended floor for all sites.

**Why 1% and not 10%:** at the fleet scale we operate (`~2.5B req/month`, 100 sites, `~20` spans/req), shipping 10% of traces through CF Destinations puts the account at meaningful risk of tripping the 5B-events/day cap (CF auto-applies forced 1% sampling for the rest of the day once you cross it, drowning out every site's signal — a single viral campaign on one storefront becomes a fleet-wide outage of telemetry). 1% gives us a 2.5x headroom and keeps annual telemetry cost in the low hundreds of dollars.

**Why no documented rate above 1%:** every value above `0.01` shipped as an "example" or "documented recommendation" is an attractive nuisance: someone copy-pastes it into a high-traffic site's `wrangler.jsonc` to "debug an incident" and forgets to revert, and the next month the team eats a five-figure CF bill. Higher rates are technically possible and may be temporarily appropriate for a specific investigation — they just shouldn't be documented as defaults anywhere. Audit rule `wrangler.head_sampling_rate_elevated` flags any value above `0.01`.

**Upgrade path for 100% error traces (NOT recommended at our scale):** ingest-side filtering. Set `head_sampling_rate: 1.0` and let `deco-otel-ingest` drop OK traces deterministically by `TraceId` while keeping all error traces. Costs ~$44K/mo at our scale (verified against current CF and DO pricing), versus ~$420/mo for the chosen path of head-sample-1% + direct-POST-errors. Lives in the ingest Worker, not the framework, and only worth it when downstream cost stops mattering.

## Cost model (fleet of 100 sites, 2.5B req/month)

Verified against Cloudflare's current public pricing (Workers requests `$0.30/M`, Workers Logs `$0.60/M` after the 20M/mo free tier, AE data points `$0.25/M` after 10M/mo, AE reads `$1.00/M` after 1M/mo) and ClickHouse Cloud storage at the projected compressed volume:

| Strategy | CF Destinations $/mo | Ingestor + CH $/mo | AE $/mo | DO $/mo | Total fleet $/mo |
|----------|---------------------:|-------------------:|--------:|--------:|-----------------:|
| **head=1% + errors via direct POST + metrics via direct POST (chosen)** | ~$360 | ~$20 | ~$39 | $0 | **~$420** |
| head=0.1% (heavy-site tier) | ~$18 | ~$20 | ~$39 | $0 | ~$70 |
| head=10% + 100% logs | ~$8.8K | ~$10 | ~$39 | $0 | ~$8.8K |
| head=100% + DO-buffered tail-on-error | ~$36K | ~$20 | ~$39 | ~$8K | ~$44K |

Numbers assume `~20` spans per request, `~4` log lines per request, and `~5` AE writes per request. The chosen-path breakdown:

- `~$360` — CF Destinations carrying 1% of traces (`~500M/mo`) and 100% of info/warn logs (`~10B/mo` — see note below) through the Workers Logs billing tier.
- `~$20` — ingestor `Worker` requests + CPU + ClickHouse Cloud writes (`~14M POSTs/mo` from CF Destinations + direct-POST flushes combined).
- `~$39` — AE writes (`~125M/mo` at the same 1% sample as traces, coupled via the trace-id hash) + AE reads (operator dashboards).
- `$0` — no Durable Objects (the tail-on-error buffer was rejected; see "Out of scope").

> The `~10B/mo` log volume is the current state with logs at `head_sampling_rate: 1`. With the direct-POST error channel shipped (Phase 4), sites can safely move info/warn logs to `head_sampling_rate: 0.01` and the CF Destinations cost falls by another `~$50/mo`. Errors are then carried 100% through the direct POST channel at a few dollars on the ingestor side.

## Identity & cardinality notes

- `path` labels on `http_*` metrics are normalized via `normalizePath` (dynamic IDs collapsed to `:id`, PDP slugs to `:slug/p`) to keep AE label cardinality bounded.
- `cache.profile` is one of the built-in profiles (`product`, `listing`, `search`, `static`, `cart`, `private`, `none`) plus any custom profile registered via the site's `cacheHeaders` overrides. Small, fixed set — safe as a label.
- `deco.section` carries the section component key (e.g. `site/sections/ProductShelf.tsx`). Cardinality scales with the number of sections in the catalog — typically <100, fine for ClickHouse but **not** safe as an AE metric label (use it as a span attribute only).

## Auditing the config

A site's `wrangler.jsonc` can drift away from the canonical block above
between migrations. The audit catches that drift in CI:

```bash
npx -p @decocms/start deco-audit-observability        # exits 1 on findings
npx -p @decocms/start deco-audit-observability --json # machine-readable
```

Rule set (each rule maps 1:1 to a `deco-cf-observability --write …` fix
flag — there is no detect-only rule):

| Rule id                            | Severity | What it catches                                                                                              |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `observability_missing`            | error    | No `observability` key at all. Cloudflare captures nothing.                                                  |
| `observability_disabled`           | error    | `observability.enabled: false`. Master switch off.                                                           |
| `traces_disabled` / `logs_disabled`| warn     | Sub-block `enabled: false`. Often intentional during incident triage; flagged so it doesn't go un-noticed.   |
| `head_sampling_rate_elevated`      | error    | `traces.head_sampling_rate > 0.01`. Fleet-scale cost trap; see [Sampling](#sampling).                        |
| `logs_head_sampling_rate_low`      | warn     | `logs.head_sampling_rate < 1`. Info/warn logs are cheap; errors already bypass head sampling via direct POST.|
| `persist_disabled_no_destination`  | error    | `persist: false` with no destinations. Data captured then discarded.                                         |

A CF Tail Worker pre-merge check can run this audit against the
storefront repo's `wrangler.jsonc`; pair with the codemod for one-shot
remediation.

## Data loss profile

Different signals have different durability guarantees. Knowing where data can be silently dropped matters more than knowing where it can't.

| Signal                 | Path                          | Sampling                         | Buffer location          | Loss conditions                                                                                                                                |
| ---------------------- | ----------------------------- | -------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Traces (spans)**     | CF Destinations               | head 1% (`0.01`)                 | Cloudflare-managed       | 99% intentionally dropped at head. Of the 1% that survives, only loss is a CF Destinations outage or an ingestor 5xx (no retries from CF).      |
| **Info / warn logs**   | CF Destinations               | head 1% (`0.01`)                 | Cloudflare-managed       | 99% intentionally dropped at head. Of the 1% that survives, only loss is a CF Destinations outage.                                              |
| **Framework error logs** | Direct POST (`/v1/logs`)    | none (100%, then rate-limited)   | In-Worker buffer         | (a) Token-bucket rate limiter trips on a log storm — default `100/min` steady, `20` burst — surplus is **counted-and-dropped** via `onError`. (b) Buffer overflow (default `500` records) before the next flush — same `onError` signal. (c) A failed POST to the ingestor (non-2xx or network error) does **not** drop records — the in-flight snapshot is restored to the front of the buffer. When `snapshot + buffer > cap`, restoration drops the **newest** records first (newest tail of the live buffer, then if still over cap, newest tail of the snapshot) — the oldest, most-likely-causal records are preserved. All drops surface via `onError("overflow", …)` with counts. (d) Worker isolate forcibly evicted before `ctx.waitUntil` completes — covered by the tail worker (next row). |
| **Uncaught throws, `exceededCpu`, raw `console.error`** | Tail Worker (`deco-otel-tail` → `/v1/logs`) | none (100%) | Out-of-process (separate worker) | (a) Tail worker invocation failure on the CF runtime side (extremely rare; CF retries internally). (b) `deco-otel-ingest` 5xx — the tail worker logs the failure but does NOT retry the OTLP forward, so the affected batch is lost. (c) The producer dies so abruptly that CF can't materialize a TraceItem — undocumented edge case, treat as bounded by CF's own SLA. |
| **Metrics**            | Direct POST (`/v1/metrics`)   | none (100%)                      | In-Worker buffer         | Counters and gauges are last-write-wins per datapoint — a forced eviction drops at most one flush window's worth of partial sums. Histograms with un-flushed bucket counts are lost on eviction. Buffer overflow (default `5000` datapoints) drops the oldest datapoint via `onError`. |
| **AE metrics**         | Workers Analytics Engine      | none (sampled per-AE-policy)     | Cloudflare-managed       | AE applies its own sampling once an account crosses the 5B-events/day cap. Below the cap, AE writes are durable on the platform side.           |

What this means operationally:

- **For traces and info/warn logs**, the dominant loss factor is sampling, not transport. If you need 100% of a specific class (errors, security events, an A/B variant under investigation), route them through the direct-POST channels — never lift `head_sampling_rate` to compensate.
- **For errors and metrics**, the dominant loss factor is the in-Worker buffer and the rate limiter. The `onError` callback wired by `instrumentWorker` surfaces these as a logged event — keep an alert on the count.
- **AE is a separate pipe** with its own loss profile; treat AE-only metrics as a hot-path-only view, not a long-horizon source of truth.

## Out of scope

- **In-Worker OTLP exporter for spans / info-logs.** Removed in 5.0.0; CF Destinations is the spans + info/warn-logs path. (Direct-POST does still exist for **metrics** and **error logs**, by deliberate choice — both are signals CF Destinations cannot or should not carry.)
- **Tail-on-error sampling via a Durable Object buffer.** The DO-backed
  approach was rejected on cost grounds (~$8K/mo at fleet scale, see
  [Cost model](#cost-model-fleet-of-100-sites-25b-reqmonth)). The functional
  goal — 100% capture of errors regardless of head sampling — is met via
  two complementary mechanisms: (a) the in-Worker direct-POST channel for
  framework `logger.error(...)` calls, and (b) the **Cloudflare Tail Worker
  (`deco-otel-tail`, Strategy B)** which CF invokes on every invocation of
  a producer worker that lists it under `tail_consumers`. The tail worker
  filters TraceItems down to the "interesting" subset (outcome != ok,
  exceptions, or `level: error` logs) and forwards them as OTLP/JSON logs
  to `deco-otel-ingest` via an intra-account service binding. See
  [decocms/stats-lake/ingestion/otel-tail/](https://github.com/decocms/stats-lake/tree/main/ingestion/otel-tail) and D-8.
- **Commerce-specific spans.** Per-app (VTEX, Shopify) HTTP spans live in `@decocms/apps`, which calls `createInstrumentedFetch` (with `defaultOperation` / `resolveOperation` configured per provider) and authors `init.operation` at hot call sites. PR #3 in the apps-start repo migrates the per-app fetch sites onto that pattern. The framework owns the span shape (`${name}.${operation}`); the apps repo owns the operation strings + provider-labelled duration histogram.
- **PII redaction at the framework layer.** URLs are redacted by `redactUrl()` on outbound `fetch` spans; the rest (cookie, authorization, x-vtex-* headers) is redacted in the ingest Worker. No per-site code required for either side.
