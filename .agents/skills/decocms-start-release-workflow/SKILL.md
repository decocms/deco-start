---
name: decocms-start-release-workflow
description: Choose the correct base branch (main vs next) when opening a PR against @decocms/start, and operate the stable / prerelease release pipeline. Use BEFORE running `gh pr create` or pushing a branch, and when promoting a prerelease, publishing a hotfix, or explaining release channels to a user. Covers the PR base selection decision tree, semantic-release branching model, npm dist-tags (latest, next), customer-facing install commands, and gotchas (the canonical CI-skip token; prerelease tag filtering).
globs:
  - ".releaserc.json"
  - ".github/workflows/release.yml"
  - "package.json"
---

# @decocms/start Release Workflow

This package ships through **two long-lived branches** that map to **two npm dist-tags**.

| Branch | npm dist-tag | Version shape | Who gets it |
|--------|--------------|---------------|-------------|
| `main` | `latest` | `5.2.0` | Everyone with `"@decocms/start": "^X.Y.Z"` (the default install). |
| `next` | `next` | `5.2.0-next.3` | Only customers who explicitly opt in via `bun add @decocms/start@next` or pin a prerelease version exactly. |

**Why this matters:** npm's caret ranges (`^5.1.1`) *never* resolve to prerelease versions, and `bun install` with no qualifier follows the `latest` dist-tag. Together, these two rules give us complete isolation between channels with zero work on the customer side — the customer's `package.json` doesn't need to change.

## TL;DR — picking `--base` for a PR

Run this decision tree **before** `gh pr create` (or before pushing a feature branch):

1. **Bug fix the whole customer base needs ASAP** → `--base main`.
2. **New feature, behavior change, or anything that benefits from validation by 1–2 customers first** → `--base next`.
3. **Breaking change** → `--base next`. Validate, then promote.
4. **Doc-only / internal refactor with no shipped surface change** → `--base main`. semantic-release will no-op (commit-analyzer ignores `docs:`, `chore:`, `style:`, `test:` — see `.releaserc.json:12-15`).
5. **Hotfix for customers stuck on an older major** → **stop**. This skill does not cover maintenance branches yet; ask the user how they want to handle it.

If you're not sure between (1) and (2), ask the user. Default to `next` if there's any chance you've broken something — promotion is cheap, regression on `latest` is not.

## Branch lifecycle

```
  main  ──●──────●─────────●────●──────●─── (publishes to @latest)
           \              ↗      \    ↗
            \   merge    /        \  / merge
             ●──●──●──●─●          ●●●
                                          (next, publishes to @next)
```

- `main` is canonical. `next` periodically merges into `main` to promote a prerelease to stable.
- Never merge `main` → `next` except as a sync (e.g. after a hotfix landed on `main`, fast-forward `next` so it doesn't carry a stale base).
- Both branches are protected. Push is via PRs only.

## PR mechanics

```bash
# Stable patch — most PRs go here:
gh pr create --base main --title "fix: handle empty filter ranges"

# Prerelease — validation candidates:
gh pr create --base next --title "feat: add cache purge for /search"
```

**Conventional commit prefixes drive the version bump on both branches** (`.releaserc.json:6-16`):

| Prefix | Bump on `main` | Bump on `next` |
|--------|---------------|----------------|
| `fix:`, `perf:`, `refactor:` | patch (`5.1.1 → 5.1.2`) | prerelease (`5.2.0-next.1 → 5.2.0-next.2`) |
| `feat:` | minor (`5.1.1 → 5.2.0`) | prerelease (`… → 5.2.0-next.N`) |
| Breaking (`BREAKING CHANGE:` footer, or `feat!:`) | major (`5.1.1 → 6.0.0`) | prerelease major (`6.0.0-next.N`) |
| `docs:`, `chore:`, `style:`, `test:` | no release | no release |

**Squash-merge is the convention.** The single squashed commit message is what semantic-release analyzes, so write a good conventional-commit title on the PR.

## Promoting a prerelease (`next` → `latest`)

When the validation customer signs off:

```bash
gh pr create --base main --head next --title "release: promote next to stable"
```

After merge:

1. semantic-release on `main` reads the same commits and publishes the stable equivalent (e.g. the running `5.2.0-next.7` becomes `5.2.0` on `@latest`).
2. The `@next` dist-tag is moved by semantic-release to point at the new stable too (channel-merging behavior — this is intentional, it prevents anyone on `@next` from falling behind `@latest`).
3. The `Advance moveable major tag` step (`release.yml:68-82`) updates `vN` to the new stable tag. Prerelease tags are excluded by the `grep -v -- '-'` filter.

## Starting a fresh prerelease cycle

If `next` is stale (already promoted, or you want to start clean):

```bash
git fetch origin
git checkout -B next origin/main
git push origin next --force-with-lease
```

Then open feature/fix PRs `--base next` as normal.

## Verifying after any release

```bash
npm view @decocms/start dist-tags
# Expected after a stable release:  { latest: '5.2.0',         next: '5.2.0' }
# Expected after a prerelease:      { latest: '5.1.1',         next: '5.2.0-next.3' }

npm view @decocms/start@next version          # current prerelease
npm view @decocms/start@latest version        # current stable
npm view @decocms/start versions --json | tail -20   # recent published versions
```

Customer-side opt-in commands (use these when telling a customer how to test):

```bash
# Channel follower (re-resolves on every install):
bun add @decocms/start@next

# Pinned to an exact prerelease:
bun add @decocms/start@5.2.0-next.3

# Back to stable:
bun add @decocms/start@latest
```

## Don't-do list

- ❌ **Never push directly to `main` or `next`.** Both are protected; releases must go through PRs so commit-analyzer sees clean conventional messages.
- ❌ **Never run `npm publish` from a laptop.** Only the GitHub Actions workflow has the npm token, and it runs `semantic-release` so the version, tag, GitHub Release, and dist-tag stay in sync. A manual publish will desync them.
- ❌ **Never modify dist-tags manually** (`npm dist-tag add`, `npm dist-tag rm`) on a live release without coordinating — semantic-release manages these.
- ❌ **Never include the canonical CI-skip token** (the bracketed phrase "skip" + "ci", written as one word, like the semantic-release release commit uses) in a PR title or body that targets `main` or `next`. GitHub Actions silently skips the workflow if the head commit message contains that token anywhere — title, body, code blocks, all of it. See the gotcha block at `release.yml:3-21`. Refer to it descriptively if you need to mention it in a PR.
- ❌ **Never merge `main` into `next` casually.** Only do it as an explicit "sync `next` to current stable" operation, and prefer rebasing/resetting `next` to `main` when starting a fresh prerelease cycle.

## Cross-references

- `/.releaserc.json` — semantic-release config (branches, plugins, publishCmd).
- `/.github/workflows/release.yml` — CI workflow + gotcha documentation for the skip token.
- `/CLAUDE.md#release-pipeline` — short summary kept in initial agent context.
- `/.cursor/rules/release-workflow.mdc` — always-loaded Cursor pointer to this skill.
- [semantic-release pre-releases recipe](https://semantic-release.gitbook.io/semantic-release/recipes/release-workflow/pre-releases) — upstream docs for this exact pattern.
