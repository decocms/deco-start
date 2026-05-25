# RUM (Real-User Monitoring) — Plan

> Sibling deliverable to [`observability_refinement_plan_4fa41548.plan.md`](../../../.cursor/plans/observability_refinement_plan_4fa41548.plan.md).
> The refinement plan covers server-side observability end-to-end. This
> plan covers what runs **in the browser** — Core Web Vitals, JS errors,
> long tasks, resource timing, custom user-journey events.

## Why this is a separate plan

Server-side telemetry tells us what our Workers did. RUM tells us what
the **user actually experienced** — including everything outside our
edge (DNS, TLS handshake, third-party scripts, the user's CPU, their
flaky LTE link, their ad-blocker). The two answer different questions:

| Question | Answered by |
|---|---|
| "Did we serve the request?" | server outcomes (Phase 2 of refinement plan) |
| "Was the user able to read the page?" | RUM (this plan) |
| "Did our deploy regress LCP on iOS Safari?" | RUM (this plan) |
| "Why did checkout abandon at 73%?" | RUM + server outcomes joined |

Today the answer to every RUM question is "we don't know." The plan
puts a floor on that.

## Scope tiers — the decision you're making

The size of this plan changes by an order of magnitude depending on
scope. Three defensible tiers below; the work is **strictly additive**
between them so we can commit to Tier 1, run it for a quarter, and
upgrade to Tier 2 or 3 only if the data we collect surfaces a need.

### Tier 1 — Core Web Vitals + JS errors (recommended for v1)

**What's collected:**
- LCP (Largest Contentful Paint), CLS (Cumulative Layout Shift),
  INP (Interaction to Next Paint), FCP, TTFB — via the standard
  [`web-vitals`](https://github.com/GoogleChrome/web-vitals) library.
- `window.onerror` + `window.onunhandledrejection` — uncaught JS errors
  with stack, source URL, line/col, user agent, route pattern, deploy
  id, `request.id` (same one the server stamped in Phase 1, joinable to
  `otel_logs` and `otel_traces`).
- Page-context attributes: `route_pattern`, `service.version`,
  `service.name`, `deployment.environment`, viewport, connection type
  (`navigator.connection.effectiveType`), `cf-ray`.

**What's NOT collected:**
- Session replay.
- Custom user-journey events (add-to-cart, scroll-to-fold, etc.).
- Resource timing for every asset.
- User interaction heatmaps.

**Implementation footprint:** ~3 dev-weeks.
- `@decocms/start/sdk/rum.ts` — single browser-side module bundled into
  the site entry. Reads `web-vitals` (peer dep, ~3KB gzipped), batches
  events, sends to `/__deco/rum` on the same origin (no CORS / no
  third-party script).
- `cmsRoute.ts` already serves a worker; add a `/__deco/rum` handler
  that validates the payload, redacts referrer/URL via the shared PII
  library (Phase 1), and forwards to the OTLP HTTP endpoint as
  `otel_logs` with `SeverityText="INFO"` and `LogAttributes.rum.*`.
- ClickHouse rows land in the existing `otel_logs` table — no new
  schema, no new pipeline. The Tier 1 query "p75 LCP per route per
  site, last 7 days" is a single SQL join on the existing tables.
- One Grafana dashboard template added to
  `stats-lake/observability/dashboards/templates/site-rum.json`. Auto-
  provisioned via the existing Phase 5 script — `--with-rum` flag
  mirrors `--with-alerts`.

**Cost:** marginal. One row per pageview per metric (~5 rows / pageview)
adds < 5% to existing log volume. Within the cost guardrail dashboard
(Phase 6) headroom.

**Risks:**
- INP requires the modern API; falls back to FID on older browsers.
  Reported separately so the metric isn't muddied.
- `web-vitals` runs ~50ms of JS on first input; teams that obsess over
  shaving milliseconds will want a build flag to disable it. Ship one
  off the bat.

### Tier 2 — Tier 1 + custom user-journey events + resource timing

**What's added:**
- A typed `rum.track(name, attributes)` API exposed from
  `@decocms/start/sdk/rum.ts`. Sites call
  `rum.track('add_to_cart', { sku, price, currency })` and the event
  flows through the same `/__deco/rum` endpoint into `otel_logs` with a
  reserved attribute namespace (`rum.event.*`).
- Resource Timing API rollup: for each pageview, total resource bytes,
  count by content-type, slowest 5 URLs (with paths redacted). Helps
  diagnose when a third-party tag has gone bad.
- A `rum.identify(userIdHash)` call that lets sites cohort by logged-in
  user without sending PII (the site hashes the user id before passing
  it in; we never see plaintext).

**Implementation footprint:** ~6 additional dev-weeks on top of Tier 1.
- The framework-side API + types: ~2 weeks.
- Resource Timing payload shape + redaction: ~1 week.
- Documentation, codemod fixtures, and an audit rule that enforces
  the redaction helpers stay in use: ~3 weeks.
- A second Grafana dashboard (`site-rum-events.json`) that pivots on
  `rum.event.*`.

**Risks:**
- Cardinality explosion: a site that emits `track('view_product', { id })`
  with the product id as a label creates one time-series per SKU. The
  attribute system has to **enforce** id-as-attribute / id-not-as-label
  via the type system + a runtime check in the framework. Doable but
  it's the new piece that has to be designed right.
- Custom events drift across sites unless we standardize a vocabulary.
  Recommend shipping a small reserved-name list (`add_to_cart`,
  `begin_checkout`, `purchase`, `view_product`) so fleet-wide dashboards
  can roll up "conversion funnel" without per-site cooperation.

### Tier 3 — Tier 2 + session replay + interaction heatmaps

**What's added:**
- Session replay: capture every DOM mutation + every user input as a
  delta-encoded stream, replay it as a video in HyperDX / a custom
  viewer. The canonical OSS implementation is
  [`rrweb`](https://github.com/rrweb-io/rrweb).
- Interaction heatmaps: aggregate click positions over a page within a
  given time window.

**Implementation footprint:** months.
- ~30KB gzipped of `rrweb` on every pageview — measurable LCP impact.
  Mitigation: lazy-load after first interaction; some events miss the
  first paint.
- The replay payload is enormous (~100KB/min/session compressed).
  Multiplied by realistic session counts this is a 10-100× ingest
  blowup vs Tier 1. Replay storage is the new bottleneck, not the
  schema; we'd need an R2-backed cold tier separate from ClickHouse.
- A privacy review needs to ship before the first byte of replay
  flows. PII redaction has to happen client-side before the network —
  rrweb's "mask all inputs" mode is the floor; password fields, credit
  card numbers, and authenticated user-data attributes need explicit
  privacy classes.

**Risks:**
- Privacy: replay is a high-magnification footgun. One regression in
  the mask config and we've recorded a user's credit card. The whole
  payment-flow page must be force-masked at the framework level, not
  opt-in per site.
- Cost: 10-100× the ingest of Tier 1 even with aggressive sampling.
  The Phase 6 cost-guardrail dashboard will trip; needs a new tier of
  retention policies (replay rows expire at 30d, not 90d like logs).

## Out of scope (regardless of tier)

- **Synthetic monitoring.** Lighthouse runs against canonical journeys
  on a cron. Covers a different need — "would a clean browser have
  hit our SLO?" rather than "what did real users see?". A separate
  initiative if we want it.
- **Heatmaps for individual users.** Aggregate heatmaps only; never
  identifiable.
- **A/B-test attribution.** Sites that want it can pass an experiment
  cohort id through `rum.identify` — we don't ship the experiment
  framework itself.

## Recommended sequencing

Ship Tier 1 in one PR. Live with the data for a quarter. If during
that quarter the question "but what did the user actually click before
they bounced?" comes up more than twice, plan and ship Tier 2. If
during *that* quarter we hit a category of bug that can only be
diagnosed by replay (so far: 0), plan Tier 3.

**Anti-recommendation:** do not commit to Tier 3 up front. Replay is
the highest-cost, highest-privacy-risk piece of the whole observability
surface, and the bug categories that genuinely need it are rare.

## Decision points

These mirror the main plan's structure — answer once, then this
document gets a follow-up PR turning answers into TODOs.

1. **Tier selection.** Tier 1 only / Tier 1 + Tier 2 / Full Tier 3.
2. **Identify hashing.** If we're shipping Tier 2, do sites pass in a
   client-side hash, or do we accept plaintext IDs and hash at the
   ingest worker? (Recommend client-side hash — keeps plaintext out of
   our pipeline entirely.)
3. **Sampling.** RUM events are cheap per-row but high-volume. Default
   sample rate: 100% (Tier 1), 100% (Tier 2 events), 10% (Tier 3
   replay). Confirm or revise per tier.

## Files this plan would touch (Tier 1)

```
deco-start/
├── src/sdk/rum.ts                  # NEW — browser-side instrumentation
├── src/sdk/rum.server.ts           # NEW — /__deco/rum handler
├── src/admin/setup.ts              # ROUTE — mount /__deco/rum
├── src/sdk/observability.ts        # EXPORT — re-export rum API
├── package.json                    # DEP — add `web-vitals` peer dep
└── docs/rum.md                     # NEW — site-side usage docs

stats-lake/observability/
└── dashboards/templates/site-rum.json   # NEW
```

## Why this is a plan and not an implementation

The user explicitly asked for RUM to be in a separate plan document
rather than rolled into the refinement plan. The scope-tier decision
above is the single highest-leverage choice; everything downstream
follows from it, and "Tier 3 because Tier 3 is biggest" is the wrong
default. A 30-minute conversation on the tier choice saves weeks of
work in the wrong direction.

Open the matching Linear / GitHub issue once a tier is selected.
