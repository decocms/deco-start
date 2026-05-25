# Runbook: `tail-exception-spike`

> A site's tail-worker `_outcome=exception` count exceeded its own 24h rolling baseline by 3σ for ≥ 10 minutes.

## What this alert means

Real, uncaught exceptions are happening in the Worker — captured by
the tail consumer with 100% fidelity (`deco-otel-tail`). After Phase 1
severity reclassification, this alert specifically excludes `canceled`
and `responseStreamDisconnected` outcomes (those are client-disconnect
noise, not bugs). What's left is a true bug, OOM, or CPU-limit kill.

## First check (60 seconds)

```sql
-- What's blowing up, last 15 minutes
SELECT Body, LogAttributes['url.path'] AS path, count() AS n
FROM otel_logs
WHERE ServiceName = '{site}'
  AND SeverityText = 'ERROR'
  AND LogAttributes['_source'] = 'tail-worker'
  AND LogAttributes['_outcome'] = 'exception'
  AND Timestamp > now() - INTERVAL 15 MINUTE
GROUP BY Body, path
ORDER BY n DESC
LIMIT 30;
```

If 90% of the rows share the same `Body` (same exception class /
message), that's the bug — proceed to "Common causes" #1.

If the exceptions are scattered across many distinct messages, you
likely have a resource problem (OOM / CPU limit) — proceed to #2.

## Diagnostic queries

```sql
-- Outcome distribution — separate exception from exceededMemory / exceededCpu
SELECT
  LogAttributes['_outcome'] AS outcome,
  count() AS n
FROM otel_logs
WHERE ServiceName = '{site}'
  AND LogAttributes['_source'] = 'tail-worker'
  AND Timestamp > now() - INTERVAL 30 MINUTE
GROUP BY outcome
ORDER BY n DESC;
```

```sql
-- Did a specific deploy cause it?
SELECT
  LogAttributes['service.version'] AS version,
  LogAttributes['_outcome'] AS outcome,
  count() AS n
FROM otel_logs
WHERE ServiceName = '{site}'
  AND LogAttributes['_source'] = 'tail-worker'
  AND Timestamp > now() - INTERVAL 1 HOUR
GROUP BY version, outcome
ORDER BY n DESC;
```

```sql
-- Pull the full record for one offending request to get request.id
-- and trace.id for join queries
SELECT *
FROM otel_logs
WHERE ServiceName = '{site}'
  AND SeverityText = 'ERROR'
  AND LogAttributes['_source'] = 'tail-worker'
  AND LogAttributes['_outcome'] = 'exception'
  AND Timestamp > now() - INTERVAL 15 MINUTE
ORDER BY Timestamp DESC
LIMIT 1;
```

## Common causes & fixes

| Rank | Cause                                              | How to confirm                                                                | Fix                                                                                                              |
|------|----------------------------------------------------|-------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------|
| 1    | A single uncaught throw, recent deploy             | Same `Body` dominates; one `service.version` correlates                       | Roll back the deploy. File a bug with the offending stack + `request.id` for repro. Add a try/catch + structured `logger.error`. |
| 2    | `exceededMemory` (OOM)                             | Outcome query shows non-trivial `exceededMemory` count                        | Look for large in-memory buffers — a `Response.text()` on a multi-MB upstream, a runaway `JSON.parse`. See [`deco-site-memory-debugging`](https://github.com/decocms/deco-start/blob/main/.cursor/skills/deco-site-memory-debugging/SKILL.md) skill. |
| 3    | `exceededCpu` (CPU-limit kill)                    | Outcome query shows `exceededCpu`                                            | Investigate a section with a heavy synchronous loop. Move work to a server function or shed load via cache.       |
| 4    | A new upstream returning malformed responses      | `Body` references a third-party hostname; matches a known endpoint           | Add defensive parsing + a structured `logger.error` so the throw becomes a typed error, not a crash.             |

## Escalation

- `exceededMemory` / `exceededCpu` sustained → page site team + platform on-call. May indicate a leak that will recur until isolate restart.
- A throw we can't decode in 15 minutes → page site team owner.

## Post-mortem hook

- One full record from query #3 above — preserves the
  `request.id` / `trace.id` for cross-channel correlation.
- The dominant `Body` (the exception message).
- The `service.version` window.
- Whether the alert fired on `exception` or `exceededMemory` /
  `exceededCpu` — drives whether the post-mortem investigates code or
  resource bounds.
