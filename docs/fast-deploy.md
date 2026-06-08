# Fast Deploy — KV-First Content Delivery

Decouple CMS **content** updates from worker **code** deploys. Content is served
from Cloudflare KV with the bundled `blocks.gen` snapshot as fallback; only code
changes trigger `wrangler deploy`. Studio publishes propagate in seconds instead
of a full CI + redeploy cycle.

## How it works (whole-snapshot swap)

The CMS resolver reads `loadBlocks()` **synchronously** in many hot-path places.
Rather than make all of that async, KV stores the **entire decofile as one
value**; each isolate loads it once on cold start and swaps the in-memory map
via `setBlocks()`. The resolution hot path stays synchronous — KV is touched only
on cold start and during a throttled revision poll.

```
COLD START (per isolate)   first request → await KV decofile:current → setBlocks()
EVERY REQUEST              throttled (10s) ctx.waitUntil poll of index:revision →
                           reload + setBlocks() when it changed
RESOLUTION                 loadBlocks() — in-memory, synchronous (unchanged)
PUBLISH (POST /.decofile)  merge delta → setBlocks() → write KV → other isolates
                           converge within one poll interval
KV DOWN / not migrated     serve the bundled blocks.gen snapshot (no behavior change)
```

## KV data model (one namespace per site)

| Key | Value | Notes |
|-----|-------|-------|
| `decofile:current` | full decofile JSON (the blocks map) | runtime source of truth |
| `index:revision` | DJB2 hex hash of the snapshot | polled for change detection |

`index:revision` **must** equal `computeRevision(blocks)` (`src/cms/blockSource.ts`,
DJB2 over `JSON.stringify`) — the runtime, the write-through path, and the CI
scripts all use that one function so a hydrating isolate computes a matching
revision and the poller doesn't loop. The original plan's `block:<name>` /
`index:pages` / `index:manifest` keys are unnecessary in the snapshot model.

## Feature flag

Activation requires **both**, by design:

1. `DECO_FAST_DEPLOY = "1"` (or `"true"`) — an explicit per-site opt-in, and
2. the **`DECO_KV` binding** present on the Worker `env`.

With either missing, behavior is identical to today (bundled snapshot only).
Requiring the explicit flag means simply binding a KV namespace can never
silently flip a site onto the KV read/write path. To disable, unset
`DECO_FAST_DEPLOY` (or set it to `"0"`).

```toml
# wrangler.toml (per migrated site)
[[kv_namespaces]]
binding = "DECO_KV"
id = "<namespace id>"

[vars]
DECO_FAST_DEPLOY = "1"
```

## Read path (runtime)

- `src/cms/blockSource.ts` — `BlockSource` interface, `BundledBlockSource`,
  `computeRevision`, `KV_KEYS`, minimal `KVNamespace` type.
- `src/cms/kvBlockSource.ts` — `KVBlockSource` reads the two keys.
- `src/sdk/kvHydration.ts` — `ensureBlocksHydrated(env, ctx)` (cold start),
  `maybePollRevision(env, ctx)` (throttled `waitUntil` poll), `isFastDeployEnabled`.
- Wired into `src/sdk/workerEntry.ts` `handleRequest`, before admin routes.

Cold start **awaits** the KV snapshot (one ~10–30ms hit per isolate) to guarantee
fresh content — the bundled snapshot is frozen at the last code deploy.

## Write path (publish)

`POST /.decofile` (`src/admin/decofile.ts` → `handleDecofileReload`) accepts:

- **Delta** envelope (preferred): `{ "blocks": { "<name>": <json> | null } }` —
  `null` deletes a block. Identified by a body with exactly one top-level key,
  `blocks`, holding an object.
- **Full** decofile map (backward-compatible; dev Vite plugin path).

It merges → `setBlocks()` (immediate local visibility + revision bump), then
writes `decofile:current` + `index:revision` to `DECO_KV` (resolved via
`getRuntimeEnv()`). Response includes `mode` (`"delta"`/`"full"`), `revision`,
and `kvWritten`. A failed KV write does not fail the request (`kvWritten:false`);
the caller may retry. Cache purge is a **separate** `POST /_cache/purge` call.

## CI scripts

- `deco-migrate-blocks-to-kv` (`scripts/migrate-blocks-to-kv.ts`) — one-shot KV
  population from `.deco/blocks/*.json`. Dry-run by default; `--write` applies and
  verifies. Run once before flipping a site to KV-first.
- `deco-sync-blocks-to-kv` (`scripts/sync-blocks-to-kv.ts`) — CI content sync.
  Default mode skips when no `.deco/blocks/*.json` changed since `--since`;
  `--all` always writes. Writes the full snapshot, bumps the revision, and
  optionally `POST`s `/_cache/purge` for changed page paths.

Both use the KV REST API (CI has no binding) — env `CF_ACCOUNT_ID`,
`CF_KV_NAMESPACE_ID`, `CF_API_TOKEN` (stored as GitHub secrets).

## Cross-repo contracts (implemented elsewhere)

**admin.deco.cx (Studio):** on publish, `POST` a delta envelope to the site's
`/.decofile`, then `POST` affected paths to `/_cache/purge`. Dispatch the
deco-sync-bot commit in parallel (off the critical path). Gate on a per-site
`fast_deploy_enabled` capability. Bulk publish = one delta payload.

**Site CI:** provision a KV namespace + `DECO_KV` binding; store CF KV REST creds
as secrets. New `sync-content-to-kv.yml` (push to `main`, detects
`.deco/blocks/*.json` changes, runs `deco-sync-blocks-to-kv`, purges; never blocks
deploys). `deploy.yml` runs only on code changes and runs
`deco-sync-blocks-to-kv --all` once post-deploy for bootstrap. `regen-blocks.yml`
(bundled snapshot) is unchanged.

## Rollout & rollback

1. Ship the framework (flag off everywhere → inert). 2. Migrate one playground
site (`deco-migrate-blocks-to-kv --write`); verify both keys, reads, latency.
3. Migrate one production site; monitor a week. 4. Enable Studio
`fast_deploy_enabled`. 5. Batch-roll out.

**Rollback:** unset `DECO_FAST_DEPLOY` / set it to `"0"` (or remove the `DECO_KV`
binding) → the worker serves the bundled snapshot immediately. No content
redeploy needed.

## Known limitations

- **Module-level `loadBlocks()` consumers** (e.g. `loadRedirects(loadBlocks())`
  at the top of a worker-entry) read the *bundled* snapshot at module init,
  before KV hydration — they won't see KV updates. Move such reads into the
  request path (or re-run on `onChange`) to fast-deploy them.
- Sub-ms revision polling via the Cache API and per-block granular KV reads are
  possible future optimizations; the `BlockSource` interface leaves room for them.
