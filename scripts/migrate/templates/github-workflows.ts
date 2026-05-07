// Caller workflow stubs for new sites. Each stub delegates to a reusable
// workflow under `decocms/deco-start/.github/workflows/` -- the customer repo
// holds no deploy/build logic of its own. See D6 in
// `.cursor/rules/migration-tooling-policy.mdc` and the `deploy/` directory
// for the central registry contract.

const DEPLOY_YML = `name: Deploy

# Thin caller for decocms/deco-start's central deploy workflow.

on:
  push:
    branches: [main]

permissions:
  contents: write

jobs:
  deploy:
    uses: decocms/deco-start/.github/workflows/deploy.yml@v2
    secrets: inherit
`;

const PREVIEW_YML = `name: Preview

# Thin caller for decocms/deco-start's central preview workflow.

on:
  repository_dispatch:
    types: [preview-deploy]
  pull_request:
    types: [opened, synchronize, reopened]
  push:
    branches: ['env/**']

permissions:
  contents: read
  pull-requests: write
  statuses: write

jobs:
  preview:
    uses: decocms/deco-start/.github/workflows/preview.yml@v2
    secrets: inherit
`;

const REGEN_BLOCKS_YML = `name: Regenerate blocks.gen.json

# Thin caller for decocms/deco-start's central regen-blocks workflow.

on:
  push:
    branches: [main]
    paths:
      - ".deco/blocks/**"

permissions:
  contents: write

jobs:
  regen:
    uses: decocms/deco-start/.github/workflows/regen-blocks.yml@v2
    secrets: inherit
`;

const SYNC_SECRETS_YML = `name: Sync worker secrets

# Thin caller for decocms/deco-start's central sync-secrets workflow.

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
  sync:
    uses: decocms/deco-start/.github/workflows/sync-secrets.yml@v2
    with:
      mode: \${{ inputs.mode }}
    secrets: inherit
`;

export function generateGithubWorkflows(): Record<string, string> {
  return {
    ".github/workflows/deploy.yml": DEPLOY_YML,
    ".github/workflows/preview.yml": PREVIEW_YML,
    ".github/workflows/regen-blocks.yml": REGEN_BLOCKS_YML,
    ".github/workflows/sync-secrets.yml": SYNC_SECRETS_YML,
  };
}
