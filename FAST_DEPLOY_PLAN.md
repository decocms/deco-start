# Fast Content Deploy — Implementation Plan

> Decouple CMS content from worker deploys. Studio writes go to Cloudflare KV directly; the same warm worker reads from KV. Only code changes trigger `wrangler deploy`.

## Goals

1. Content-only changes in Studio do not redeploy the worker. No CI run, no isolate restart, no cold caches.
2. Local development and code-driven content changes (PRs that modify `.deco/blocks/*.json`) continue to work without any KV dependency.
3. PR merges to `main` that touch content propagate to KV without requiring a code redeploy.
4. The bundled `blocks.gen` snapshot is preserved as a fallback for cold-start, KV outage, local dev, and atomic rollbacks.

## Architecture

### Layers and responsibilities

| Layer | Owns |
|---|---|
| **Studio (admin.deco.cx)** | Source of intent for edits. Writes to KV (live state) and triggers deco-sync-bot (history). |
| **deco-sync-bot** | Async commits `.deco/blocks/*.json` to the site repo for version history and disaster recovery. Unchanged from today. |
| **Site CI** | On `main` merge: diffs against `main^`, propagates content-only changes to KV. Runs `wrangler deploy` only when code changes. |
| **`@decocms/start` framework** | Block source abstraction. KV-first reads with per-isolate LRU and bundled snapshot fallback. Async resolution pipeline. |
| **Cloudflare KV (one namespace per site)** | Live source of truth for CMS content at runtime. |

### KV data model

One namespace per site. Keys:

| Key | Value | Purpose |
|---|---|---|
| `block:<name>` | block JSON | one entry per `.deco/blocks/<name>.json` |
| `index:pages` | `[{ path, blockKey, specificity }]` sorted by specificity | route table consumed by `findPageByPath` |
| `index:revision` | monotonic integer (string) | bumped on every write; isolates poll this |
| `index:manifest` | `{ blockNames: string[], hash, generatedAt }` | snapshot manifest for diagnostics and warmup |

### Read path

```
request
  └─ resolveDecoPage(path)
      ├─ pageIndex = await blockSource.getPageIndex()    ← LRU → KV → bundled fallback
      ├─ pageEntry = findPageByPath(path, pageIndex)
      ├─ pageBlock = await blockSource.getBlock(pageEntry.blockKey)
      └─ traverse __resolveType refs
          └─ Promise.all(refs.map(ref => blockSource.getBlock(ref)))
```

Three layers, in order, behind a single `BlockSource` interface:

1. **Per-isolate LRU.** ~500 entries in-process Map. Hits cost <0.01ms.
2. **Cloudflare KV** via `env.DECO_KV`. p50 ~10ms warm region, ~30ms cold.
3. **Bundled `blocks.gen`** snapshot — kept as today but demoted to fallback. Used when KV is empty, unreachable, or the binding is missing (local dev).

### Write path

Studio publishes a block:
1. Studio POSTs the changed block(s) to the site's `/.decofile` admin endpoint with the existing `DECO_RELEASE_RELOAD_TOKEN` auth.
2. Site framework writes each block to `block:<name>`, rewrites `index:pages` if the change touched a `pages-*` block, bumps `index:revision`.
3. Site framework calls `/_cache/purge` to evict affected edge cache keys.
4. deco-sync-bot asynchronously commits `.deco/blocks/<name>.json` to the site repo (existing behavior, unchanged).

PR merge to `main` that changes content:
1. Existing `regen-blocks.yml` runs `generate-blocks` (rebuilds bundled snapshot for the *next* deploy).
2. New CI step diffs `.deco/blocks/*.json` against `main^`. For each changed file: write to `block:<name>`. For each `pages-*` change: rewrite `index:pages`. Bump `index:revision`. Call `/_cache/purge`.
3. `deploy.yml` runs only if code changed.

### Cross-isolate invalidation

Plain revision-key polling. Each isolate caches its known `index:revision` in-memory. Reads to `index:revision` go through Cloudflare Cache API with a 5–10 second TTL — most polls cost <1ms, one in N hits KV at ~10ms. On revision change, the isolate drops its LRU and refreshes `index:pages`.

Editor instant preview is unaffected. Studio's existing iframe preview POSTs blocks inline to the worker for hot-reload, bypassing both KV and edge cache.

### Conflict policy

Last-writer-wins per block. `index:revision` is strictly monotonic. If a CI merge writes a block that Studio also recently edited, the CI write wins (matches today's "main always overrides Studio via deco-sync-bot" model).

---

## Framework changes (`@decocms/start`)

### DO

1. **Introduce a `BlockSource` abstraction.** New module: `src/cms/sources/`.
   - `BlockSource` interface: `getBlock(name)`, `getBlocks(names)`, `getPageIndex()`, `getRevision()`. All async.
   - `BundledBlockSource` — wraps today's `blocks.gen` import. Used in dev and as fallback.
   - `KVBlockSource` — reads from `env.DECO_KV`. Production primary.
   - `LayeredBlockSource` — composes per-isolate LRU + primary + fallback. Polls revision on a 5–10s Cache API window and drops LRU on change.

2. **Make `src/cms/loader.ts` async.**
   - Replace `setBlocks(map) / loadBlocks(): map` globals with a `getBlockSource()` accessor.
   - `loadBlock(name): Promise<Block>` is the new primitive.
   - `findPageByPath` consumes `index:pages` instead of scanning all `pages-*` entries in memory.

3. **Refactor `src/cms/resolve.ts` to async.**
   - Every `loadBlocks()` call site becomes `await loadBlock(name)`.
   - Parallelize `__resolveType` traversal with `Promise.all` so refs at the same tree depth resolve concurrently.
   - Preserve eager vs deferred section split. The eager set is fetched in one parallel batch; deferred rawProps cache stays per-isolate (no behavior change).

4. **Wire `env.DECO_KV` through `setRuntimeEnv(env)` in `src/sdk/workerEntry.ts` (already line 1012).** No new plumbing needed — the binding is read via `getRuntimeEnv()` inside `KVBlockSource`.

5. **Extend `src/admin/decofile.ts`:**
   - `handleDecofileReload` accepts either a full block map (today) or a delta `{ blocks: { name: blockJson | null }, bumpedBy?: "studio" | "ci" }`. `null` deletes a block.
   - When `env.DECO_KV` is present, write through to KV: per-block `put`, rewrite `index:pages` if any `pages-*` changed, bump `index:revision`, write `index:manifest`.
   - After write: call the existing `/_cache/purge` flow with the affected segment keys.
   - Continue to call `setBlocks()` for in-memory bookkeeping so the current isolate sees the change immediately without a polling cycle.

6. **Bundled snapshot stays.** `scripts/generate-blocks.ts` continues producing `blocks.gen.json` + `blocks.gen.ts` exactly as today. Vite plugin behavior unchanged. The snapshot is the fallback `BundledBlockSource`.

7. **Add `scripts/sync-blocks-to-kv.ts`.** A standalone Node script invoked by CI:
   - Args: `--namespace <KV_NAMESPACE_ID>` `--account <ACCOUNT_ID>` `--diff <base..head>` `--all`
   - Reads `.deco/blocks/*.json`, computes the diff vs the base ref (or all on `--all`), writes per-block to KV via Cloudflare API, rewrites `index:pages` if pages changed, bumps `index:revision`, writes `index:manifest`.
   - Same logic as the admin-endpoint write path, factored so both share a `kvWriter` module.

8. **Add a one-time migration script `scripts/migrate-blocks-to-kv.ts`.** Reads a site's full `.deco/blocks/*.json` directory, writes everything to KV, builds the initial `index:pages` and `index:revision`. Idempotent.

9. **Observability.** Emit OTel spans for `blockSource.getBlock` (per name), `blockSource.getPageIndex`, and revision changes. Tag with `source = lru | kv | bundled`.

### DO NOT

1. Do not remove the bundled snapshot or `blocks.gen` pipeline. It stays as fallback.
2. Do not introduce a Durable Object for revision pub/sub. Polling is sufficient for v1.
3. Do not move section-level caches (`sectionLoaders.ts` layout cache, deferred rawProps) to KV. They stay per-isolate.
4. Do not introduce per-page denormalized snapshot keys in KV. Per-block is the only storage unit.
5. Do not change the section registry (`src/cms/registry.ts`) or schema generation (`scripts/generate-schema.ts`). Code-shape changes still require deploys.
6. Do not change Vite plugin behavior or the dev hot-reload path (`POST /.decofile` in dev). Local dev hits `BundledBlockSource` only.
7. Do not invent a "section" as a first-class storage unit. Sections live inside blocks.
8. Do not block Studio writes on KV write completion if both KV write and edge purge can be fire-and-forget after acknowledging the write to memory. Acknowledge fast, KV-write in `ctx.waitUntil`.

### Critical files

| File | Change kind |
|---|---|
| `src/cms/loader.ts` | Replace globals with `BlockSource` accessor. Make read API async. |
| `src/cms/resolve.ts` | Async refactor of every `loadBlocks()` call. Promise.all on ref traversal. |
| `src/cms/sectionLoaders.ts` | Unchanged behavior; underlying `loadBlock` becomes async. |
| `src/admin/decofile.ts` | Write-through to KV when binding present. Delta payload support. |
| `src/sdk/workerEntry.ts` | No structural change. `env.DECO_KV` flows through existing `setRuntimeEnv`. |
| `src/cms/sources/BlockSource.ts` *(new)* | Interface. |
| `src/cms/sources/BundledBlockSource.ts` *(new)* | Today's behavior, wrapped. |
| `src/cms/sources/KVBlockSource.ts` *(new)* | KV reads. Revision polling. |
| `src/cms/sources/LayeredBlockSource.ts` *(new)* | LRU + composition + revision watcher. |
| `src/cms/sources/kvWriter.ts` *(new)* | Shared write logic used by both admin endpoint and CI script. |
| `scripts/sync-blocks-to-kv.ts` *(new)* | CI-invoked diff propagator. |
| `scripts/migrate-blocks-to-kv.ts` *(new)* | One-shot per-site migration. |
| `scripts/generate-blocks.ts` | Add optional `--emit-page-index` to also produce `index:pages` shape. |

---

## CI changes (site repos)

### DO

1. **Add a KV namespace per site** at provisioning time. Bind to `wrangler.toml` as `DECO_KV`. Add `KV_NAMESPACE_ID` and `CLOUDFLARE_ACCOUNT_ID` to GitHub secrets.

2. **Add a new workflow `sync-content-to-kv.yml`** triggered on push to `main`:
   - Checks out with `fetch-depth: 0` so it can diff against `main^`.
   - Detects whether the push changed any `.deco/blocks/*.json` (skip if none).
   - Detects whether the push changed any code (anything outside `.deco/blocks/` and the generated snapshot).
   - Runs `npx @decocms/start sync-blocks-to-kv --diff main^..HEAD --namespace $KV_NAMESPACE_ID --account $CLOUDFLARE_ACCOUNT_ID`.
   - Calls the site's `/_cache/purge` with the appropriate token.
   - This job runs regardless of code changes.

3. **Update `deploy.yml`:**
   - Only run when code changed (path filter excludes `.deco/blocks/**` and `src/server/cms/blocks.gen.*`).
   - On successful deploy, run `sync-blocks-to-kv --all` once to ensure KV is in sync with the bundle that just shipped (paranoia / first-deploy bootstrap).

4. **Keep `regen-blocks.yml`** as-is. It produces the bundled snapshot used both for fallback and for the deploy. Order matters: `regen-blocks` → `sync-content-to-kv` (if content changed) → `deploy` (if code changed).

5. **Initial migration.** Before flipping a site to KV-first, run `npx @decocms/start migrate-blocks-to-kv --namespace $KV_NAMESPACE_ID --account $CLOUDFLARE_ACCOUNT_ID` once. Verify `index:pages` and `index:revision` exist. Then deploy the site with the new framework version.

### DO NOT

1. Do not remove `regen-blocks.yml` or stop generating `blocks.gen.json`. The bundled snapshot is the fallback.
2. Do not run `deploy.yml` on content-only changes once a site is migrated. Path filters must exclude content.
3. Do not run `sync-content-to-kv.yml` on PR branches. Only `main`. PR previews use bundled snapshots from their own branch.
4. Do not write KV tokens into the repo. Use GitHub secrets and OIDC where possible.

---

## Studio changes (admin.deco.cx)

### DO

1. **Switch the publish path from "commit + wait for redeploy" to "POST to site + commit async."**
   - On publish, immediately POST the changed block(s) to `https://<site>/.decofile` with `Authorization: ${DECO_RELEASE_RELOAD_TOKEN}` and a delta payload `{ blocks: { name: blockJson }, bumpedBy: "studio" }`.
   - The site acknowledges fast (LRU updated, KV write deferred via `waitUntil`).
   - In parallel, dispatch the existing deco-sync-bot commit. The commit is no longer on the critical path for liveness.

2. **Surface the revision** in the publish UI. After a successful POST, show the new `index:revision` so editors can verify propagation if they care.

3. **Iframe preview** stays as it is today (inline POST of the modified blocks for hot-reload). It does not need to write to KV — it is editor-local state.

4. **Per-site feature flag.** Studio reads a site capability flag (`fast_deploy_enabled`) before using the KV write path. Sites not yet migrated continue to rely on the deco-sync-bot + CI redeploy path. The site exposes its capability via `GET /live/_meta` or a dedicated `GET /deco/capabilities` endpoint.

5. **Bulk publish.** When an editor publishes multiple blocks at once, send them as a single delta payload (one POST, one revision bump, one cache purge). Avoid per-block fanout from Studio.

### DO NOT

1. Do not write to the site repo directly from Studio. The deco-sync-bot path stays. Studio's job is to update live state (KV via the site endpoint) and trigger the bot.
2. Do not block the editor's publish action on KV write completion. Acknowledge on memory update.
3. Do not invent a new write protocol. Reuse the existing `POST /.decofile` admin endpoint and its auth.
4. Do not call KV directly from Studio. All KV writes go through the site's admin endpoint so authorization, validation, indexing, and cache purge stay centralized in the framework.

---

## Rollout

1. **Land the framework changes behind a flag.** If `env.DECO_KV` is absent, the framework behaves exactly as today (BundledBlockSource only). Existing sites are unaffected by an `@decocms/start` upgrade.
2. **Migrate one playground site** end-to-end. Provision KV namespace, run `migrate-blocks-to-kv`, deploy with the new framework, verify reads and writes.
3. **Migrate one production site** (e.g. casaevideo). Same steps. Watch p50/p95 latency, cache hit rates, error rates for one week before broader rollout.
4. **Enable the Studio capability flag** for that site so editor publishes hit KV.
5. **Roll out to remaining sites** in batches.

## Verification

1. **Local dev (no KV binding).** `vite dev` works identically to today. Blocks served from `BundledBlockSource`. No KV calls.
2. **Cold KV read.** Fresh isolate, empty LRU. First request to a page touches KV; subsequent requests for the same page hit LRU. Verify via OTel spans tagged with `source`.
3. **Studio write end-to-end.** Publish a block in Studio → POST lands on site → KV updated → revision bumped → edge cache purged → next request returns new content within the polling window (~5–10s).
4. **CI content-only PR.** Open a PR that only changes `.deco/blocks/*.json`, merge it. Confirm `sync-content-to-kv.yml` runs, `deploy.yml` does NOT run, content is live in KV within seconds.
5. **CI code+content PR.** Both run; deploy lands first, KV sync runs after, no observable downtime.
6. **KV outage simulation.** Block `env.DECO_KV` calls in a staging worker. Confirm the worker falls back to `BundledBlockSource` and continues serving correctly.
7. **Rollback drill.** Roll the worker back to a prior bundle. Confirm that, in the absence of fresh KV writes, the bundled snapshot is served. Then verify a Studio write still propagates correctly to the rolled-back worker.
8. **Perf regression.** Run the e2e perf suite (deco-e2e-testing) against casaevideo on both bundle-only and KV modes. Compare p50/p95 page render time, cache hit rate, lazy section load time. Acceptable: KV cold reads add <30ms on first hit per block; warm reads indistinguishable from today.
9. **Conflict drill.** Edit a block in Studio, then immediately merge a PR that changes the same block. Confirm CI write wins, revision is monotonic, no torn state.
