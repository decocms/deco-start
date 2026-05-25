# Runbook: `cache-hit-drop`

> A site's edge cache hit rate fell below its own 24h rolling baseline by 3σ for ≥ 10 minutes.

## What this alert means

The edge cache is missing more than usual. On the user side this
manifests as slower page loads. On the cost side it means more origin
requests (more billing for Workers + commerce API calls). On the
upstream side it can become a thundering herd if many users hit a
freshly-evicted entry simultaneously.

## First check (60 seconds)

Was there a deploy or a cache purge in the last 10 minutes? Cold caches
recover quickly (5–10m) so if the alert is fresh and a deploy is
recent, this often self-heals.

```sql
-- Recent deploys (any change to service.version visible in metrics)
SELECT ResourceAttributes['service.version'] AS version, min(TimeUnix) AS first_seen
FROM otel_metrics_sum
WHERE ServiceName = '{site}'
  AND TimeUnix > now() - INTERVAL 1 HOUR
GROUP BY version
ORDER BY first_seen DESC;
```

If neither deploy nor purge fired in the window, the cache miss share
indicates a real regression — proceed below.

## Diagnostic queries

```sql
-- Hit / miss share by route_pattern, last 30 minutes
SELECT
  Attributes['route_pattern'] AS route,
  countIf(MetricName = 'cache_hit_total') AS hits,
  countIf(MetricName = 'cache_miss_total') AS misses,
  hits / nullIf(hits + misses, 0) AS hit_rate
FROM otel_metrics_sum
WHERE MetricName IN ('cache_hit_total', 'cache_miss_total')
  AND ServiceName = '{site}'
  AND TimeUnix > now() - INTERVAL 30 MINUTE
GROUP BY route
ORDER BY misses DESC
LIMIT 20;
```

```sql
-- Cache decision distribution by cache_profile
SELECT
  Attributes['profile'] AS profile,
  Attributes['decision'] AS decision,
  sum(toFloat64(Value)) AS n
FROM otel_metrics_sum
WHERE MetricName = 'cache_hit_total'
  AND ServiceName = '{site}'
  AND TimeUnix > now() - INTERVAL 30 MINUTE
GROUP BY profile, decision
ORDER BY n DESC;
```

## Common causes & fixes

| Rank | Cause                                                       | How to confirm                                                | Fix                                                                                                       |
|------|-------------------------------------------------------------|----------------------------------------------------------------|------------------------------------------------------------------------------------------------------------|
| 1    | Deploy purged the version cache (`X-Cache-Version` flipped) | Recent `service.version` in the deploy query                  | Wait 10m for cache to warm. If sustained, check that the new build hash is propagating consistently.       |
| 2    | A new query parameter is hashing into the cache key         | One route's MISS share is far higher than the rest             | Check `cacheHeaders` / `ignoreSearchParams` config for that route; add the new param to the ignore list.   |
| 3    | Set-Cookie present on a previously cacheable response       | `X-Cache: BYPASS` with `X-Cache-Reason: private-set-cookie` on the affected route | Inspect the section that started emitting cookies; move the cookie write to a non-cacheable POST handler. |
| 4    | A real burst of unique URLs (e.g. crawler scanning long-tail) | `Attributes['route_pattern']` doesn't change but distinct paths multiply | If a known bot, add a WAF rule. If a real catalog query, consider broader cache profile.                  |

## Escalation

- Sustained > 1 hour despite no deploy → page the site team owner.
- Suspected bot/abuse → loop in security / WAF on-call.

## Post-mortem hook

- The "before" hit rate and the "after" hit rate.
- The top route that lost the hit rate.
- A representative response header snippet showing `X-Cache`,
  `X-Cache-Profile`, `X-Cache-Reason`.
