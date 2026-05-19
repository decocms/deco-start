# Per-site recipe — adopt the `deco-otel-tail` tail worker

> **Status:** gated. Do NOT roll out to the fleet until the canary site
> (`casaevideo-tanstack`) has completed a 7-day soak with no false negatives
> in tail capture and no infrastructure cost shock from the tail-handler
> invocations. See [D-8 in `MIGRATION_TOOLING_PLAN.md`](../MIGRATION_TOOLING_PLAN.md)
> for the decision record and [`docs/observability.md`](./observability.md)
> for the architecture.

This is the mechanical recipe for opting any deco storefront worker into
the [`deco-otel-tail`](https://github.com/decocms/stats-lake/tree/main/ingestion/otel-tail)
Cloudflare Tail Worker (Strategy B). One PR per storefront repo, two
file-level changes per PR.

## Preconditions

Before opening any per-site PR:

1. **The tail worker is deployed.** Verify via the Cloudflare dashboard
   (`Workers & Pages → deco-otel-tail`) or:

   ```bash
   cd decocms/stats-lake/ingestion/otel-tail
   wrangler deployments list
   ```

   You want to see at least one deployment with the `INGEST: deco-otel-ingest`
   service binding.

2. **The producer worker is in the same Cloudflare account.** The
   `tail_consumers` mechanism cannot reference workers in a different
   account. Every deco fleet worker is in `c95fc4cec7fc52453228d9db170c372c`
   (the `decocms - production` enterprise account), so this is normally
   true — but a future split would invalidate the recipe.

3. **The producer worker is on `@decocms/start >= 5.3.0`.** Older versions
   don't ship the three-channel error capture model and the sampling flip
   in step 2 below will silently drop info/warn diagnostics that some
   dashboards still depend on. If the site is below 5.3.0, bump it first.

## The PR (~5 lines of producer-side wrangler change)

In the storefront repo, edit `wrangler.jsonc`:

### Step 1 — Wire the tail consumer

Add at the top level (anywhere is fine; we conventionally place it near the
other producer-level keys like `kv_namespaces`):

```jsonc
"tail_consumers": [
  { "service": "deco-otel-tail" }
],
```

Cloudflare will now invoke `deco-otel-tail` on every execution of this
worker, regardless of outcome. The tail worker itself filters down to
the "interesting" subset before forwarding anything — see
[`stats-lake/ingestion/otel-tail/src/index.ts`](https://github.com/decocms/stats-lake/blob/main/ingestion/otel-tail/src/index.ts).

### Step 2 — Flip `observability.logs.head_sampling_rate`

Inside the existing `observability.logs` block:

```jsonc
"observability": {
  "logs": {
    // ...other settings...
    "head_sampling_rate": 0.01,   // was 1 — see docs/observability.md
  }
}
```

This drops info/warn CF Destinations log volume by 100x. Errors are NOT
affected — they're now covered by:

- the in-Worker direct-POST channel for framework `logger.error(...)`
  (100%, rate-limited), and
- the tail worker for everything else (uncaught throws, exhaustion
  outcomes, raw `console.error` from third-party SDKs — all 100%).

If the site has dashboards or alerts that depend on info-level log
volume, audit them before flipping. Don't be heroic — keep the previous
rate temporarily, document the dashboard dependency, fix the dashboard,
then flip in a follow-up.

### Conventional commit + PR body

The change is mechanically trivial. Use:

```
feat(observability): adopt deco-otel-tail + drop logs sampling to 1%

- Wire `tail_consumers` to deco-otel-tail (100% capture of uncaught
  throws / exceededCpu / raw console.error).
- Drop `observability.logs.head_sampling_rate` from 1 to 0.01 now that
  errors are covered by the direct-POST + tail channels.

Implements Strategy B (D-8) for this site. See
decocms/deco-start/docs/observability.md, "Error capture — three-channel
model" for the coverage matrix.
```

## Per-site post-deploy validation (60s ceremony)

After the wrangler change ships, hit any route on the deployed worker
that produces an error log, then verify the row lands in ClickHouse with
`Attributes['_source'] = 'tail-worker'`:

```sql
SELECT Timestamp, ServiceName, SeverityText, Body,
       Attributes['_outcome'] AS outcome,
       Attributes['_source']  AS source
FROM otel_logs
WHERE ServiceName = '<your-worker-name>'   -- e.g. 'casaevideo-tanstack'
  AND Attributes['_source'] = 'tail-worker'
  AND Timestamp > now() - INTERVAL 5 MINUTE
ORDER BY Timestamp DESC
LIMIT 20;
```

If you get zero rows after 5 minutes of normal traffic, the most likely
causes are:

1. The producer's `tail_consumers` block didn't land (rare — wrangler
   would have errored out). Double-check the deployed `wrangler.jsonc`
   via `wrangler deployments view`.
2. The site is in a Cloudflare account different from `decocms - production`.
   See "Preconditions" above.
3. `deco-otel-tail` is unhealthy. Tail it directly:

   ```bash
   cd decocms/stats-lake/ingestion/otel-tail
   wrangler tail
   ```

## Rollout batching

Open per-site PRs in batches of 10–20 to keep CI load manageable and to
make it easy to roll back a batch if a regression sneaks in. The change
is mechanically identical across all sites, so a single shared template
can be used. Track adoption state in a fleet-rollout issue on
[`decocms/deco-start`](https://github.com/decocms/deco-start/issues) so
it's a single source of truth for who's onboarded.

## When NOT to use this recipe

- **Site does NOT use `@decocms/start`.** The recipe only covers fleet
  workers that already participate in the three-channel observability
  model. Sites on other frameworks should adopt the recipe after their
  own observability story stabilises.
- **Site is in a different Cloudflare account.** The `tail_consumers`
  service reference would fail to resolve. Either consolidate the site
  into the `decocms - production` account or stand up an account-local
  copy of `deco-otel-tail` first (and update the service name in
  `tail_consumers` accordingly).
- **Site has a high-info-log diagnostic culture.** If the team genuinely
  uses info-level CF Destinations logs for daily debugging — and is
  willing to pay for the volume — keep `logs.head_sampling_rate` at 1
  for that site and skip step 2. Only adopt step 1 (`tail_consumers`).
  Document the deviation in the PR description.
