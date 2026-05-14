# Contributing to `@decocms/start`

## Project overview

This is the framework layer for Deco storefronts built on **TanStack Start +
React 19 + Cloudflare Workers** (and, increasingly, **Next.js 16 + App
Router**). Not a storefront itself — the npm package that storefronts depend
on. See `CLAUDE.md` for the architectural ground rules (tier boundaries, three
adapters, release channels).

## Common commands

```bash
bun install
bun run typecheck
bun run test
bun run build
```

There is no `dev` server — this is a library. Consumers run their own dev
server (Vite for TanStack, `next dev` for Next).

## Testing against a real consumer

When you want to verify a change end-to-end against a storefront, the
recommended path depends on the consumer's bundler.

### Vite / Webpack consumers — `bun link` works

```bash
# In this repo
bun run build
bun link

# In the consumer
bun link @decocms/start
```

Subpath exports (`@decocms/start/core`, `@decocms/start/next`, …) resolve
correctly through the symlink. Rebuild here (`bun run build`) whenever you
change source; the link itself doesn't watch.

### Next.js / Turbopack consumers — copy `dist/` instead of linking

**Turbopack does not resolve subpath exports through symlinks.** Even with
`transpilePackages` set, `bun link @decocms/start` against a Next 16 +
Turbopack project produces "Module not found" for every `@decocms/start/*`
subpath. Confirmed against Next `16.2.6` / Turbopack as of May 2026; the
upstream issue is long-standing.

The reliable workaround is to install the published version once and overlay
this repo's `dist/` directly:

```bash
# In the consumer
bun install                                          # one time
rm -rf node_modules/@decocms/start/dist
cp -R /path/to/deco-start/dist node_modules/@decocms/start/dist
```

After every source change in this repo, run `bun run build` here and repeat
the `rm/cp` in the consumer. The helper script bundles both steps:

```bash
# In this repo
./scripts/dev-link-into.sh /path/to/consumer
```

It runs `bun run build` and overwrites `node_modules/@decocms/start/dist` in
the target. Re-runnable; safe to wire into a `concurrently` invocation
alongside `next dev` (debounced — only triggers when you re-run it).

## Tier boundaries

Three tiers, each enforced by `scripts/check-tier-boundaries.ts` after every
build:

| Tier | May import | May not import |
|------|-----------|----------------|
| `src/core/` | itself, `node:` standards | `@tanstack/*`, `next`, `node:async_hooks`, Node-only modules |
| `src/tanstack/` | `core/`, `node/`, `@tanstack/*`, `node:*` | `next` |
| `src/next/` | `core/`, `node/`, `next` | `tanstack/`, `@tanstack/*` |

`src/node/` is the framework-neutral Node-only tier — fair game for both
adapters. The daemon's Web-standard handlers live there (`src/node/daemon/`).

If you reach for `@tanstack/react-start/server` inside `core/`, stop — accept
the value as a function argument or use the `RequestStore` interface in
`src/core/runtime/`.

## Release channels

Two channels, governed by `.releaserc.json`. The release-workflow skill at
`.agents/skills/decocms-start-release-workflow/SKILL.md` has the decision tree.

- `main` → `@decocms/start@latest` (e.g. `5.2.0`). Default for consumers.
  Routine fixes go here.
- `next` → `@decocms/start@next` (e.g. `5.2.0-next.3`). Opt-in via
  `bun add @decocms/start@next`. Use for behaviour-changing or risky work
  that benefits from customer validation. Promote by opening a PR `next` →
  `main`.

Hard rules:

- Never push directly to `main` or `next`.
- Never run `npm publish` locally — the workflow does it.
- Never include the canonical GitHub-Actions CI-skip token in a PR title or
  body targeting either branch. See `.github/workflows/release.yml:3-21`.

## Spec / plan / brainstorm workflow

Larger features go through `superpowers:brainstorming` → spec
(`docs/superpowers/specs/`) → plan (`docs/superpowers/plans/`) → execution.
See the existing entries for shape. Two recent examples:

- `docs/superpowers/specs/2026-05-13-next-adapter-admin-coverage-design.md`
- `docs/superpowers/plans/2026-05-13-next-adapter-admin-coverage.md`

For small fixes, conventional-commit messages are enough — semantic-release
picks up `feat:` / `fix:` / `refactor:` automatically.
