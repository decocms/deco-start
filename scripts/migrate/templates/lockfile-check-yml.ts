/**
 * Generates `.github/workflows/lockfile-check.yml`, the PR-time
 * guardrail that fails any pull request which would have failed
 * Cloudflare Workers Builds with `lockfile had changes, but lockfile
 * is frozen`. This catches drift before it reaches main, instead of
 * only after deploy attempts.
 *
 * Lives in the site repo (per-site, not centralised) because per
 * D6.3 we are NOT scaffolding caller stubs that pull in
 * `decocms/deco-start@vN` reusable workflows. The check is small
 * enough that copy-paste-per-site is the right tradeoff.
 *
 * Bun version pinning matches the `packageManager` field in the
 * scaffolded `package.json` (see `templates/package-json.ts`'s
 * `CANONICAL_BUN_VERSION`). Kept in lockstep manually for now;
 * future iterations may consolidate both into a shared constant.
 */
export function generateLockfileCheckYml(bunVersion: string): string {
  const v = stripBunPrefix(bunVersion);
  return `name: lockfile-check

# PR-time guardrail: re-runs the same install Cloudflare Workers Builds
# runs on deploy (\`bun install --frozen-lockfile\`). Fails the PR if
# bun.lock would have rejected the install — closes the loop so drift
# can never reach main, only to be caught by Workers Builds at deploy
# time.
#
# Pairs with:
#   - "packageManager": "bun@${v}" in package.json
#   - .gitignore bans on package-lock.json / yarn.lock / pnpm-lock.yaml
#   - the deco-post-cleanup audit's lockfile-* rules
#
# Adjust \`bun-version\` here in lockstep with the package.json
# \`packageManager\` field.

on:
  pull_request:
    paths:
      - "package.json"
      - "bun.lock"
      - ".github/workflows/lockfile-check.yml"

permissions:
  contents: read

jobs:
  frozen-install:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${v}
      - name: bun install --frozen-lockfile
        run: bun install --frozen-lockfile
`;
}

/**
 * Strip an accidental `bun@` prefix from the version string so the
 * YAML's `bun-version` input (which expects a bare semver) doesn't
 * receive `bun@1.3.5`.
 */
function stripBunPrefix(input: string): string {
  return input.replace(/^bun@/, "");
}
