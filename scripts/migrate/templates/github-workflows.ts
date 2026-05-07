// Caller workflow stubs for new sites (v3, D6.2 architecture). Each stub mints
// a short-lived `decocms-deployer` GitHub App installation token and uses it
// to call the corresponding reusable workflow under
// `decocms/deco-start/.github/workflows/`. The customer repo holds no deploy
// logic of its own AND no Cloudflare credentials -- only the App ID + private
// key as deco-sites org-level secrets (`DECOCMS_DEPLOYER_APP_ID` and
// `DECOCMS_DEPLOYER_APP_PRIVATE_KEY`).
//
// See `deploy/README.md` and the migration-tooling-policy rule (D6.2) for the
// full trust model.

const DEPLOY_YML = `name: Deploy

# Triggers decocms/deco-start's central deploy workflow via App-token.

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: \${{ secrets.DECOCMS_DEPLOYER_APP_ID }}
          private-key: \${{ secrets.DECOCMS_DEPLOYER_APP_PRIVATE_KEY }}
          owner: decocms
          repositories: deco-start
      - env:
          GH_TOKEN: \${{ steps.app-token.outputs.token }}
        run: |
          gh workflow run deploy.yml \\
            --repo decocms/deco-start \\
            --ref v3 \\
            -f site_owner=\${GITHUB_REPOSITORY%%/*} \\
            -f site_name=\${GITHUB_REPOSITORY##*/}
`;

const PREVIEW_YML = `name: Preview

# Triggers decocms/deco-start's central preview workflow via App-token.

on:
  pull_request:
    types: [opened, synchronize, reopened]
  push:
    branches: ['env/**']

permissions:
  contents: read

jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - id: meta
        run: |
          if [ "\${{ github.event_name }}" = "pull_request" ]; then
            echo "alias=pr-\${{ github.event.pull_request.number }}" >> "$GITHUB_OUTPUT"
            echo "sha=\${{ github.event.pull_request.head.sha }}" >> "$GITHUB_OUTPUT"
          else
            REF="\${GITHUB_REF#refs/heads/env/}"
            echo "alias=$(echo "$REF" | sed 's|[^a-z0-9-]|-|g')" >> "$GITHUB_OUTPUT"
            echo "sha=\${{ github.sha }}" >> "$GITHUB_OUTPUT"
          fi
      - uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: \${{ secrets.DECOCMS_DEPLOYER_APP_ID }}
          private-key: \${{ secrets.DECOCMS_DEPLOYER_APP_PRIVATE_KEY }}
          owner: decocms
          repositories: deco-start
      - env:
          GH_TOKEN: \${{ steps.app-token.outputs.token }}
        run: |
          gh workflow run preview.yml \\
            --repo decocms/deco-start \\
            --ref v3 \\
            -f site_owner=\${GITHUB_REPOSITORY%%/*} \\
            -f site_name=\${GITHUB_REPOSITORY##*/} \\
            -f site_sha=\${{ steps.meta.outputs.sha }} \\
            -f alias=\${{ steps.meta.outputs.alias }} \\
            -f pr_number=\${{ github.event.pull_request.number || '' }}
`;

const REGEN_BLOCKS_YML = `name: Regenerate blocks.gen.json

# Thin caller for decocms/deco-start's central regen-blocks workflow.
# This one stays as workflow_call: it runs in the caller's runner context
# (writes back to the storefront repo) and needs no Cloudflare credentials.

on:
  push:
    branches: [main]
    paths:
      - ".deco/blocks/**"

permissions:
  contents: write

jobs:
  regen:
    uses: decocms/deco-start/.github/workflows/regen-blocks.yml@v3
    secrets: inherit
`;

const SYNC_SECRETS_YML = `name: Sync worker secrets

# Triggers decocms/deco-start's central sync-secrets workflow via App-token.
# The actual SECRET_* values live in deco-start's '\${repo-basename}-secrets'
# environment, NOT in this repo. See deco-start's deploy/README.md.

on:
  workflow_dispatch:
    inputs:
      mode:
        description: "dry-run = print diff only | apply = set secrets on worker"
        required: true
        default: "dry-run"
        type: choice
        options: [dry-run, apply]

permissions:
  contents: read

jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: \${{ secrets.DECOCMS_DEPLOYER_APP_ID }}
          private-key: \${{ secrets.DECOCMS_DEPLOYER_APP_PRIVATE_KEY }}
          owner: decocms
          repositories: deco-start
      - env:
          GH_TOKEN: \${{ steps.app-token.outputs.token }}
        run: |
          gh workflow run sync-secrets.yml \\
            --repo decocms/deco-start \\
            --ref v3 \\
            -f site_name=\${GITHUB_REPOSITORY##*/} \\
            -f mode=\${{ inputs.mode }}
`;

export function generateGithubWorkflows(): Record<string, string> {
  return {
    ".github/workflows/deploy.yml": DEPLOY_YML,
    ".github/workflows/preview.yml": PREVIEW_YML,
    ".github/workflows/regen-blocks.yml": REGEN_BLOCKS_YML,
    ".github/workflows/sync-secrets.yml": SYNC_SECRETS_YML,
  };
}
