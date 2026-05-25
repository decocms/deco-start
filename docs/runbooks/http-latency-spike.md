# Runbook: `http-latency-spike`

> A site's p95 latency exceeded its own 24h rolling baseline by 3σ for ≥ 10 minutes.

## What this alert means

User-perceived latency on this site is statistically abnormal vs the
last 24 hours. Latency rarely degrades in isolation — almost always
something else is bottlenecked underneath. Use this alert as the
"something is wrong, look around" signal, then triangulate.

## First check (60 seconds)

Open the dashboard's **commerce p95 by provider/operation** panel. The
most common cause of p95 spikes is an upstream commerce API (VTEX,
Shopify) slowing down — and our SSR is synchronous on the upstream
call.

If commerce p95 spiked at the same moment, jump to
[`commerce-upstream-slow.md`](./commerce-upstream-slow.md).

## Diagnostic queries

```sql
-- Latency p95 by route_pattern, last hour
SELECT
  toStartOfInterval(TimeUnix, INTERVAL 5 MINUTE) AS t,
  Attributes['route_pattern'] AS route,
  quantileBFloat16(0.95)(toFloat64(Sum / nullIf(Count, 0))) AS p95
FROM otel_metrics_histogram
WHERE MetricName = 'http_request_duration_ms'
  AND ServiceName = '{site}'
  AND TimeUnix > now() - INTERVAL 1 HOUR
GROUP BY t, route
ORDER BY t, p95 DESC;
```

```sql
-- Cache decision distribution — did hit rate drop while latency rose?
SELECT
  Attributes['cache_decision'] AS decision,
  count() AS n,
  avg(toFloat64(Sum / nullIf(Count, 0))) AS avg_ms
FROM otel_metrics_histogram
WHERE MetricName = 'http_request_duration_ms'
  AND ServiceName = '{site}'
  AND TimeUnix > now() - INTERVAL 30 MINUTE
GROUP BY decision
ORDER BY n DESC;
```

```sql
-- Slow traces with full span breakdown (sampled ~1%, so re-run if empty)
SELECT TraceId, SpanName, Duration / 1e6 AS ms, SpanAttributes['url.path'] AS path
FROM otel_traces
WHERE ServiceName = '{site}'
  AND Timestamp > now() - INTERVAL 30 MINUTE
  AND SpanName = 'deco.http.request'
  AND (Duration / 1e6) > 2000
ORDER BY Duration DESC
LIMIT 50;
```

## Common causes & fixes

| Rank | Cause                                                | How to confirm                                                                                | Fix                                                                                  |
|------|------------------------------------------------------|-----------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------|
| 1    | Upstream commerce API slow                           | Commerce p95 panel spikes with the same shape                                                 | See [`commerce-upstream-slow.md`](./commerce-upstream-slow.md).                       |
| 2    | Cache hit rate dropped (cold cache after deploy/purge) | Cache panel shows MISS share rose at spike start; usually self-heals within 5-10m            | Wait it out unless sustained; if sustained check the route-level cache profile.      |
| 3    | One specific route is slow (heavy loader added)      | Per-route p95 query shows one `route_pattern` dominating                                      | Inspect recent commits to that route's loader. Consider deferring sections via `Lazy`. |
| 4    | Cloudflare edge / colo issue                         | `region` label distribution skewed to one or two colos                                        | Check CF status page; usually clears on its own.                                     |

## Escalation

- 30 minutes without resolution → page the site team owner.
- All sites in a region affected → suspect CF infra; check status.cloudflare.com.

## Post-mortem hook

- A representative slow `TraceId` from the third query above.
- The cache hit rate before/during the spike.
- Deploy version at the start of the window.
