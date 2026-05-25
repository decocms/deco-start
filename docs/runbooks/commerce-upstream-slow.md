# Runbook: `commerce-upstream-slow`

> A site's `commerce_request_duration_ms` p95 exceeded its own 24h rolling baseline by 3σ for ≥ 10 minutes.

## What this alert means

Calls out to a commerce provider (VTEX, Shopify, or similar) are
taking abnormally long for *this* site. Because SSR is synchronous on
upstream commerce calls, a slow upstream cascades into the user-facing
`http-latency-spike` alert almost immediately. If both fired together,
this is the root cause — fix here first.

## First check (60 seconds)

Which provider/operation is slow? The same dashboard's "Commerce p95
by provider/operation" panel breaks it out. Note the
`provider.operation` string — e.g. `vtex.intelligent-search.product_search`.

If a single operation is responsible, jump to "Common causes" #1.
If multiple operations from the same provider are slow simultaneously,
that's a provider-wide regression — jump to "Common causes" #2.

## Diagnostic queries

```sql
-- p95 commerce latency by provider + operation, last hour
SELECT
  toStartOfInterval(TimeUnix, INTERVAL 5 MINUTE) AS t,
  Attributes['provider'] AS provider,
  Attributes['operation'] AS op,
  quantileBFloat16(0.95)(toFloat64(Sum / nullIf(Count, 0))) AS p95
FROM otel_metrics_histogram
WHERE MetricName = 'commerce_request_duration_ms'
  AND ServiceName = '{site}'
  AND TimeUnix > now() - INTERVAL 1 HOUR
GROUP BY t, provider, op
ORDER BY t, p95 DESC;
```

```sql
-- Commerce call status distribution — are we getting 5xx from upstream?
SELECT
  Attributes['provider'] AS provider,
  Attributes['operation'] AS op,
  Attributes['status_class'] AS status_class,
  count() AS n
FROM otel_metrics_histogram
WHERE MetricName = 'commerce_request_duration_ms'
  AND ServiceName = '{site}'
  AND TimeUnix > now() - INTERVAL 30 MINUTE
GROUP BY provider, op, status_class
ORDER BY n DESC;
```

```sql
-- VTEX SWR cache effectiveness on the slow operation
SELECT
  Attributes['cached'] AS cached,
  count() AS n,
  avg(toFloat64(Sum / nullIf(Count, 0))) AS avg_ms
FROM otel_metrics_histogram
WHERE MetricName = 'commerce_request_duration_ms'
  AND ServiceName = '{site}'
  AND Attributes['operation'] = '<paste operation here>'
  AND TimeUnix > now() - INTERVAL 30 MINUTE
GROUP BY cached;
```

## Common causes & fixes

| Rank | Cause                                                | How to confirm                                                                                  | Fix                                                                                                                |
|------|------------------------------------------------------|--------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------|
| 1    | One specific upstream operation is slow              | Single `provider.operation` row dominates the p95 query                                          | Check provider status page (status.vtex.com, www.shopifystatus.com). If clean, see if we recently changed payload size or filter on that operation. |
| 2    | Provider-wide regression                             | Multiple operations from the same `provider` regressed simultaneously                            | Public provider status page is usually the source of truth. Open a ticket with the provider citing our timing window.    |
| 3    | VTEX SWR / cachedLoader hit rate dropped             | Query 3 shows `cached=false` share rose                                                          | Inspect recent loader changes for the affected section. May have invalidated the cache key by changing the loader signature. |
| 4    | Region-specific (CF colo → upstream latency)         | `region` label on the metric isolates one CF colo                                                | Usually transient; CF will rebalance. If sustained, file a CF support ticket.                                       |

## Escalation

- Provider-wide regression confirmed → notify the affected customer-facing teams; this is communication-shaped, not engineering-shaped.
- One operation slow, no provider status incident → page the site team owner for that route.

## Post-mortem hook

- The `provider.operation` string and its p95 timeline.
- The cache (`cached=true/false`) split on that operation.
- A representative trace from `otel_traces` showing the slow span
  (`SpanName LIKE 'vtex.%'` or `'shopify.%'`).
