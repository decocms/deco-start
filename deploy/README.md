# `deploy/` — central deploy registry

This directory is the single source of truth for **what gets deployed where**
across every storefront on the platform. It is consumed by the reusable GitHub
workflows under [`.github/workflows/`](../.github/workflows/) (`deploy.yml`,
`preview.yml`, `sync-secrets.yml`) and by the local `deco-wrangler` CLI.

## Files

| File | Purpose |
|------|---------|
| `wrangler-template.jsonc` | Canonical wrangler config that every site inherits. Compatibility flags, worker-entry path, observability — everything that is the same for every site. |
| `sites/<repo-name>.jsonc` | Per-site overrides. Only the keys that genuinely vary per-site live here (`worker_name` always; `routes`, `kv_namespaces`, `analytics_engine_datasets`, `version_metadata` when used). |

The repository name (the part of `${{ github.repository }}` after the `/`) is
the lookup key. `als-tanstack` deploys via `sites/als-tanstack.jsonc`. There is
no other way to identify a site.

## Trust model

- Customer caller workflows pass **no inputs** to the central reusable workflow.
- The central workflow derives the site name from `${{ github.repository }}`
  (set by GitHub, untamperable by user code) and looks up
  `sites/<repo-name>.jsonc` from this registry.
- A customer cannot misroute a deploy onto another customer's worker because
  they can't write to `decocms/deco-start`.

`deploy/**` is CODEOWNERS-protected. Only the platform team can change site
manifests or the template.

## How wrangler.jsonc is generated

At deploy time, the central workflow runs
[`scripts/deploy/build-wrangler-config.mjs`](../scripts/deploy/build-wrangler-config.mjs),
which:

1. Loads `deploy/wrangler-template.jsonc` (canonical defaults).
2. Loads `deploy/sites/<site>.jsonc` (per-site overrides).
3. Deep-merges: site overrides win. `worker_name` becomes wrangler's `name`.
   Arrays are replaced, not concatenated.
4. Writes the result to `./wrangler.jsonc` in the caller checkout.

`account_id` is never written to JSON — wrangler reads it from
`CLOUDFLARE_ACCOUNT_ID` (env var in CI; `wrangler login` locally).

## Adding a new site

1. Open a PR to this repo adding `deploy/sites/<new-repo>.jsonc`:
   ```jsonc
   {
     "worker_name": "<new-repo>"   // can differ from repo name if needed
   }
   ```
2. After merge, the next `v2.x.y` semantic-release publish auto-moves the
   `@v2` major tag (the major-tag advance step lives inline in
   [`.github/workflows/release.yml`](../.github/workflows/release.yml)).
3. In the new repo, add the four caller workflows from
   [`.github/workflows/`](../.github/workflows/) and set the org-level
   `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` GitHub secrets.
4. Push to `main` and verify the deploy lands on the right worker.

## Per-site override schema

```jsonc
{
  "worker_name": "string (required, immutable)",
  "routes": [                          // optional
    { "pattern": "www.example.com/*", "zone_name": "decocdn.com" }
  ],
  "kv_namespaces": [                   // optional
    { "binding": "SITES_KV", "id": "<cf-kv-id>" }
  ],
  "analytics_engine_datasets": [       // optional
    { "binding": "DECO_METRICS", "dataset": "deco_metrics_<site>" }
  ],
  "version_metadata": {                // optional
    "binding": "CF_VERSION_METADATA"
  }
}
```

All other wrangler keys (compatibility flags, `main`, observability, etc.) come
from the template — do not duplicate them per-site. If a per-site override is
genuinely needed for one of those keys, add it to the schema and document the
reason here.
