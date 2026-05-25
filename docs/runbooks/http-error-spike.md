# Runbook: `http-error-spike`

> A site's 5xx error rate exceeded its own 24h rolling baseline by 3σ for ≥ 10 minutes.

## What this alert means

Real users are getting 5xx responses at a rate that's statistically
abnormal for this specific site. The alert uses a per-site anomaly band
(not a fleet-wide threshold) so a site that normally runs at 0.3% 5xx
fires for spikes other sites wouldn't notice — and a site that normally
runs at 4% (a known-noisy legacy storefront) doesn't false-positive at
4.1%.

## First check (60 seconds)

Look at the **commerce upstream p95** panel on the same dashboard. If
that spiked at the same moment, the root cause is almost always an
upstream commerce API regressing. Stop here, jump to
[`commerce-upstream-slow.md`](./commerce-upstream-slow.md).

If commerce p95 is flat, the 5xx is internal — proceed below.

## Diagnostic queries

Paste into ClickStack or a Grafana Explore panel pointed at the
ClickHouse datasource.

```sql
-- Top error routes for this site, last 30 minutes
SELECT
  Attributes['route_pattern'] AS route,
  countIf(Attributes['status_class'] = '5xx') AS errors,
  count()                                     AS total,
  errors / total                              AS rate
FROM otel_metrics_sum
WHERE MetricName = 'http_requests_total'
  AND ServiceName = '{site}'
  AND TimeUnix > now() - INTERVAL 30 MINUTE
GROUP BY route
HAVING errors > 0
ORDER BY rate DESC
LIMIT 20;
```

```sql
-- Recent exceptions captured by the tail worker
SELECT Timestamp, Body, LogAttributes['url.path'] AS path, LogAttributes['http.response.status_code'] AS status
FROM otel_logs
WHERE ServiceName = '{site}'
  AND SeverityText = 'ERROR'
  AND LogAttributes['_source'] = 'tail-worker'
  AND LogAttributes['_outcome'] = 'exception'
  AND Timestamp > now() - INTERVAL 30 MINUTE
ORDER BY Timestamp DESC
LIMIT 100;
```

```sql
-- Did a deploy correlate? List versions seen in the last hour
SELECT
  ResourceAttributes['service.version'] AS version,
  min(Timestamp) AS first_seen,
  max(Timestamp) AS last_seen,
  count() AS log_count
FROM otel_logs
WHERE ServiceName = '{site}'
  AND Timestamp > now() - INTERVAL 1 HOUR
GROUP BY version
ORDER BY first_seen DESC;
```

## Common causes & fixes

| Rank | Cause                                              | How to confirm                                              | Fix                                                                 |
|------|----------------------------------------------------|-------------------------------------------------------------|---------------------------------------------------------------------|
| 1    | A recent deploy regressed                          | Top query above shows a `service.version` that flipped just before the spike | Roll back via Cloudflare dashboard `Deployments → Rollback`. Confirm via a fresh `service.version` line in the next 5m. |
| 2    | A specific route is broken (one bad section)       | Top error routes query shows one `route_pattern` at 100% error rate | Check the recent commits to that section. Roll back or `Lazy` wrap it for graceful degradation. |
| 3    | Upstream cache layer evicted; cold-cache thundering herd | `cache_miss_total` for the same window spikes proportionally to errors | Wait it out — usually self-heals in 5m. If sustained, check that `staleTime` is set correctly on cmsRouteConfig. |
| 4    | Origin (commerce API) returning 5xx                | `commerce_request_duration_ms` spike OR commerce logs       | See [`commerce-upstream-slow.md`](./commerce-upstream-slow.md).      |

## Escalation

- **Site team owner** if a fix isn't obvious in 15 minutes (slack
  `#deco-platform`).
- **Cloudflare support** if all sites in a region are affected
  simultaneously (look at the `region` label on the metrics) — this
  has happened during CF colo incidents.

## Post-mortem hook

Capture before the alert clears:
- `request.id` of one failing request (from the response header
  `X-Request-Id` of a manually-reproduced 5xx).
- A representative tail-worker log row with stack trace.
- The deploy `service.version` window during the spike.

Stash them in the incident ticket so the post-mortem has the
correlation IDs it needs.
