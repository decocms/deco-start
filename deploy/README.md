# `deploy/` — central wrangler template

This directory holds **`wrangler-template.jsonc`** — the canonical wrangler config
that every storefront on the platform inherits. It is consumed by the reusable
GitHub workflows under [`.github/workflows/`](../.github/workflows/)
(`deploy.yml`, `preview.yml`, `sync-secrets.yml`) and by the local
`deco-wrangler` CLI.

There is **no per-site registry**. Worker name is the storefront repo basename
by convention (`deco-sites/baggagio-tanstack` → worker `baggagio-tanstack`).
Anything that must vary deterministically per worker (like the Analytics Engine
dataset name) is encoded as a substitution token in the template — see
[Substitution tokens](#substitution-tokens) below.

## Trust model

The deploy is gated by the `decocms-deployer` **GitHub App** being installed on
the target storefront repo:

1. The storefront's caller workflow mints a short-lived App-installation token.
2. It calls `gh workflow run deploy.yml --repo decocms/deco-start -f site_owner=… -f site_name=…`.
3. The central deploy workflow runs **in this repo's context** and itself mints
   another short-lived App-installation token to check out the storefront. If
   the App isn't installed on `<site_owner>/<site_name>`, the mint fails and
   the deploy never starts.
4. The central workflow then runs build + `wrangler deploy` using
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from this repo's plain
   repo secrets.

Properties this gives:

- **CF credentials never leave decocms/deco-start.** The storefront repo holds
  zero Cloudflare credentials — it only has the GitHub App credentials, which
  can be used solely to trigger workflows on this repo.
- **Worker naming is convention-based and not customer-controlled.** A
  customer with push access to their own storefront cannot rename the worker
  their deploy lands on (the central workflow always uses
  `inputs.site_name` as the worker name; modifying the caller stub to pass a
  different `site_name` would also require the App to be installed on that
  other repo).
- **Force-rollback is impossible for production.** The central deploy
  workflow ignores any caller-supplied sha and always resolves the
  storefront's current default-branch HEAD itself. The worst a compromised
  storefront can do across tenants is trigger a no-op redeploy of another
  storefront's current main.

`deploy/` and `scripts/deploy/` and the central workflow files are
CODEOWNERS-protected — only the platform team approves changes.

### Where Cloudflare credentials live

| Secret class | Lives in | How it reaches the worker |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | this repo's **repo secrets** | central workflow runs in this repo's context, env-var resolves natively |
| `DECOCMS_DEPLOYER_APP_ID` / `DECOCMS_DEPLOYER_APP_PRIVATE_KEY` | this repo's repo secrets AND deco-sites org-level secrets | mints short-lived installation tokens for both directions of the dispatch flow |
| `SECRET_*` runtime secrets (per site) | this repo's `<site_name>-secrets` GitHub Environment | `sync-secrets.yml` binds to that environment, reads `SECRET_*` from `${{ secrets }}`, runs `wrangler secret put` |

To rotate Cloudflare credentials, edit them in this repo only. To rotate a
runtime secret for one storefront, edit the corresponding environment in this
repo only. No storefront PR needed for either.

## How `wrangler.jsonc` is generated

At deploy time, the central workflow runs
[`scripts/deploy/build-wrangler-config.mjs`](../scripts/deploy/build-wrangler-config.mjs),
which:

1. Loads `deploy/wrangler-template.jsonc`.
2. Substitutes `$WORKER_*` tokens (see below) using the worker name passed by
   the central workflow (= storefront repo basename).
3. Writes the result to `./wrangler.jsonc` in the storefront checkout, with
   `name` injected as the first key.

`account_id` is never written to JSON — wrangler reads it from
`CLOUDFLARE_ACCOUNT_ID` (env var in CI; `wrangler login` locally). This way a
typo cannot misroute a deploy to a different Cloudflare account.

### Substitution tokens

Any string in the template containing one of these literals is replaced at
build time:

| Token | Replacement | Example use |
|---|---|---|
| `$WORKER_NAME` | worker name verbatim | rare; mostly available for parity |
| `$WORKER_UNDERSCORE` | worker name with `-` → `_` | `analytics_engine_datasets[].dataset` (must be a valid Postgres-style identifier) |

To add a new derived field, add the token wherever it makes sense in
`wrangler-template.jsonc`. Anything not in the substitution table appears
verbatim in the generated config.

## Adding a new site

1. Install the `decocms-deployer` GitHub App on the new storefront repo
   (Settings → Integrations → GitHub Apps in the deco-sites org).
2. Add the four caller workflow stubs to the new repo (copy from any existing
   storefront's `.github/workflows/{deploy,preview,sync-secrets,regen-blocks}.yml`).
3. Add `wrangler.jsonc` to the new repo's `.gitignore` and add the
   `gen:wrangler` / `predev` / `prebuild` / `types` scripts to `package.json`
   so local dev still works (use any existing storefront as a template).
4. If the site needs runtime secrets, create a new environment in this repo
   named `<repo-basename>-secrets` and add the `SECRET_*` values there. Set
   environment protection rules to grant the site team self-service access to
   their own environment.
5. Push to `main` and verify the deploy lands on a worker named after the repo.

## Migrating an existing site whose worker name doesn't match its repo

Two cases to be aware of:

- **Worker rename.** The worker created by the first deploy will use the repo
  basename. If an old worker exists with a different name (e.g.
  `miess-01-tanstack` repo whose old worker was `miess-tanstack`), you'll need
  a manual cutover: deploy the new worker, re-attach custom domain routes via
  the Cloudflare dashboard, copy any wrangler secrets, then delete the old
  worker. There is intentionally no per-site override for this — these cases
  are rare and best resolved at the CF layer.
- **AE dataset rename.** The dataset name is derived from worker name, so a
  worker rename also changes the AE dataset. Old data remains queryable under
  the old dataset name; new data goes to the new name. Update Grafana panels
  and saved queries accordingly.
