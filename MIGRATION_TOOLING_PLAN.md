# Migration Tooling Improvement Plan

> **Status**: 🟢 In progress  
> **Started**: 2026-04-30  
> **Owner**: Fernando Frizzatti + Cursor agent

This document is the single source of truth for the migration-tooling
improvement effort across `@decocms/start`, `@decocms/apps-start`, and the
migration scripts/skills. It is **append-only** — each step records what
shipped, what didn't, and what we discovered.

---

## North-star

A new Deco storefront migration from Fresh/Deno → TanStack Start should be:

1. **One command + a short manual checklist**, with a clean PR-ready output.
2. **Built on factories and presets** in `@decocms/start` and `@decocms/apps`
   instead of duplicated site-level glue.
3. **Backed by skills** (playbook + references) that distinguish what the
   script automates from what's still on the engineer.

casaevideo-storefront is the **production reference**. We do not change
casaevideo's repo. Patterns it proved are promoted upward into the packages
so the next site doesn't reinvent them.

---

## Constraints

- 🚫 **No direct pushes to `main`**. Every change goes through a PR.
- 🚫 **No deploys** triggered from this work.
- ✅ All work on feature branches per repo (`feat/...`, `fix/...`).
- ✅ Conventional Commits in English for `deco-start` / `apps-start`,
  PT-BR for site repos (per their respective `.cursorrules`).

---

## Repos in scope

| Repo | Role | Branch policy |
|------|------|--------------|
| `decocms/deco-start` | Framework package + migration scripts + skills | Feature branches only, PR review |
| `decocms/apps-start` | VTEX/commerce loaders, hooks, utils | Feature branches only, PR review |
| `decocms/casaevideo-storefront` | Production reference — **read only** for this effort | Untouched |
| `decocms/baggagio-tanstack` | Ongoing migration — used as smoke-test target | Branch only if needed for verification |

---

## Investigation findings (locked, 2026-04-30)

Compiled from a deep-dive across all three sites + the deco-start scripts +
the existing skill files. Full evidence in the chat transcript that produced
this plan.

### A. Site-level code that should be in packages

| # | Item | Sites affected | Proper home | Risk |
|---|------|---------------|-------------|------|
| A1 | `src/lib/{vtex-client,vtex-fetch,vtex-id,vtex-segment,vtex-intelligent-search,graphql-utils,http-utils,filter-navigate,fetch-utils}.ts` — byte-identical migration shims | casaevideo + baggagio | `@decocms/apps/vtex/utils/*` (already exists) | Low — pure stubs |
| A2 | `src/runtime.ts` — invoke proxy, byte-identical 46 lines | casaevideo + baggagio | `@decocms/start/sdk/runtime` | Trivial |
| A3 | `src/cms/{cmsRouteWithGlobals,site-globals,useSiteGlobals}.ts` — workaround for upstream gaps | baggagio | `@decocms/start/routes/withSiteGlobals` (opt-in) + bugfix in `buildPageSeo` | Medium — see B1/B2 |
| A4 | `withIsSimilarTo` PDP enrichment, `cachedAutocomplete`, VTEX auth Set-Cookie domain stripping | casaevideo (manual wiring) | `createCachedPDPLoader({ similars: true })`, canonical autocomplete in `createVtexCommerceLoaders()`, `vtexAuthFromRequest` wrapper in apps | Low — apps already exports building blocks |
| A5 | `useCart.ts` near-identical (~98%) | both | `createUseCart(invoke)` factory in `@decocms/apps/vtex/hooks` | Medium |
| A6 | `vite.config.ts` boilerplate (manualChunks, dedupe scope, meta.gen stub plugin) | both | absorb into `decoVitePlugin()` / `@decocms/start/vite` preset | Low |
| A7 | `src/sdk/signal.ts` site-level re-export | both | already in `@decocms/start/sdk/signal` — just delete | Trivial |
| A8 | `vite:preloadError` reload handler in `router.tsx` | casaevideo | `@decocms/start/sdk/router` helper export | Low |

### B. Framework gaps (live on as workarounds in baggagio)

| # | Gap | Location | Fix strategy |
|---|-----|----------|--------------|
| B1 | `buildPageSeo` returns early when page has no `seo` section → `siteSeo.titleTemplate` never applied | `@decocms/start` | **Bugfix** — apply template even when page has no seo. No flag. |
| B2 | `@decocms/start@2.0.x` only consumes `site.seo`; drops `site.theme`/`site.global`/`site.pageSections` | `@decocms/start` | **Opt-in helper** first (`withSiteGlobals`), promote to default once verified safe vs casaevideo CMS shape |

### C. Migration script gaps

| # | Gap | Severity | Fix |
|---|-----|----------|-----|
| C1 | `phase-analyze` skips `src/` — modern Fresh layouts under `src/` produce empty migrations silently | High | Detect modern layout and either scan or abort with helpful message |
| C2 | Bootstrap is a strict subset of `npm run build`; site doesn't compile until full codegen runs | High | Run full codegen chain or surface this in report |
| C3 | `--skip-bootstrap` flag is dead code (env set but never read) | Low | Wire end-to-end |
| C4 | `transforms/section-conventions.ts` hard-codes Casa&Video section basenames | Medium | Drive from per-site config + `.deco/blocks/` heuristics |
| C5 | Platform hooks template is TODO stubs (Phase 5 = "0% automation") | High | Once `createUseCart(invoke)` factory exists in apps, template emits one-line wiring |
| C6 | `lib-utils.ts` template generates the duplicates from A1 — self-perpetuating | High | Delete after A1 lands; rewrite `transforms/imports.ts` to point at apps |
| C7 | `phase-verify` is filesystem + grep, never compiles | Medium | Run `tsc --noEmit` + `vite build` as gates |
| C8 | No state persisted between phases → no resumability | Medium | `.deco-migrate.state.json` |
| C9 | `analyze-traces.mjs` co-located but unrelated | Low | Move out of `scripts/migrate/` |

### D. Skill issues

| # | Issue | Fix |
|---|-------|-----|
| D1 | Two parallel skill trees (`.agents/` and `.cursor/`) of `deco-to-tanstack-migration`, drifting | `.agents/` becomes canonical. Reorganize into `migrations/`, `tanstack-usage/`, `deco-framework/`, `operations/` |
| D2 | `deco-migrate-script/SKILL.md` partially stale vs current code (`MigrationContext` shape, useOffer claims, pattern inventory) | Reconcile with code |
| D3 | `run-migration` skill has hardcoded absolute paths | Parameterize |
| D4 | Playbook describes manual steps the script automates, blurring "use the script vs read this" | Restructure phases as "what the script does + what's still on you" |

---

## Decisions made

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-30 | casaevideo stays untouched | It's the production reference — patterns flow up into packages, not the other way |
| 2026-04-30 | Order of work: layers → script → skills | Each unlocks the next |
| 2026-04-30 | B2 lands as opt-in helper first (A2 strategy), promote to default later | Need to verify casaevideo CMS shape compatibility before changing default behavior |
| 2026-04-30 | B1 (buildPageSeo bugfix) lands unconditionally | Pure bugfix, no behavior change for pages with seo section |
| 2026-04-30 | Site-config strategy: per-site `deco-migrate.config.ts` + derive from `.deco/blocks/` | Reduces hardcoding without forcing engineers to fill long config |
| 2026-04-30 | Skills home: `.agents/` canonical | Maps cleanly to script-based workflow |
| 2026-04-30 | Cross-cutting work: split properly between `@decocms/start`, `@decocms/apps-start`, scripts/skills in deco-start | Keeps package boundaries clean |
| 2026-04-30 | All work via PRs, no direct merges | User explicitly required |
| 2026-05-01 | **Policy reset: design for 100 sites, not 3** | "Wait for the 3rd site" was the wrong heuristic — it created drift risk and held back ready abstractions. New bar: *will this design generalize correctly to N sites?* When the surface is understood (factory, audit-rule), ship. When it isn't (htmx, forks), decide explicitly via D-records, don't ship fast. |
| 2026-05-01 | **D1 — Apps forks: force convergence (Option B)** | All sites consume `@decocms/apps`. Site-specific customizations live in `src/apps/local/`. No fork-runtime support layer. Sites that need framework-level changes either PR canonical or fork independently and own consequences. |
| 2026-05-01 | **D2 — HTMX: rewrite on migration (Option A)** | HTMX patterns are fully rewritten to React idioms during migration. **No HTMX runtime in `@decocms/start`.** Codemods cover common patterns; skill recipes cover the long tail. |
| 2026-05-01 | **D3 — Stub generation: throw at runtime (Option C)** | Migration-time stubs throw with a clear pointer to the canonical replacement instead of silently identity-casting. Forces audit `--fix` to cover swap cases (no permanent detect-only state) and skills to keep up with stub generation. |
| 2026-05-01 | **D4 — Site-local apps: local by default, promote at 3** | Site-specific apps live in `src/apps/local/` until ≥3 sites use them, then promote to `@decocms/apps`. |
| 2026-05-01 | **D5 — Failed migrations: rm -rf and re-run** | No `--restart` mode. Half-migrated sites are throwaways. Failure modes get documented in skills, not encoded as escape hatches. |

The full text of the constitutional rule (loaded into every agent
session for this repo) lives at
[`.cursor/rules/migration-tooling-policy.mdc`](./.cursor/rules/migration-tooling-policy.mdc).

## Decisions pending

| Topic | Blocked on |
|-------|-----------|
| ~~Whether B2 promotes from opt-in to default~~ | Resolved 2026-04-30: stays opt-in indefinitely |
| ~~Order of "kill `src/lib/*` stubs" vs "factory hooks" within Phase 1 second wave~~ | Resolved via Wave 6/7/8 — both shipped, audit covers regressions |
| ~~Whether to invest in resumability (C8)~~ | Resolved via D5: no resumability, rm -rf + re-run instead |
| ~~Whether to convert deco-start + apps-start into a monorepo~~ | Defer indefinitely — current split is working, monorepo would force coordinated releases |
| ~~Wait-for-3rd-site deferrals (createUseUser, createUseWishlist, --fix for swap cases, etc.)~~ | Resolved via 2026-05-01 policy reset — these now ship in Wave 12 |

## Priority order (current)

Ordered by dependency and value, per the 2026-05-01 directive. Higher
priorities don't block on lower ones, but lower ones don't ship before
the higher ones are at least scoped.

| # | Goal | Repo(s) | Status |
|---|------|---------|--------|
| **1** | Framework + commerce changes — fix the foundation first. New factories, audit rules, primitives. | `@decocms/start`, `@decocms/apps` | **Active** (Wave 12) |
| **2** | Migration scripts + skills to make migration to the new latest possible. Codemods, audit `--fix`, skill recipes. | `@decocms/start` (scripts/skills) | Pending Wave 12 |
| **3** | Migrate als using new tooling. First htmx-heavy site validation end-to-end. | `als-tanstack` (fresh repo, new) | Pending priority 1+2 |
| **4** | Update existing TanStack sites (casaevideo, baggagio, future) to latest packages, run audit `--fix`, clean up. | site repos (PRs) | Pending priority 3 |

Out-of-band work (incident response, urgent prod fixes) bypasses this
order — but only if explicitly identified as urgent.

---

## Phases

Each item carries a status: ⬜ pending, 🟡 in progress, ✅ done, 🚫 blocked, ❌ dropped.

### Phase 1 — Layer fixes (push site-level patterns into packages)

#### Wave 1 — low-risk, no site changes

| # | Item | Status | PR | Notes |
|---|------|--------|----|-------|
| 1.1 | Move `runtime.ts` invoke proxy → `@decocms/start/sdk/invoke` | 🟡 | [#103](https://github.com/decocms/deco-start/pull/103) | **Discovery: `createAppInvoke` already existed**, only the singleton + barrel export were missing. PR adds `export const invoke = createAppInvoke()` + 9 tests. After release: bagaggio deletes its 46-LOC `src/runtime.ts` shim entirely. |
| 1.2 | Delete site-level `sdk/signal.ts` re-export plan; document import-path migration | ⬜ | — | Trivial |
| 1.3 | Export `vite:preloadError` handler from `@decocms/start/sdk/router` | ⬜ | — | One helper |
| 1.4 | **Fix `buildPageSeo`** — apply `siteSeo.titleTemplate` even when page has no seo section | ✅ | [#98](https://github.com/decocms/deco-start/pull/98) | **MERGED 2026-05-01** (commit `787c6e8`). Awaits next `@decocms/start` release for baggagio to consume. |
| 1.5 | Add `withSiteGlobals` opt-in helper to `@decocms/start/routes` | ✅ | [#102](https://github.com/decocms/deco-start/pull/102) | **MERGED 2026-05-01 (`03fec63`), shipped in `@decocms/start@2.3.0`.** Auto-merges `site.theme + site.global + site.pageSections` into resolvedSections, exposes raw refs as `loaderData.siteGlobals.rawRefs`. 14 unit tests. Stays opt-in (A2). Bagaggio can now upgrade and drop 3 site-level files (~120 LOC). |
| 1.6 | **Audit casaevideo `.deco/blocks/Site.json`** to gate B2 default-on promotion | ✅ | — | Done — `site.global` populated but rendered manually via `__root.tsx`; B2 must stay opt-in indefinitely |

#### Wave 2 — depends on Wave 1 + script changes

| # | Item | Status | PR | Notes |
|---|------|--------|----|-------|
| 1.7 | Kill `src/lib/{vtex-*,fetch-utils,http-utils,graphql-utils,filter-navigate}.ts` stubs in apps + transform rewrites | ⬜ | — | Sequenced with C6 fix |
| 1.8 | `createUseCart(invoke)` factory in `@decocms/apps/vtex/hooks` | ⬜ | — | |
| 1.9 | `createCachedPDPLoader({ similars: true })` flag in `@decocms/apps/vtex/commerceLoaders` | ⬜ | — | |
| 1.10 | Canonical `cachedAutocomplete` in `createVtexCommerceLoaders()` | ⬜ | — | |
| 1.11 | `vtexAuthFromRequest` wrapper in apps | ⬜ | — | |
| 1.12 | `decoVitePlugin` absorbs `manualChunks`, `dedupe`, `meta.gen` stub | ⬜ | — | |
| 1.13 | ~~Promote `withSiteGlobals` from opt-in to default~~ | ❌ | — | Dropped: casaevideo audit showed `site.global` is rendered manually via `__root.tsx`; auto-merge would cause duplicate rendering. Stays opt-in indefinitely. |

### Phase 2 — Script improvements

#### Wave 1 — bug fixes & small ergonomics

| # | Item | Status | PR | Notes |
|---|------|--------|----|-------|
| 2.1 | `phase-analyze` detects `src/`-rooted Fresh sites (scan or abort with message) | ⬜ | — | |
| 2.2 | Bootstrap runs full codegen chain (or report it loudly) | ⬜ | — | |
| 2.3 | Wire `--skip-bootstrap` end-to-end | ⬜ | — | Trivial |
| 2.4 | `phase-verify` runs `tsc --noEmit` + `vite build` | ⬜ | — | |
| 2.5 | Move `analyze-traces.mjs` out of `scripts/migrate/` | ⬜ | — | Trivial |

#### Wave 2 — depends on Phase 1 Wave 2

| # | Item | Status | PR | Notes |
|---|------|--------|----|-------|
| 2.6 | Update `lib-utils.ts` template + `transforms/imports.ts` to target `@decocms/apps/vtex/utils/*` directly | 🟡 | [#93](https://github.com/decocms/deco-start/pull/93) merged | **Tier B VTEX rewrites done** (PR #93). Remaining: `lib-utils.ts` template removal — sequenced after 1.7 |
| 2.7 | `deco-migrate.config.ts` per-site + derive eager/origins from `.deco/blocks/` | ⬜ | — | |
| 2.8 | Persisted state (`.deco-migrate.state.json`) for resumability | ⬜ | — | Defer until needed |
| 2.9 | Parametric "golden parity" check (reference becomes a CLI arg) | ⬜ | — | |
| 2.10 | Composable subcommands (`fix-imports`, `verify-only`, etc.) | ⬜ | — | |

### Phase 3 — Skills reorganization

| # | Item | Status | PR | Notes |
|---|------|--------|----|-------|
| 3.1 | Pick `.agents/skills/` as canonical, deprecate `.cursor/skills/` (or generate-mirror) | ⬜ | — | |
| 3.2 | Reconcile two `deco-to-tanstack-migration/SKILL.md` files into one | ⬜ | — | |
| 3.3 | Update `deco-migrate-script/SKILL.md` to match current code | ⬜ | — | |
| 3.4 | Strip absolute paths from `run-migration` skill | ⬜ | — | |
| 3.5 | Restructure playbook phases as "what the script automates + what's manual" | ⬜ | — | |
| 3.6 | Build directory structure: `migrations/`, `tanstack-usage/`, `deco-framework/`, `operations/` | ⬜ | — | |
| 3.7 | "Skills index" in deco-start `README.md` | ⬜ | — | |
| 3.8 | `MIGRATION_REPORT.md` links phases to skill sections | ⬜ | — | |

---

## Active work

**Currently working on**: Phase 1, Wave 1 + parallel housekeeping.

- ✅ **1.4** (buildPageSeo fix) — PR #98 MERGED 2026-05-01 (in `@decocms/start@2.1.3`)
- ✅ **1.5** (`withSiteGlobals` opt-in helper) — PR #102 MERGED 2026-05-01 (in `@decocms/start@2.3.0`)
- ✅ **1.5 validation** — baggagio PR [#5](https://github.com/deco-sites/baggagio-tanstack/pull/5) MERGED 2026-05-01 (`c8e936c`). End-to-end loop closed: framework helper consumed by a real site, ~393 LOC of workaround deleted.
- ✅ **1.6** (casaevideo `Site.json` audit) — done, locks B2 strategy as opt-in (A2)
- ✅ **2.6/C6** (Tier B VTEX import rewrites) — PR #93 MERGED (in `@decocms/start@2.2.0`)
- ✅ **PR sweep & main sync** — 4 PRs merged; 11 stale local branches deleted
- 🟡 **1.1** (invoke singleton) — PR #103 OPEN, awaits review. After release: baggagio deletes `src/runtime.ts`.
- ⬜ **1.3** (vite preloadError helper) — **deferred indefinitely**: only casaevideo has the pattern, no consumer would adopt the framework version. Revisit when a new migration needs it.
- ⬜ **Next options** (after #103 merges):
  1. **#68 Tier 1 extraction** — section metadata analyzer + auto-register withDevice/withMobile (highest correctness ROI for new migrations)
  2. Companion PRs apps-start#18 + deco-start#81 (apps registry) — needs rebase
  3. Phase 1.7 (`createUseCart`/`createUseUser`/`createUseWishlist` factories in apps-start) — bigger architectural lift

---

## Discoveries log

> Append-only. Each entry: date, what we found, where it impacts the plan.

### 2026-05-01 — als-storefront surfaces the htmx track + policy reset

- **als-storefront is the third migration target and the first
  htmx-heavy site.** Production Fresh/Deno repo, ~120 files with
  `hx-*` attributes, 0 `islands/` directory (HTMX is the only
  interactivity model). Vtex-based, uses a `vitouwu/deco` +
  `vitouwu/apps` fork (different from casaevideo's `LelabsTeam`
  fork). Has a site-local `apps/local/shippo.ts` integration.
- **Prior `als-tanstack` attempt is a throwaway.** Migrated on
  `@decocms/start@2.1.2` (we're at 2.15+), 750 files analyzed, 178
  manual-review items. The vast majority of those items: HTMX
  patterns flagged but not transformed. The site has React syntax
  but `hx-*` attributes that don't function — non-bootable. Per D5,
  `rm -rf` and re-migrate on 2.14+ once Wave 12-13 land.
- **Policy reset (2026-05-01)**: "wait for the 3rd site" is the
  wrong heuristic. New bar: design for 100 sites. When the surface
  of an abstraction is well-understood, ship; otherwise, decide
  explicitly via D-records. Five constitutional decisions (D1–D5)
  signed off this date — see `Decisions made` table. Captured as
  always-loaded rule at
  [`.cursor/rules/migration-tooling-policy.mdc`](./.cursor/rules/migration-tooling-policy.mdc).
- **What als + others tell us is ready to ship now (no more
  deferrals)**: `createUseUser` factory, `createUseWishlist`
  factory, audit `--fix` for vtex-shim swap cases (`toProduct`,
  `withSegmentCookie`), audit `--fix` for `obsolete-vite-plugins`,
  htmx detect-and-categorize Phase, htmx skill catalog,
  `htmx-residue` audit rule, top-3 htmx codemods, throwing stubs
  per D3. All scoped into Waves 12–14.
- **Priority order rewritten**: (1) framework + commerce changes
  first → (2) scripts + skills to make migration to the new
  versions automated → (3) als migration end-to-end → (4) PR sweep
  across existing TanStack sites bumping versions and applying
  audit fixes. See `Priority order (current)` section.

### 2026-04-30 — initial investigation

- **`@decocms/start` and `@decocms/apps` versions diverge across sites.**
  casaevideo: `start ^1.4.4`, `apps ^1.3.1`. baggagio: `start ^2.0.0`,
  `apps ^1.6.0`. → All new factory APIs must be **additive**, never break
  existing surfaces. casaevideo never has to upgrade.
- **The migration script is a self-perpetuating loop for some duplication.**
  `lib-utils.ts` template generates the very stubs (A1) that we then identify
  as "site-level code that should be in packages." Fixing A1 and C6 must
  happen together.
- **`section-conventions.ts` hard-codes Casa-specific section basenames**
  (`ProductShelf*`, `CouponList`, `DepartamentList`). For other sites this is
  silently wrong — needs config-driven approach (C4).
- **baggagio's `cmsRouteWithGlobals.ts` is an explicitly-documented workaround**
  with a clear path to deletion once B1 + B2 land in `@decocms/start`.

### 2026-05-01 — Phase 1.5 closes the loop end-to-end

First full demonstration of the plan's central thesis ("framework absorbs proven patterns; sites get smaller"):

- **deco-start#102** (framework helper) shipped → `@decocms/start@2.3.0`
- **baggagio-tanstack#5** (site cleanup) consumed it → 3 workaround files (456 LOC) deleted, replaced with 63 LOC of native usage
- **Casa&Video unaffected** — does not opt in, manual mount in `__root.tsx` continues to work

This validates the architecture decisions baked into the plan:
1. **Opt-in over default-on** (A2 strategy) was the right call. Casa&Video would have broken if `withSiteGlobals` were default behavior.
2. **Generalize over hardcode**: framework exposes `siteGlobals.rawRefs` (raw refs of all `Site` block sections), site-specific extraction (e.g. analytics tracking IDs by `__resolveType`) lives in 8 lines of site code.
3. **Companion bug fix matters**: `buildPageSeo` (#98) had to ship first or baggagio would have needed to keep its `applySeoTemplatesFromSiteBlock` workaround.

Pattern to repeat for future Phase 1 items: small framework PR → release → consuming site PR in same session, both reviewed by Fernando.

### 2026-05-01 — PR sweep findings

- **Two open PRs were directly aligned with the plan and merged immediately:**
  - **#101** (perf/schema): real benchmark **23.5s → 3.4s** on 125-section site. Pure perf, no behavior change. Author had run `tsc` + `biome`. Squashed to `ad0af3f`.
  - **#93** (Tier B VTEX rewrites): this is **literally Phase 2 item C6 / 2.6**. Companion `apps-start#23` was already merged; verified target paths (`vtex/inline-loaders/`, `loaders/legacy.ts`, `utils/fetch.ts`) all exist. 67 tests pass. Squashed to `6615d26`. **Plan item 2.6 partially closed** by this PR (remaining: `lib-utils.ts` template removal, sequenced after 1.7).
- **deco-start main went from `cf67576` → `1e8326b` (release 2.1.3)** during this work. Notable additions in main: `src/daemon/` (auth/fs/tunnel/volumes/watch — new feature), `src/cms/sectionLoaders.test.ts` (tests added), Vite plugin updates.
- **#98 fix shipped in `@decocms/start@2.1.3`** (verified via `git pull` showing `cmsRoute.ts | 14 +` matching the fix size). baggagio can already upgrade from `^2.0.0` to `^2.1.3` to drop its `applySeoTemplatesFromSiteBlock` workaround.
- **6 of 10 deco-start orphan branches are clearly superseded** (titles match commits already merged into main with the same names). Safe to close + delete after worktree cleanup for the worktree-linked ones.
- **3 apps-start orphan branches are plan-aligned and worth investigating**:
  - `vibe-dex/cart-staletime-30s` → fits Phase 1.7 (`createUseCart` factory)
  - `feat/tier-b-vtex-surface` → 6 commits, complements just-merged #93
  - `vibe-dex/fix-image-cdn-{loop,src-slash}` → fresh, near-main, ship as PR

### 2026-04-30 — Phase 1 kickoff: B1 already done, B2 strategy locked

- **B1 fix already exists as PR #98.** Branch `fix/site-seo-template-no-page-section`,
  commit `b27b5cd`. 14 additions, 0 deletions, no human review yet, no CI failures.
  The fix matches exactly what we'd write. **No new work needed — just merge + release.**
  baggagio's `applySeoTemplatesFromSiteBlock` workaround (in `cms/cmsRouteWithGlobals.ts`)
  becomes deletable as soon as the next `@decocms/start` patch (≥ 2.0.2) ships.
  - URL: https://github.com/decocms/deco-start/pull/98
  - Status as of 2026-04-30: OPEN, mergeable, no reviews
- **casaevideo `.deco/blocks/Site.json` audit complete:**
  - `site.theme`: ✅ multivariate theme (`theme-default`)
  - `site.global`: ✅ 5 sections — `vtex/sections/Analytics/Vtex.tsx`,
    `site/sections/WishlistProviderSection.tsx`, `site/sections/Script.tsx` (Weni chat),
    `site/sections/Analytics/IsEvents.tsx`, `site/sections/Sourei/Sourei.tsx`
  - `site.pageSections`: ❌ not present
  - `site.seo.titleTemplate` / `descriptionTemplate`: both `"%s"` (no-op)
- **casaevideo's `__root.tsx` already mounts `<GlobalAnalytics />` manually** — it
  handles globals via a hand-coded root-component pattern, not via CMS auto-merge.
  WishlistProvider, Sourei, etc. are also expected to be wired site-side somewhere
  (need to verify, but the pattern is clear).
- **B2 strategy locked: stay opt-in (A2 forever for now).**
  Auto-merging `site.theme + site.global + site.pageSections` into every page's
  `resolvedSections` (A1) would activate dormant CMS data on casaevideo and risk
  duplicate rendering (e.g. WishlistProvider already in `__root` would render twice).
  Promotion to default-on requires a casaevideo-side migration to move globals out
  of `__root` into the CMS-merged path — out of scope. **Plan item 1.13 is therefore
  parked indefinitely** unless a future site migration revisits it.

---

## PR log

> One row per PR. Update status as PRs move through review.

| Date | Repo | Branch | PR | Status | Items |
|------|------|--------|----|--------|-------|
| 2026-04-28 | deco-start | `fix/site-seo-template-no-page-section` | [#98](https://github.com/decocms/deco-start/pull/98) | ✅ MERGED 2026-05-01 (`787c6e8`) | 1.4 (B1 fix) |
| 2026-04-30 | deco-start | (vitoUwu/perf-schema) | [#101](https://github.com/decocms/deco-start/pull/101) | ✅ MERGED 2026-05-01 (`ad0af3f`) | Tangential perf — section schema gen 23.5s→3.4s |
| 2026-04-27 | deco-start | (vibe-dex/tier-b-rewrites) | [#93](https://github.com/decocms/deco-start/pull/93) | ✅ MERGED 2026-05-01 (`6615d26`) | **Plan 2.6 / C6** — Tier B VTEX import rewrites |
| 2026-05-01 | deco-start | `feat/with-site-globals` | [#102](https://github.com/decocms/deco-start/pull/102) | ✅ MERGED 2026-05-01 (`03fec63`) → `@decocms/start@2.3.0` | **Plan 1.5** — `withSiteGlobals` opt-in helper. Unblocks bagaggio dropping `cmsRouteWithGlobals`/`site-globals`/`useSiteGlobals`. |
| 2026-05-01 | baggagio-tanstack | `feat/use-with-site-globals` | [#5](https://github.com/deco-sites/baggagio-tanstack/pull/5) | ✅ MERGED 2026-05-01 (`c8e936c`) | **Validates 1.5 end-to-end.** Bumped to `@decocms/start@2.3.0`, replaced 3 workaround files with `withSiteGlobals` helper. **−456 / +63 LOC** (net −393 lines). |
| 2026-05-01 | deco-start | `feat/sdk-invoke-singleton` | [#103](https://github.com/decocms/deco-start/pull/103) | ✅ **MERGED → @decocms/start@2.4.0** | **Plan 1.1** — exports default `invoke` singleton from `@decocms/start/sdk/invoke` + adds `createAppInvoke`/`invoke`/`NestedFromFlat` to sdk barrel. |
| 2026-05-01 | baggagio-tanstack | `feat/use-sdk-invoke` | [#6](https://github.com/deco-sites/baggagio-tanstack/pull/6) | 🟡 OPEN, awaits review | **Plan 1.1 consumer** — bumps `@decocms/start` to ^2.4.0, deletes `src/runtime.ts` (-45 LOC), 3 import sites swapped to `@decocms/start/sdk`. Closes the loop on Phase 1.1 end-to-end. |
| 2026-05-01 | deco-start | `fix/nested-section-loader-recursion` | [#104](https://github.com/decocms/deco-start/pull/104) | ✅ **MERGED → @decocms/start@2.4.1** | **Plan 1.x (new)** — `runSingleSectionLoader` now recursively runs loaders for nested sections in props (e.g. `BackgroundWrapper > CategoryBanner`). Eliminates the manual walk pattern present in `casaevideo-storefront/src/setup/section-loaders.ts`. Supersedes #34. +159 prod LOC, +147 test LOC, 6 new tests, 14/14 pass. |
| 2026-05-01 | baggagio-tanstack | `feat/use-sdk-invoke` | [#6](https://github.com/deco-sites/baggagio-tanstack/pull/6) | ✅ **MERGED** | Plan 1.1 closed end-to-end. -45 LOC. |
| 2026-05-01 | deco-start | `fix/strip-ts-extensions-from-published-imports` | [#105](https://github.com/decocms/deco-start/pull/105) | 🟡 OPEN, awaits review | **Plan 1.x (new)** — strips redundant `.ts` extensions from 20 internal relative imports in published `src/` files. Removes ~8 framework-induced TS5097 errors that every consumer's `tsc --noEmit` currently sees. Pure path changes (20+/20-, no formatting noise). 104/104 tests pass. |

---

## PR / branch sweep — 2026-04-30

> Snapshot of all open PRs and merged-but-undeleted local branches across
> `deco-start` and `apps-start`. Re-run as needed.

### deco-start — open PRs (5)

| # | Title | Author | Age | Files | Mergeable | Aligned with plan? | Recommendation |
|---|-------|--------|-----|-------|-----------|-------------------|----------------|
| [#101](https://github.com/decocms/deco-start/pull/101) | perf(schema): speed up section schema gen | vitoUwu | 5h | 1 | ✅ CLEAN | Tangential | ✅ **Merged 2026-05-01** |
| [#93](https://github.com/decocms/deco-start/pull/93) | feat(migrate): rewrite Tier B VTEX imports to native apps-start paths | vibe-dex | 3d | 1 | ✅ CLEAN | **Yes — directly = item 2.6 / C6** | ✅ **Merged 2026-05-01** |
| [#81](https://github.com/decocms/deco-start/pull/81) | refactor: use `@decocms/apps/registry` instead of hardcoded APP_MODS | JonasJesus42 | 17d | 1 | ❌ DIRTY (conflicts) | Tangential cleanup | **Companion to apps-start#18** — rebase together, merge #18 first. Deferred — both stale. |
| [#68](https://github.com/decocms/deco-start/pull/68) | fix(migrate): close deterministic gaps between migrated and golden reference | vibe-dex | 24d | **25** | ❌ DIRTY (conflicts) | Was — items 2.x | ✅ **Closed 2026-05-01** — pr-68 strictly behind main. File-by-file diff (`main..pr-68`) showed +26 / -408: only 26 lines net-new, all regressions (commerce-loaders signature, `as any` cast, `DetectedPattern` enum entries). All useful Tier 1/2/4 work was merged via other paths. **Lesson re-confirmed**: many small focused PRs > one big PR. |
| [#34](https://github.com/decocms/deco-start/pull/34) | fix: run section loaders for nested sections recursively | JonasJesus42 | 38d | 1 | ❌ DIRTY (conflicts) | Tangential bugfix | ✅ **Closed 2026-05-01 → superseded by [#104](https://github.com/decocms/deco-start/pull/104)**. Concept ported forward on top of current main (with `withPageContext`/`injectPageContext` preserved + tighter `isNestedSection` guard + 6 new tests + concrete eviedence from casaevideo-storefront's manual workaround). |

### apps-start — open PRs (1)

| # | Title | Author | Age | Files | Mergeable | Aligned? | Recommendation |
|---|-------|--------|-----|-------|-----------|----------|----------------|
| [#18](https://github.com/decocms/apps-start/pull/18) | feat: add app registry for framework auto-discovery | JonasJesus42 | 17d | 3 | ❌ DIRTY (conflicts) | Tangential, but enables deco-start#81 | Deferred — strictly behind main (1028 lines deleted on this branch). Same rebase pattern as #68; salvage `registry.ts` as a new fresh PR if/when needed. |

### Local branches merged into `origin/main` — safe to delete

**deco-start** (10 + my current branch):
- `feat/migrate-minicart-rewrite`, `fix/deferred-wrapper-and-location-matcher`,
  `fix/pathname-matcher-case-format`, `fix/robots-meta-tag`, `lightweight-template`,
  `vibe-dex/bangalore` ⚠️, `vibe-dex/bump-for-publish-2`, `vibe-dex/bump-minor-1-5` ⚠️,
  `vibe-dex/cms-loader-review` ⚠️, `vibe-dex/fix-vite-peer`,
  `fix/site-seo-template-no-page-section` (PR #98 just merged — currently checked out)

**apps-start** (3):
- `fix/cookie-parser-max-age-expires`, `lightweight-template`, `trigger-release`

⚠️ = branch has a linked git worktree in `~/conductor/workspaces/...`. Worktree must be removed
before deleting the branch (`git worktree remove ...` then `git branch -d ...`).

### Local branches NOT merged

**deco-start** (11 — unclear if active or stale):
- `feat/cache-profiles`, `feat/migrate-tier-b-rewrites`, `perf/code-split-sections`,
  `vibe-dex/bump-for-publish`, `vibe-dex/check-knowledge`,
  `vibe-dex/chunk-defer-eager` ⚠️, `vibe-dex/deco-vite-plugin`,
  `vibe-dex/deferred-loader-export`, `vibe-dex/fix-deferred-cache-miss` ⚠️,
  `vibe-dex/fix-worker-caching`, `vibe-dex/segment-start-plan`

**apps-start** (12 — unclear if active or stale):
- `feat/canonical-minicart`, `feat/canonical-minicart-hoist`, `feat/tier-b-vtex-surface`,
  `fix/marketplace-seller-and-improvements`, `fix/release-version-bump-1.5.0`,
  `vibe-dex/athens`, `vibe-dex/cart-staletime-30s`, `vibe-dex/fix-image-cdn-loop`,
  `vibe-dex/fix-image-cdn-src-slash` ⚠️, `vibe-dex/product-shelf-lean`,
  `vibe-dex/slim-product-data` ⚠️, `vibe-dex/vtex-cookie-cache-fix`

These have no open PR. Each needs human judgment: ship a PR, abandon, or keep parked.

### Triage actions

| Action | Status |
|--------|--------|
| Merge #101 (schema perf) | ✅ Done 2026-05-01 |
| Merge #93 (Tier B VTEX rewrites — Phase 2.6) | ✅ Done 2026-05-01 |
| Merge #98 (buildPageSeo titleTemplate fix — B1) | ✅ Done 2026-05-01 |
| Merge #102 (`withSiteGlobals` opt-in helper — B2/A3) | ✅ Done 2026-05-01 |
| Merge #103 (default `invoke` singleton — Plan 1.1) | ✅ Done 2026-05-01 → @decocms/start@2.4.0 |
| Sync local main + delete safe merged branches in both repos | ✅ Done 2026-05-01 (11 branches deleted) |
| baggagio#5 (consume `withSiteGlobals` end-to-end) | ✅ Done 2026-05-01 — -393 LOC |
| baggagio#6 (consume `invoke` singleton, delete `src/runtime.ts`) | 🟡 Open 2026-05-01 — -45 LOC |
| Pair #18 + #81 (apps registry + consume) | Deferred — both behind main, low priority |
| **Close #68** (large migrate-gaps PR — strictly behind main) | ✅ Done 2026-05-01 — see explanation in PR comment |
| **Close #34** (nested section loaders — superseded by #104) | ✅ Done 2026-05-01 |
| **Open #104** (port-forward of #34's nested loader fix on current main) | 🟡 Open 2026-05-01 — +159 prod / +147 test, 6 new tests |
| Delete stale `apps-start/vibe-dex/fix-image-cdn-{loop,src-slash}` branches | ✅ Done 2026-05-01 (work merged via #28/#29) |
| Audit orphan branches (10 deco-start, 12 apps-start) | ✅ Done — see below |

### Slice plan for PR #68 (24-day-old, 25-file, conflicting)

Body identifies **4 Tiers** mapping cleanly to Phase 2 items:

| Tier | What it does | Files | Plan alignment |
|------|--------------|-------|----------------|
| **1: Pages** | Section metadata analyzer follows re-exports; section-loaders template auto-registers `withDevice`/`withMobile`; `convertDirectComponentCalls` cleanup; secrets-before-commerce-loaders scaffold reorder | `analyzers/section-metadata.ts`, `phase-analyze.ts`, `phase-cleanup.ts`, `phase-scaffold.ts`, `templates/section-loaders.ts`, `templates/commerce-loaders.ts` | Plan **C1, C4** + part of **2.4** |
| **2: CSS** | `oklch(var(--x))` wrapping in app-css template; auto-detect `--font-sans` from `@font-face` | `templates/app-css.ts` | Tangential, but visual parity = critical correctness |
| **3: Imports** | Inline-stub→`~/lib/*` rewrites; `~/utils/retry`→`@decocms/start/sdk/retry`; PLPProps in `~/types/vtex-loaders`; generate `src/sdk/logger.ts` | `transforms/imports.ts`, `transforms/dead-code.ts`, `templates/lib-utils.ts`, `templates/types-gen.ts` | **Predecessor to 1.7** — interim before we can delete `~/lib/*` entirely |
| **4: Polish** | `modalType` in variant omit; `normalizeImportCasing` for Linux CI | `phase-cleanup.ts`, `transforms/jsx.ts`, `transforms/section-conventions.ts` | Tangential |

**Recommendation**: Don't merge #68 wholesale (too stale, conflicts, large diff to review). Instead:
1. Check out #68 locally, attempt rebase onto main
2. If rebase resolves cleanly → assess actual remaining diff
3. Reissue as **4 focused PRs** (one per Tier) on fresh branches, cherry-picking the still-relevant changes
4. Tier 1 first (biggest correctness impact for any new migration)
5. Original PR closed with link to the slice PRs

Risks:
- 24-day drift may have invalidated some changes (e.g. Tier 3's `~/lib/*` is partially obsoleted by #93 routing direct to `@decocms/apps/vtex/utils/*`). Need to read each diff.
- Author was vibe-dex (Cursor agent on conductor). Re-issuing under our authorship is fine; we credit the work.

### Orphan branch audit

#### deco-start — 10 orphan branches, mostly superseded

| Branch | Ahead/Behind | Age | Status | Recommendation |
|--------|--------------|-----|--------|----------------|
| `feat/cache-profiles` | 1/203 | 5w | ✅ Superseded by `d0365af feat: unified cache profile system...` in main | Close + delete |
| `perf/code-split-sections` | 1/312 | 6w | ✅ Superseded by `2e09fe8 perf: unified render path... (#23)` | Close + delete |
| `vibe-dex/chunk-defer-eager` ⚠️ | 1/73 | 3w | ✅ Superseded by `91fa2c5 ... (#77)` | Close + delete (worktree first) |
| `vibe-dex/deferred-loader-export` | 1/289 | 6w | ✅ Superseded by `b79ff3f ... (#30)` | Close + delete |
| `vibe-dex/fix-deferred-cache-miss` ⚠️ | 1/71 | 3w | ✅ Superseded by `7dc3071 ... (#78)` | Close + delete (worktree first) |
| `vibe-dex/segment-start-plan` | 1/285 | 6w | Likely superseded by #23 mobile perf work | Verify, then close |
| `vibe-dex/check-knowledge` | 1/363 | 6w | Single experimental commit, very stale | Verify intent, likely close |
| `vibe-dex/deco-vite-plugin` | 2/317 | 6w | Vite peer dep fix — main may have alternative | Verify, likely close |
| `vibe-dex/fix-worker-caching` | 2/90 | 3w | Has merge commit; worker caching may overlap with main work | Read diff, decide |
| `vibe-dex/bump-for-publish` | 1/58 | 2w | Release plumbing | Close (release works without it) |

#### apps-start — 12 orphan branches, mixed

| Branch | Ahead/Behind | Age | Plan-relevant | Recommendation |
|--------|--------------|-----|---------------|----------------|
| `vibe-dex/fix-image-cdn-src-slash` ⚠️ | 1/2 | 4h | Possibly | **Open PR** — fresh, near main |
| `vibe-dex/fix-image-cdn-loop` | 2/4 | 5h | Possibly | Likely superseded by `-src-slash` (same title, cleaner branch) — close after confirming |
| `feat/canonical-minicart-hoist` | 1/14 | 3d | **Yes — Phase 1 minicart**| Read content, decide if salvageable |
| `feat/canonical-minicart` | 2/14 | 4d | **Yes — Phase 1 minicart** | Companion to above |
| `feat/tier-b-vtex-surface` | 6/11 | 3d | **Yes — Tier B work** | Read 6-commit diff, decide |
| `fix/release-version-bump-1.5.0` | 1/13 | 3d | No | Release plumbing — close |
| `vibe-dex/cart-staletime-30s` | 1/83 | 6w | **Yes — useCart (Phase 1.7)** | Cherry-pick value into our `createUseCart` factory work |
| `vibe-dex/slim-product-data` ⚠️ | 2/33 | 3w | Possibly | Read diff, decide |
| `vibe-dex/vtex-cookie-cache-fix` | 3/35 | 3w | Possibly | Read diff, decide |
| `vibe-dex/athens` | 5/88 | 6w | No | Read diff, likely close |
| `vibe-dex/product-shelf-lean` | 2/85 | 6w | No | Read diff, likely close |
| `fix/marketplace-seller-and-improvements` | 1/81 | 5w | No | Single commit, very stale — read diff, likely close |

**Top picks for follow-up**:
1. `apps-start/vibe-dex/cart-staletime-30s` — directly aligned with Phase 1.7 (`createUseCart` factory). 30s default staleTime is the kind of perf default we'd ship with the factory.
2. `apps-start/feat/tier-b-vtex-surface` — 6 commits of Tier B work; complements deco-start#93 we just merged.
3. `apps-start/vibe-dex/fix-image-cdn-{loop,src-slash}` — both 4-5h old, near main, 1-2 commits. Likely a quick PR to ship.

⚠️ = branch has a worktree in `~/conductor/workspaces/...`

---

## Open questions / parking lot

- Is there a next site queued for migration? (Affects priority of Phase 2 Wave 2.)
- Should the cross-package coordination (e.g. landing 1.7 + 2.6 together)
  motivate making deco-start + apps-start a real monorepo? (Defer until
  Phase 1 ships.)
- Where should runtime helpers (deviceServer, useSuggestions, etc.) that
  appear in some-but-not-all sites land? (Re-evaluate after Phase 1.)

---

## Session 2026-05-01 — batch summary

### Wave 1 (morning) — 2 PRs

1. [`baggagio-tanstack#6`](https://github.com/deco-sites/baggagio-tanstack/pull/6) — `refactor(runtime): consume invoke singleton from @decocms/start/sdk` ✅ **MERGED**. Plan 1.1 closed end-to-end. -45 LOC.
2. [`deco-start#104`](https://github.com/decocms/deco-start/pull/104) — `fix(cms/sectionLoaders): run loaders for nested sections recursively` ✅ **MERGED → @decocms/start@2.4.1**. Port-forward of #34, with concrete casaevideo-storefront evidence; +306 LOC mostly tests.

### Wave 2 (after merges) — 1 PR

3. [`deco-start#105`](https://github.com/decocms/deco-start/pull/105) — `fix(src): strip .ts extensions from internal imports for consumer typecheck` 🟡 **OPEN**. Removes ~8 framework-induced TS5097 errors every consumer site sees on `tsc --noEmit`. Surgical: 20+/20- pure import path changes, no formatting noise. 104/104 tests pass.

### Closed/decided (2)

4. [`deco-start#68`](https://github.com/decocms/deco-start/pull/68) — Closed. File-by-file diff vs current main proved pr-68 is strictly behind: +26 lines (regressions only) / -408 lines (features main has that pr-68 lacks). All useful Tier 1/2/4 work was already merged through other paths. **Re-confirms the small-PR principle.**
5. [`deco-start#34`](https://github.com/decocms/deco-start/pull/34) — Closed, superseded by #104.

### Stale branches deleted (2)

6. `apps-start/vibe-dex/fix-image-cdn-loop` — superseded by merged PR #28
7. `apps-start/vibe-dex/fix-image-cdn-src-slash` — superseded by merged PR #29

**Discoveries**:

- **Casaevideo-storefront's `BackgroundWrapper` workaround** (`src/setup/section-loaders.ts:41`): 12-line manual `runSingleSectionLoader` walk that exists *because* of the framework gap fixed by #104. With #104 shipped, that block collapses to one line: `"site/sections/LpContent/BackgroundWrapper.tsx": withMobile(),`. Concrete proof of value. (Optional follow-up PR pending user approval.)
- **PR #68 was a recurring lesson**: small focused PRs win over large omnibus ones. The work landed faster as 4-5 separate PRs from different authors than as one big PR could ever have.
- **apps-start#18 has the same shape as #68** (1028 lines deleted on the branch vs main; only ~56 lines net-new). If we want app-registry, the right move is a fresh PR adding just `registry.ts` on current main — not a rebase.
- **The framework publishes raw TypeScript source** (no `dist/` in `exports`, all paths point to `./src/...`). This works because Vite/tsx compile on the fly, but it means every internal import in `src/` is part of the public API contract and must be valid for consumers' `tsc`. Discovered via 8 leaking TS5097 errors in baggagio's typecheck → led to #105.
- **`npm run build` is currently broken on main** (48 TS5097 errors in `scripts/`, plus 1 pre-existing test typing nit). Releases keep working because `dist/` isn't actually consumed (all `package.json` exports point to `src/`). Worth a follow-up to either (a) exclude scripts from the build tsconfig, (b) add `allowImportingTsExtensions` for scripts, or (c) drop `.ts` extensions from scripts too.

**Deferred (no quality compromise)**:

- vibe-dex orphan branches in apps-start (5 remaining) — each 3-6 weeks old with infra drift; need individual care, not a bulk batch.
- Phase 1.7 (commerce hook factories `createUseCart`/`createUseUser`/`createUseWishlist`) — multi-day architectural lift, dedicated session.
- apps-start#18 + deco-start#81 (apps registry) — tangential cleanup; revisit when there's a clear consumer.

### Wave 3 (afternoon) — 3 PRs

8. [`deco-start#106`](https://github.com/decocms/deco-start/pull/106) — `fix(build): make tsc build clean (49 errors → 0)` 🟡 **OPEN**.
   Three independent issues: 47× TS5097 in `scripts/` (.ts extensions, same shape as #105 but for the script side); 1× TS2322 in `phase-analyze.ts` (variable typed as required, function returns optional); 1× TS2493 in `sectionLoaders.test.ts` (`vi.fn` declared 1-arg but test destructures 2). 35 files, +85/-82.

9. [`baggagio-tanstack#7`](https://github.com/deco-sites/baggagio-tanstack/pull/7) — `chore(lib): remove dead VTEX shim files (-235 LOC)` 🟡 **OPEN**.
   Delete all 11 files under `src/lib/`. Every one is unused; the migration script's two-step rewrite (rewrite to shim, then PR #93 routing back to `@decocms/apps`) left them orphaned. Verified zero net-imports broken.

10. [`deco-start#107`](https://github.com/decocms/deco-start/pull/107) — `fix(migrate): stop regressing valid @decocms/apps/vtex imports to dead shims` 🟡 **OPEN**.
    Surgical migration-script bug fix: empty the `rewriteVtexUtilImports` `importRewrites` array. The cleanup pass was actively taking valid `@decocms/apps/vtex/utils/*` and `@decocms/apps/vtex/client` imports and pointing them at NO-OP shims. Silent runtime regression on every migrated site (segment auth, IS cookies, transforms all stubbed to `{}` or `null`). First-pass `transforms/imports.ts:50-52` already produces the correct direct form.

### Wave 3 discoveries

- **Migration-script generates dead code by design**: `templates/lib-utils.ts` writes 11 shim files, of which 6 (`vtex-transform`, `vtex-intelligent-search`, `vtex-segment`, `vtex-client`, `vtex-id`, `vtex-fetch`) are dead in any site post-#93. The other 4 (`http-utils`, `graphql-utils`, `fetch-utils`, `filter-navigate`) bridge `apps/utils/*` (which `@decocms/apps` doesn't export equivalents for) so they're still useful — but should ideally be lazily generated only when a corresponding rewrite rule fires.
- **#107 is the upstream fix that prevents future sites from accumulating the #7-style debt.** Order matters: #107 should land before any new migration is run, otherwise the next site will need its own dead-shim cleanup PR.
- **The build break on main is a smaller bug than I assumed**: 49 errors total, of which only 2 were "real" type bugs (TS2322 + TS2493). The other 47 were the same .ts-extension issue as #105, just on the scripts side. All fixable with one mechanical pass + 2 surgical edits.
- **Discovery → fix → upstream loop**: this session validated a new pattern. Site cleanup (#7) reveals migration-script bug. Migration-script fix (#107) prevents future sites from inheriting it. Plan tracker captures both. The framework gets stronger on each migration.

### Open items spawned this wave

- [ ] Lazy shim generation in `lib-utils.ts` template (only write files corresponding to fired rewrite rules) — Phase 2 candidate
- [ ] Drop the 6 VTEX shim templates after #107 merges (currently still reachable via inline-stub-hoisting path; route those direct to `@decocms/apps/vtex/...` in a follow-up)
- [ ] Add vitest config for `scripts/` so future migration-transform changes can have regression tests without fs mocking gymnastics
- [ ] Update existing migration skills (`.claude/skills/deco-to-tanstack-migration/`, `.cursor/skills/...`) to reflect the new script behavior post-#107 and the post-migration cleanup checklist (delete unused `src/lib/*` shims if not imported)

### Wave 3 continued — 1 more PR

11. [`deco-start#108`](https://github.com/decocms/deco-start/pull/108) — `feat(vite): bundle meta.gen stub + drop crashing chunk splits + add .deco.studio` 🟡 **OPEN**.
    Three small `decoVitePlugin()` extensions that absorb boilerplate both real-world sites kept inline:
    - **`meta.gen` client stub**: server-only admin schema (0.5-5 MB) was leaking into browser bundles. Both sites had identical inline `deco-stub-meta-gen` plugin; casaevideo's even has `// TODO: move into decoVitePlugin in next @decocms/start release.`
    - **Drop `@decocms/start` / `@decocms/apps` chunk splits**: rules pushed packages into separate chunks despite circular re-exports, causing runtime crashes ("undefined is not a function"). Both sites worked around this with `site-manual-chunks` overrides. Framework default now correct.
    - **Add `.deco.studio` to `allowedHosts`**: new admin frontend domain. Both sites duplicated the list.

    Unblocks ~50 LOC boilerplate cleanup per site once #108 merges + releases.

### Wave 3 — discoveries continued

- **Sites override framework default → framework was wrong**: when both real sites override the same framework default, that's not a special case — it's evidence the default is broken. The vite plugin's `vendor-deco` chunk crashed in production, so every site overrode it. That's a clear "fix the framework" signal, captured in #108.
- **Inline plugins as evidence**: when a site's `vite.config.ts` has an inline plugin that any other site could lift verbatim (no site-specific values), it's framework boilerplate. Two sites + zero customization × 14 lines = framework PR opportunity. Same heuristic worked for #93 (withSiteGlobals), #103 (invoke), #104 (nested loaders), and now #108.
- **TODO comments as roadmap items**: casaevideo's `TODO: move into decoVitePlugin in next @decocms/start release` was 6+ months old and orphaned. Searching for `TODO.*deco|TODO.*framework` in production sites is a cheap, accurate way to find queued framework work. Worth automating as a periodic audit.

### Wave 3 — skill modernization

12. [`deco-start#109`](https://github.com/decocms/deco-start/pull/109) — `docs(migration-skill): use decoVitePlugin in templates + add cleanup checklist` 🟡 **OPEN**.
    - `templates/vite-config.md`: Drop ~80 lines of stub duplication. Old template inlined what `decoVitePlugin()` already does. New template uses the plugin and adds the production-grade boilerplate real sites need (VTEX proxy, CSP, dedupe, sourcemap, react-compiler, console.log strip).
    - `references/vite-config/README.md`: Fix broken "minimal" config (it was missing `decoVitePlugin()` and would crash any real Deco site).
    - `references/post-migration-cleanup.md` (NEW): 6-step checklist for cleanup that surfaces on every migration — delete unused `src/lib/*` shims (with detection script), drop inline vite plugins now framework-provided, drop `runtime.ts` shim, drop `withSiteGlobals` workaround, verify VTEX imports point direct at apps, audit `TODO: move into framework` comments. Each step has a corresponding shipped or in-flight PR validating it.

### Wave 4 (post-2.5.0 follow-ups) — 2 PRs

13. [`baggagio-tanstack#8`](https://github.com/deco-sites/baggagio-tanstack/pull/8) — `chore(vite): consume @decocms/start@2.5.0 + drop now-redundant inline plugins` 🟡 **OPEN**.
    End-to-end validation of #108. Bumps to 2.5.0 and deletes `site-manual-chunks` + `deco-stub-meta-gen` inline plugins. Production build verified: meta.gen confirmed stubbed on client (0 hits across `dist/client/`), 955KB present only in server bundle. Typecheck went from 8 errors (7 pre-existing from older deco-start, 1 sitemap) to **0** thanks to the bump pulling in #105's `.ts` strip. -25 LOC net.

14. [`deco-start#110`](https://github.com/decocms/deco-start/pull/110) — `feat(migrate): generate src/lib/* shims lazily — only the ones actually imported` 🟡 **OPEN**.
    Closes the loop on #107. Replaces eager `generateLibUtils(ctx)` (writes all 11 shims unconditionally) with lazy `writeImportedLibShims(ctx)` at end of `phase-cleanup` — scans final `src/**` for `from "~/lib/X"` imports and writes only matching templates. Result: clean migrations get NO `src/lib/` directory at all. baggagio#7-style cleanups become unnecessary on future migrations.

    Follow-up commit on the same branch added vitest coverage: 10 unit tests for `LIB_TEMPLATES` + `selectImportedLibTemplates`, 7 integration tests against a real tmpdir for `writeImportedLibShims`. Updated `vitest.config.ts` with `environmentMatchGlobs` so script tests run in `node` env. Writing the tests caught one real bug (`mkdirSync` ran before the dry-run skip, leaving an empty `src/lib/` on disk in dry-run mode — fixed in same commit). Total cumulative: 121 tests pass (was 104).

15. [`apps-start#30`](https://github.com/decocms/apps-start/pull/30) — `chore(vtex): bump @decocms/start devDep to 2.5.0 + drop responseHeaders bag fallback` 🟡 **OPEN**.
    Resolves a stale `TODO: Remove fallback once @decocms/start PR#57 is published` in `vtex/client.ts:15`. PR#57 merged 5 weeks ago; the property has been part of every release since v0.39.0. Bumps devDep `^0.38.0` → `^2.5.0` (peerDep `>=0.19.0` unchanged, no consumer impact). Simplifies `getResponseHeaders()` from 12 lines (with `(ctx as any)` cast + bag fallback + biome-ignore) to 4 lines using the typed property directly. Typecheck still 0 errors, all 244 tests pass.

### Wave 4 — discoveries

- **`apps-start` does NOT export `getSegmentFromBag`, `getISCookiesFromBag`, or `createHttpClient`.** Only `fetchSafe` (in `vtex/utils/fetch.ts`) has a direct equivalent. So we can't simply delete the 6 VTEX shim templates — sites with inline-stub hoisting still need somewhere to hoist *to*. Lazy generation is the right answer because it keeps the templates (for the rare site that needs them) but avoids writing them to clean sites.
- **`tsc` regressions self-heal with version bumps**: baggagio's typecheck baseline went from 8 errors to 0 just by bumping `@decocms/start` (since #105 + #106 + #108 are all in 2.5.0). The "8 errors, all pre-existing" baseline I'd been quoting all session was self-curing on the consumer side — useful signal for triaging future "it's broken on my machine" reports.
- **Two-stage validation pattern proven again**: framework PR (#108) → release (2.5.0) → consumer PR (baggagio#8) confirms the framework change works end-to-end. Same shape as #93→#5, #103→#6, #104→casaevideo signals. Worth codifying as the canonical contributor workflow.

### Wave 4 — discoveries (continued)

- **Casaevideo-storefront `src/lib/` audit**: 10 shim files written by the original migration; 9 are actually imported and load-bearing (`filter-navigate`, `graphql-utils`, `http-utils`, `vtex-client`, `vtex-fetch`, `vtex-id`, `vtex-intelligent-search`, `vtex-segment`, `vtex-transform`), only `fetch-utils.ts` is dead. So the lazy generator (#110) would still produce ~9 files for casaevideo on a fresh re-migration — those shims were *necessary* for that codebase. The "11 dead files" pattern is specific to baggagio because baggagio's source happened to use the new apps-start exports directly (likely because it's a newer codebase with cleaner import hygiene). Useful counter-example for the lazy-generation hypothesis: it isn't free LOC reduction, it's variable per site.
- **Apps-start typecheck against deco-start jumps clean**: bumping `@decocms/start` from `0.38.0` to `2.5.0` (a 2-major-version leap on a 0.x → 2.x package) introduced **zero** type errors in apps-start. Two interpretations: (a) the public API of `@decocms/start` is genuinely stable in the surface area apps-start touches (`RequestContext`, `FnContext`, etc.), or (b) apps-start uses a small enough subset that we got lucky. Either way, encouraging signal that the framework's API is mature enough to hold a stable peerDep range.
- **Tests catch real bugs every time**: the 17 new vitest tests in #110 found 1 dry-run-mode bug on first run (`mkdirSync` ran before the dry-run skip). 6% bug-find rate on a function I'd just written and was confident about. Worth codifying in the contributor workflow: "when adding to the migration script, write at least one fs-touching integration test."

### Wave 5 (post-Wave-4-merge audits) — 2 PRs

16. [`deco-start#111`](https://github.com/decocms/deco-start/pull/111) — `feat(migrate): rewrite widget types to @decocms/start/types/widgets — stop scaffolding local copy` 🟡 **OPEN**.
    Discovered while auditing byte-identical files between baggagio-tanstack and casaevideo-storefront: every Deco TanStack site carries a duplicated 8-line `src/types/widgets.ts`. The framework already exports the same set (plus `TextArea`) at `@decocms/start/types/widgets`, and the schema generator detects widgets via type-text matching, not module identity. PR rewrites `apps/admin/widgets.ts` → `@decocms/start/types/widgets`, stops generating the local file, drops it from verify, updates skill docs + new step 6 in post-migration cleanup. +85 / -18.

17. [`apps-start#31`](https://github.com/decocms/apps-start/pull/31) — `fix(vtex): auto-forward vtex_segment cookie on outgoing API calls` 🟡 **OPEN**.
    Real bug uncovered while diffing the two sites' `setup.ts`: casaevideo has a 15-line `regionAwareFetch` workaround that wraps `_fetch` to inject `vtex_segment` on outgoing calls — without it, Legacy Catalog API returns OutOfStock for products only available through regional sellers. Apps-start already had `withSegmentCookie` (defined but never imported) and `extractRegionIdFromCookies`; the missing piece was forwarding the cookie itself. PR makes `vtexFetchResponse` automatically inject the cookie when (a) request has one and (b) caller didn't set their own cookie header. Conservative — strict superset of existing behavior. +156 / -1, with 7 new vitest cases.

### Wave 5 — discoveries

- **byte-identical files audit between baggagio + casaevideo-storefront**: 11 files match exactly. Most are user UI (`Divider.tsx`, `Spinner.tsx`) that happen to look the same because both copied from a starter. The framework-extraction candidates among the 11 were:
  - `src/routes/deco/{invoke.$,meta,render}.ts` — TanStack file-routing constraint, can't be moved (each site MUST have a file at the route path)
  - `src/server.ts` — `createStartHandler(defaultStreamHandler)`, also a TanStack constraint
  - `src/types/widgets.ts` — **extracted in #111**
  - `src/types/website.ts` — `ExtensionOf<T> = T` identity alias, dead in baggagio, used once in casaevideo. Marked as a stale import-rewrite gap (the migration script generates the stub but has no rule mapping `apps/website/loaders/extension.ts` to it; the catch-all removes the import). Not worth a PR for one consumer.
  - `src/sdk/signal.ts` — re-export wrapper plus a 3-line `effect()` deprecation shim. Dead in baggagio, used 1× in casaevideo's emarsys glue. Framework shouldn't bless the deprecation pattern; leaving site-local.

- **`setup.ts` workaround drift audit**: casaevideo carries two extras over baggagio:
  - 15 lines forwarding `vtex_segment` cookie → **fixed in apps-start#31** (framework now does this).
  - `setAsyncRenderingConfig({ foldThreshold: 3, respectCmsLazy: true })` — opt-in, intended to be per-site.
  - `customMatchers: [registerLocationMatcher]` — site-specific, intentional.
  - `configureWebsite({ seo: site.seo })` inside `initPlatform` — also site-specific.
    
- **`cache-config.ts` is genuinely site-specific**: baggagio registers `/sitemap.xml` → static; casaevideo overrides timing on the static/product/listing profiles. Not framework material — both consume the framework's `setCacheProfile` / `registerCachePattern` API correctly.

### Session 2026-05-01 — running tally

**21 PRs touched/created across 3 repos. 16 merged, 4 in flight, 1 closed.**

### Wave 6 (post-Wave-5 merge, four-PR push) — 4 new PRs

18. [`apps-start#32`](https://github.com/decocms/apps-start/pull/32) — `feat(vtex/hooks): add createUseCart factory for legacy invoke-based cart API` 🟡 **OPEN**.
    Phase 1.7 (commerce hook factories) — first installment. 250-line, near-byte-identical legacy `useCart.ts` template (currently shipped to every migrated site) factored into `vtex/hooks/createUseCart.ts`. Sites can shrink `src/hooks/useCart.ts` from ~250 lines to ~5:
    ```ts
    import { createUseCart } from "@decocms/apps/vtex/hooks/createUseCart";
    import { invoke } from "~/server/invoke";
    export const { useCart, resetCart, itemToAnalyticsItem } = createUseCart({ invoke });
    ```
    Intentionally separate from canonical TanStack-Query `useCart` — different surfaces (singleton signals + awaitable async vs. mutation objects + Minicart). 10 new tests covering factory shape, isolation between calls, and `itemToAnalyticsItem` math. 261 tests pass (was 251).

19. [`deco-start#112`](https://github.com/decocms/deco-start/pull/112) — `feat(migrate): add post-bootstrap compile phase (tsc + optional vite build)` 🟡 **OPEN**.
    Closes the gap that let regressions like #105 (TS5097) and the dead `src/lib/*` shims ship in earlier sessions. Adds Phase 8 — runs `npx tsc --noEmit` after bootstrap; failures surface as warnings by default, errors with `--strict` (for CI), and `--with-build` opt-in for full Vite build. Auto-skipped when `node_modules/` is missing (bootstrap install failure). Command runner is injectable for unit tests — 11 new tests cover dry-run, missing deps, success, failure, strict promotion, build flag gating, output truncation. 132 tests pass (was 121).

20. [`deco-start#113`](https://github.com/decocms/deco-start/pull/113) — `feat(migrate): per-site config for section conventions (.deco-migrate.config.json)` 🟡 **OPEN**.
    Replaces hardcoded casaevideo-specific section name lists in `transforms/section-conventions.ts` with a config layer. Sites whose section names don't match the casaevideo lineage can extend or replace the defaults via `.deco-migrate.config.json` at the source root. **Casaevideo migration unchanged** — defaults stay baked in when no config file exists. 19 new tests covering loading, merge semantics, and validation. 140 tests pass (was 121).

21. [`deco-start#114`](https://github.com/decocms/deco-start/pull/114) — `feat(migrate): emit createUseCart shim instead of 250-line legacy boilerplate` 🟠 **BLOCKED on apps-start#32**.
    Closes the loop on #32. Migration template `templates/hooks.ts` switches to emit the 5-line factory shim instead of duplicating the 250-line legacy implementation. Net `-237 lines` per migrated site going forward. 5 new tests assert the new shim shape and that non-vtex platforms still get the generic stub. Cannot merge until #32 ships in a release — the package-json template auto-fetches latest `@decocms/apps`, so once published the chain is automatic.

### Wave 6 — discoveries

- **Hook factory chain validates the framework-PR → release → consumer-PR pattern at scale**: This is the same shape as #93→#5, #103→#6, #104→casaevideo, #108→baggagio#8. The Wave-6 chain is `apps-start#32` → `apps-start release` → `deco-start#114`. Once that lands, every NEW migration emits the shim automatically. **Existing migrated sites get a follow-up cleanup PR, NOT a behavior change** — their 250-line `useCart.ts` still works.
- **`useUser`/`useWishlist` factories defer to a future session**: site-level versions are already trivial (~10 / ~25 lines). The leverage isn't in factoring those — it's in nudging sites toward the canonical TanStack-Query hooks (`@decocms/apps/vtex/hooks/{useUser,useWishlist}`) over time, or building a `createUseUser` for the legacy signal-based API only if a third site shows up needing it.
- **The "compile phase" PR (#112) was a higher-leverage win than expected**: it would have caught all of #105, #106, and the dead-shim regression at the migration level — three independent bugs in three weeks all fixed by one phase that runs `tsc --noEmit` post-bootstrap. Worth promoting from "nice-to-have" to "default in CI" the moment it lands.
- **Per-site config (#113) opens up non-casaevideo migrations**: previously the script's hardcoded section names made baggagio's migration partially work by accident (overlapping defaults) and any new client a guaranteed manual cleanup. The extend/replace API + JSON validation is small surface, big unblocker.
- **Higher-risk items deferred this wave**: C1 (phase-analyze skipping `src/` layouts) needs careful refactoring of the path-resolution + categorizer — not a 30-min change. C8 (state persistence between phases) is moderate effort but unclear payoff right now. Both are good candidates for a focused session.

### Wave 6 — merged ✅

All four Wave 6 PRs merged. `deco-start#113` had merge conflicts in the `SKILL.md` doc (both #112 and #113 added different content to the same anchor); resolved by preserving both additions in order. After resolution, all 151 deco-start tests + apps-start + typecheck clean.

Releases shipped from Wave 6:
- `@decocms/apps@1.7.0` — adds `vtex/hooks/createUseCart` factory
- `@decocms/start@2.8.0` (compile phase) → `2.9.0` (template shim) → `2.10.0` (per-site config)

### Wave 12 (kicked off 2026-05-01 after D1–D5 sign-off) — Priority 1 (framework + commerce)

After surfacing als-storefront as the third migration target (heavy on
htmx, ~120 hx-* files, prior als-tanstack attempt thrown away), the
"wait for 3rd site" deferrals collapse. Wave 12 ships the abstractions
that als + casaevideo + baggagio have already justified, plus the
audit `--fix` work D3 forces us into.

**Planned PRs (will be filled in as they ship):**

- **W12-A** apps-start: `createUseUser` factory (mirrors `createUseCart` from #32)
- **W12-B** apps-start: `createUseWishlist` factory (same pattern)
- **W12-C** deco-start: throwing stubs in `lib-utils.ts` template + per-stub message linking to skill (D3 implementation)
- **W12-D** deco-start: audit `--fix` for `toProduct` swap (uses #121's `meta.fixHints`)
- **W12-E** deco-start: audit `--fix` for `withSegmentCookie` swap
- **W12-F** deco-start: audit `--fix` for `obsolete-vite-plugins` rule (mechanical cleanup)
- **W12-G** apps-start (or deco-start CLAUDE.md cross-link): per-repo pointer to `migration-tooling-policy.mdc` so the constitutional rule is discoverable from any consumer repo
- **W12-H** deco-start: cleanup phase scaffolds `.cursor/rules/migration-policy-pointer.mdc` in target site, pointing at the canonical rule (D1/D4 enforcement at site level)

Wave 12 ships in priority-1 order; Wave 13 only starts when the
foundation is in place.

### Wave 13 (htmx foundations — Priority 2 part 1) — planned

Once Wave 12 is in, the migration script needs an htmx track because
als is the first heavy htmx site and we know it won't be the last
(per the user, "some of our sites are, not all, not even most, some").

- **W13-A** deco-start: `scripts/migrate/htmx-analyze.ts` — categorize hx-* by pattern (form-swap, click-fetch, hx-on, hx-trigger+useSection, etc.). Output: per-site htmx inventory.
- **W13-B** deco-start: skill `references/htmx-rewrite.md` — pattern catalog with per-pattern rewrite recipe (decision tree: codemod vs manual recipe).
- **W13-C** deco-start: audit rule `htmx-residue` — counts `hx-*` attributes still in `src/`. Required-empty for "rewrite-complete" sites.

D2 forbids an htmx adapter package; nothing in Wave 13 ships htmx
runtime.

### Wave 14 (htmx codemods + first als migration on 2.14+) — planned

- **W14-A** deco-start: codemod `transforms/htmx-form-post-swap.ts` — `<form hx-post={url} hx-target hx-swap>` → `useMutation` + state setter
- **W14-B** deco-start: codemod `transforms/htmx-click-fetch-swap.ts` — `<button hx-get={url}>` → onClick + invoke + state
- **W14-C** deco-start: codemod `transforms/htmx-on-click-script.ts` — `hx-on:click={useScript(...)}` → `onClick` handler
- **W14-D** als: rm -rf old als-tanstack, fresh `deco-migrate` run on 2.14+ with new htmx codemods. Per D5 (no --restart), this is the only restart UX.

### Wave 15+ (htmx cleanup PRs on als + propagation to other sites) — Priority 3 / 4

Each htmx pattern that survives the codemod becomes a per-pattern PR
on als (driven by `htmx-residue` audit), exactly like the
casaevideo vtex-shim cleanup pattern.

After als reaches `htmx-residue: 0`, open priority-4 PRs against
all existing TanStack sites bumping `@decocms/start` and
`@decocms/apps`, running audit `--fix`, and applying the new
recipes.

---

### Wave 11 (post-#120 merge — fix-hint table + first canonical-toProduct cleanup) — 2 PRs

35. [`deco-start#121`](https://github.com/decocms/deco-start/pull/121) — `feat(migrate): per-symbol fix-hint table for vtex-shim-regression rule` ✅ **MERGED**, released as `@decocms/start@2.15.0`.
    Closes the precision gap of #120's `fix:` field: the rule now names the *exact action* per symbol instead of the generic "Repoint imports to '@decocms/apps/vtex/...'" fallback. New `STUB_FIX_HINTS: Record<string, FixHint>` table covers four symbols: `toProduct` (1:1 swap), `withSegmentCookie` (1:1 swap), `getSegmentFromBag` (call-site refactor → `request.headers.get('cookie')` + `buildSegmentFromCookies`), `getISCookiesFromBag` (call-site refactor). Each hint also flags the signature gotcha at the call site (e.g. canonical 4-arg vs stub 1-arg `toProduct`). Findings now also carry structured `meta.fixHints` for JSON consumers. Skill doc § 5 gains a canonical replacement table + three diff-style recipes (Patterns A/B/C) for the 1-arg `toProduct` conversion case (the recipes the hint references). 5 new rule tests + 1 doc commit on the same branch. **Casaevideo audit output post-#121: every finding now actionable in one read** — was "Repoint to @decocms/apps/vtex/...", now "toProduct → @decocms/apps/vtex/utils/transform (1:1 import swap) — canonical signature is `toProduct(product, sku, level, options)`; 1-arg call sites need to expand args first". Detect-only stays — auto-fix for `swap` cases is mechanically possible but needs signature-expansion logic which is non-trivial.

36. [`casaevideo-storefront#212`](https://github.com/deco-sites/casaevideo-tanstack/pull/212) — `fix(loaders): use canonical toProduct from @decocms/apps in smartShelfForYou` 🟡 **OPEN**.
    First production-site application of #121's per-symbol fix hint. Single-line diff (`from "~/lib/vtex-transform"` → `from "@decocms/apps/vtex/utils/transform"`). The call site already used the canonical 4-arg signature with `(toProduct as any)` to bypass the stub's typing — the dev wrote it for canonical, but the import pointed at the stub. **Runtime behaviour was actually broken** — the extra args were silently dropped, products came back without SEO normalization, additional-property mapping, offer aggregation. This PR fixes that. Cast stays for now (local `~/types/vtex.Product` not structurally identical to canonical `LegacyProductVTEX | ProductVTEX` — separate refactor). Casaevideo vtex-shim findings: 4 → 3.

### Wave 11 — discoveries

- **Pattern A/B/C taxonomy crystallized.** The 1-arg `toProduct` conversion has three distinct call-site shapes: (A) "dev wrote 4-arg under `as any`" — fix is import-only; (B) "dev relied on stub's identity-cast" — fix expands to `pickSku(p)` + 4-arg `toProduct`, mirroring the canonical `apps-start/vtex/loaders/autocomplete.ts`; (C) "upstream API already returns schema.org-shaped Product[]" — fix is `as Product[]` cast at boundary. Casaevideo had A (`smartShelfForYou.ts`) + B (`intelligenseSearch.ts`) — the recipes in skill § 5 cover both with diffs.
- **Per-symbol fix-hint metadata pays off twice.** Once in the prose `fix:` field (the user reads it from the CLI), once in `meta.fixHints` (machine-readable for future tooling: CI dashboards, follow-up auto-fix rules, possibly an `--explain symbol` mode). Discriminated union (`{ kind: "swap", canonical, note }` vs `{ kind: "refactor", note }`) is the right shape — encodes the actionability category without a free-form "type" string.
- **The canonical `toProduct` is meaningfully more capable than the stub.** It handles sponsored items via `topsortPlacement`, group additional properties via `legacyToProductGroupAdditionalProperties` / `toProductGroupAdditionalProperties`, image-by-key reuse, kit items (`kitItems`), per-spec additional properties, offer aggregation. Casaevideo's `smartShelfForYou` was silently dropping all of this since migration. Real production fix masquerading as a single-line PR.
- **The audit's hint table now scales by data, not code.** Adding a 5th, 6th, Nth stub symbol means appending an entry to `STUB_FIX_HINTS` — zero rule-logic changes, free test coverage from the existing rule tests, free doc surface from the canonical replacement table. The table is the API.

### Wave 10 (post-#119 merge — vtex-shim rule refinement + apps-start branch cleanup)

33. [`deco-start#120`](https://github.com/decocms/deco-start/pull/120) — `feat(migrate): per-symbol stub classifier for vtex-shim-regression rule` ✅ **MERGED**.
    Closes the precision gap noted in Wave 8: the audit's `vtex-shim-regression` rule used to flag any import from a `~/lib/vtex-*` file, conflating functional helpers (cookie parsers, fetch wrappers, filter predicates) with the actual silent stubs shipped alongside them. New `scripts/migrate/post-cleanup/shim-classify.ts` walks each shim's top-level declarations and labels each export as `stub` (returns null/`{}`/`[]`/identity-cast/throw), `type-only` (interface/type), or `functional` (the safe default). Rule now flags only when at least one imported symbol classifies as `stub` and names the exact stub symbols. Defensive default: unknown symbols → `stub` so the audit never misses an import; the compile phase covers the underlying TS error separately. **Casaevideo-storefront validation: 6 → 4 findings, 0 false positives, every remaining finding names the exact symbol to repoint** (was eliminating noise like "vtex-fetch, vtex-segment, vtex-client" → now "vtex-segment (getSegmentFromBag)"). The 2 false positives (`cancel.ts` + `updateProfile.ts` using only the functional `parseCookie`) correctly disappear. 34 classifier tests + 8 rule tests + skill doc update. 243 tests pass total. +798/-8.
    
    `--fix` intentionally NOT added in this PR — repointing requires a per-symbol → canonical-export map. Of the 3 confirmed casaevideo stubs, only `toProduct` has a clean 1:1 replacement (`@decocms/apps/vtex/utils/transform.toProduct`). `getSegmentFromBag` and `getISCookiesFromBag` map to `buildSegmentFromCookies(request.headers.get('cookie'))` etc. — that's an architecture change at each call site, not an import rewrite. Detect-only is still strictly better than before; manual cleanup PRs are now trivially scopable.

### apps-start vibe-dex branch cleanup (no PRs — direct branch deletions)

All **5 vibe-dex orphan branches** investigated and confirmed obsolete (their work was applied via different code paths during the modernization waves):

| Branch | Status | Verification |
|---|---|---|
| `vibe-dex/cart-staletime-30s` | obsolete | `staleTime: 30_000` already on `main` |
| `vibe-dex/vtex-cookie-cache-fix` | obsolete | all 3 commits "patch contents already upstream" on rebase |
| `vibe-dex/slim-product-data` | obsolete | `toProductVariant` + `leanVariants` already on `main` (vtex/utils/transform.ts) |
| `vibe-dex/product-shelf-lean` | obsolete | `toProductShelf` + `vtex/inline-loaders/productListShelf.ts` already on `main` |
| `vibe-dex/athens` | obsolete | CI workflows + biome.json + knip.json + vitest.config.ts + 20 test files already on `main` |

All five branches deleted from origin. apps-start is now branch-clean.

### Wave 10 — discoveries

- **The migration script's `lib-utils.ts` template is the source of all stubs.** The 3 confirmed silent-stub patterns on casaevideo (`getSegmentFromBag` returns null, `getISCookiesFromBag` returns `{}`, `toProduct` is identity-cast) all originate from `scripts/migrate/templates/lib-utils.ts`. Each stub is intentional — the migration script writes them because the canonical apps-start replacements have a different *call shape* (request-headers-based, not bag-based), which the script can't safely auto-rewrite at every call site.
- **Strategic improvement candidate (deferred):** Add explanatory `// MIGRATION TODO:` headers to each stub template explaining the canonical replacement and a refactor example. Discoverable at the point of edit (no need to consult the audit), zero runtime cost. Skipping for now — the audit's per-symbol message + skill doc § 5 already give the same info; adding it inside the generated files trades file-size for redundancy. Reconsider if a third migrated site shows users tripping over this.
- **Per-symbol fix-hint table (deferred):** Could replace the rule's generic `fix:` field with per-symbol guidance ("toProduct → @decocms/apps/vtex/utils/transform.toProduct (1:1 swap)" vs "getSegmentFromBag → buildSegmentFromCookies(cookieHeader), see migration guide"). Stack on #120 — implementable as 50-line follow-up. Defer to next wave to keep #120 reviewable as one coherent change.
- **Branch cleanup is real signal-to-noise gain.** Five "abandoned exploration" branches in `git branch -r` are five times someone has to ask "is this still relevant?". The "rebase against main + see if commits are skipped as already-applied" recipe is fast (under a minute per branch) and produces unambiguous answers.
- **The "feature on a side branch later applied differently" pattern is common in fast-moving repos.** All 5 vibe-dex branches' work made it to main, just not via the side branches themselves. Cleanup deletes the noise, history preserves the journey.

### Wave 9 (post-Wave-8-merge — apply audit findings to casaevideo + skill consolidation) — 3 PRs

30. [`casaevideo-storefront#210`](https://github.com/deco-sites/casaevideo-tanstack/pull/210) — `chore(cleanup): remove dead src/lib/fetch-utils.ts shim` 🟡 **OPEN**.
    First production-site application of the audit's `dead-lib-shims` rule. The file exposes 1 export but has zero external imports anywhere in the repo — pure no-op deletion. Applied via `npx -p @decocms/start deco-post-cleanup --fix` on a temp branch, then split into a single-file PR by cherry-pick. Trivial, low-risk (1 file, 3 deletions). Pre-existing typecheck errors in `src/server/*.gen.ts` are present on `main` already — unrelated.

31. [`casaevideo-storefront#211`](https://github.com/deco-sites/casaevideo-tanstack/pull/211) — `refactor(widgets): use @decocms/start/types/widgets instead of local shadow` 🟡 **OPEN**.
    First production-site application of the audit's `local-widgets-types` rule. **55 imports** rewritten from `~/types/widgets` → `@decocms/start/types/widgets`, local 8-line shadow file deleted. Same pattern proven on baggagio#11 — auto-applied via `--fix`, mechanical diff (55 single-line changes + 1 deletion). Companion to #210 but cleanly separable (zero file overlap, different rules).
    
    **Why split into two PRs instead of one combined cleanup**: each rule is independently reviewable; reviewers can quickly read the full 55-file widgets diff without having to also context-switch through the unrelated fetch-utils deletion. Also matches what the audit naturally produces — each finding is its own scope.

32. [`deco-start#119`](https://github.com/decocms/deco-start/pull/119) — `chore(skills): consolidate deco-to-tanstack-migration to .agents/ canonical tree` 🟡 **OPEN**.
    Closes the D-list skill duplication item. The migration playbook lived in both `.cursor/skills/deco-to-tanstack-migration/` and `.agents/skills/deco-to-tanstack-migration/` since the big SKILL.md consolidation; both copies were surfaced as Cursor skills, with `.cursor/` being a stale 33 KB monolith and `.agents/` the live 16 KB consolidated entrypoint with 24 references vs 10. Trees had diverged: `.cursor/` had 1 unique file (`server-functions/README.md`) and `.agents/` had 14 newer reference docs. Preserved the unique file (git tracks as rename), deleted the rest of `.cursor/skills/deco-to-tanstack-migration/`, and updated `CLAUDE.md` to point at the canonical `.agents/` path. **No functional change** — Cursor already indexes the `.agents/` skills root. Eliminates the silent-drift risk going forward.

### Wave 9 — discoveries

- **Audit `--fix` continues to ship value with each new site.** Casaevideo-storefront's 2 safe findings auto-applied with the same byte-identical correctness as baggagio#11. The "run `--fix`, split into 2 commits, branch each from main, cherry-pick" recipe is now routine and worth documenting as a procedure in the post-cleanup skill.
- **Splitting auto-fix output into per-rule PRs is the right default for production sites.** Combined PRs save GitHub overhead but cost reviewer attention; small, single-rule PRs land faster and are safer to revert. Cost: 5 minutes of branch shuffling per site.
- **`.cursor/.../.agents/` skill duplication was actively causing drift, not just confusion.** When making the `--fix` docs update in Wave 7, only `.agents/` got the new content; `.cursor/` would have silently fallen behind. Consolidation prevents that, but the right long-term move is to never duplicate skill trees in the first place — pick one root per repo from day one.
- **Pre-existing typecheck failures on production sites are a separate problem.** Casaevideo-storefront's `src/server/*.gen.ts` has open errors on `main` predating any of this work. Not in scope for the migration-tooling effort, but worth flagging to the production-site team — those errors block clean CI gates for any future PR.

### Wave 8 (post-Wave-7-merge, audit integration + lost-PR re-apply) — 2 PRs

28. [`baggagio-tanstack#11`](https://github.com/deco-sites/baggagio-tanstack/pull/11) — `chore(types): swap local widgets.ts for @decocms/start/types/widgets (re-apply)` 🟡 **OPEN**.
    Re-applies the cleanup originally shipped as PR #10 — which **never reached main**. PR #10 was stacked on PR #9 (`chore/bump-and-cart-shim`) with `base = chore/bump-and-cart-shim`. When #9 was merged into main first, GitHub did NOT auto-rebase #10's base. Merging #10 then sent it into the now-deleted base branch. Confirmed on current main: `widgets.ts` still present, 44 imports still pointing at `~/types/widgets`. This PR is the **first end-to-end use of `--fix` on a real site post-2.12.0 release** — running `npx -p @decocms/start deco-post-cleanup --source <site> --fix` produced the exact 45-files / +45/-53 diff. **Lesson:** stacked PRs need explicit base re-pointing in the GitHub UI when the parent merges first.

29. [`deco-start#118`](https://github.com/decocms/deco-start/pull/118) — `feat(migrate): integrate post-cleanup audit as Phase 9 of deco-migrate` 🟡 **OPEN**.
    Closes the audit-as-migration-finale loop: `deco-post-cleanup` runs automatically at the tail of `deco-migrate`, surfacing residual debt before the user even thinks to ask. Read-only by design (auto-fix stays opt-in via the standalone CLI's `--fix`). New `--no-cleanup-audit` opt-out. Output capped at 5 findings per rule with `…and N more` suffix to avoid drowning the migration's own report. Always tells users about `--fix` when findings exist. `--strict` promotes warnings to fatal (exit 2), aligned with the compile phase. 6 new tests (202 total). Smoke-tested inline against baggagio.

### Wave 8 — discoveries

- **GitHub stacked-PR pitfall is real and common.** Without the GitHub stacked-PR UI (or an explicit re-base), merging the parent first leaves the child orphaned. Mitigation for next time: when stacking, document the merge order in the child PR description AND verify the base is `main` before clicking merge.
- **Audit accuracy on existing sites is uneven.** Inspecting casaevideo-storefront's `~/lib/vtex-*` shim files revealed the rule's "runtime is silently stubbed" message is overconfident. Some shim functions (`fetchSafe`, `parseCookie`, `STALE` constant) are functional locally-implemented utilities; others (`getSegmentFromBag` returns `null`, `getISCookiesFromBag` returns `{}`, `toProduct` is identity cast) ARE silent stubs. The current rule's blanket detection mixes both classes. **Refinement candidate:** parse the shim's exports and classify each as stub-vs-functional (returns null/empty/identity vs has meaningful body). False-positive reduction. Defer until validated against real production findings.
- **Building `vtex-shim-regression` auto-fix is premature.** Without the rule precision above, `--fix` would rewrite functional code (e.g. point `fetchSafe` from a working local impl to apps-start's different impl) — a regression dressed as cleanup. The right order is: refine rule → validate against casaevideo-storefront → only then add `--fix`.

### Wave 7 (post-Wave-6, validation chain + audit follow-ups + C1 detect) — 6 PRs + 1 release

22. [`baggagio-tanstack#9`](https://github.com/deco-sites/baggagio-tanstack/pull/9) — `chore(deps): bump @decocms/{start,apps} + adopt createUseCart factory shim` 🟡 **OPEN**.
    End-to-end validation of the createUseCart chain (#32 → #114). Bumps `@decocms/start` `^2.5.0` → `^2.10.0` and `@decocms/apps` `^1.6.0` → `^1.7.0`. Replaces baggagio's local 248-line `useCart.ts` with the 5-line factory shim. **2 files, 7 insertions(+), 247 deletions(-)**. Behaviour preserved (same public surface — `useCart`, `resetCart`, `itemToAnalyticsItem`, all signal returns). Typecheck + production build clean.

23. **`@decocms/start@2.11.0`** — Post-Migration Cleanup Audit (`deco-post-cleanup` CLI).

    ⚠️ **Process exception, not a regular PR.** Due to a `git stash` recovery slip-up after a previous session left a 89-file lint-fix stash on the queue, the audit work was committed and pushed directly to `main` instead of going through a PR. CI fired the release workflow before it could be cancelled, so `2.11.0` shipped to npm. User reviewed and chose option **A: leave as-is**, with the standing rule reaffirmed: **never push directly to `main` again, always verify branch state pre-commit.** Recovery options offered (revert PR / force-push + npm unpublish / leave) explicitly enumerated; A chosen.

    Code merit: a read-only audit script (`scripts/migrate-post-cleanup.ts` + 4 module files, 20 new vitest tests) that turns the human checklist in `references/post-migration-cleanup.md` into a programmatic scan. Seven rules (`dead-lib-shims`, `obsolete-vite-plugins`, `dead-runtime-shim`, `site-local-with-globals`, `vtex-shim-regression`, `local-widgets-types`, `framework-todos`). Validated against three sites:
    | Site | Findings | Notable |
    |---|---|---|
    | baggagio-tanstack | 1 info | `src/types/widgets.ts` shadows framework (44 imports) |
    | casaevideo-storefront (production) | **11 (8 warnings)** | **6 silent VTEX shim regressions** in production loaders |
    | empty tree | 0 | no false positives |
    
    The 6 vtex-shim-regression findings on casaevideo-storefront are the silent-runtime-stub bug pattern documented in the SKILL — segment cookies, IS cookies, vtex-id parsing all stubbed to `{}`/`null` at runtime. Audit catches them in 1 second.
    
    Exposed as `deco-post-cleanup` bin entry. Three modes: pretty text (default), `--json` (CI), `--strict` (exit 2 on warnings).

24. [`baggagio-tanstack#10`](https://github.com/deco-sites/baggagio-tanstack/pull/10) — `chore(types): swap local widgets.ts for @decocms/start/types/widgets` 🟡 **OPEN, stacked on #9**.
    First audit-finding-driven cleanup PR. Replicates the manual fix for the `local-widgets-types` rule on baggagio (44 imports rewritten, local file deleted). Validates that the audit's report is precise enough for direct mechanical action. Will rebase trivially onto main once #9 lands. **45 files changed, 45+/-53.**

25. [`deco-start#115`](https://github.com/decocms/deco-start/pull/115) — `feat(migrate): add --fix mode to deco-post-cleanup for the 3 safe rules` 🟡 **OPEN**.
    Auto-fix mode for the audit. Implements `applyFix` for `dead-lib-shims`, `dead-runtime-shim`, and `local-widgets-types` — the three rules where the fix is mechanical (rule 1 deletes; rules 3 and 6 rewrite imports + delete). Other rules stay detect-only with explicit `(0 fixed, manual)` labelling in output. Architecture: new optional `applyFix` on the `Rule` interface, separate `FsWriter` from `FsAdapter` (read-only audits structurally cannot mutate), shared `rewriteImportSpec` helper that correctly skips prefix collisions like `~/types/widgets-extra`. **End-to-end validation: smoked `--fix` against a temp clone of baggagio's pre-fix state and confirmed BYTE-IDENTICAL diff to the manual baggagio#10 PR** (45 files, +45/-53 each). 7 new tests (27 total, all pass). +382/-22.

26. [`deco-start#116`](https://github.com/decocms/deco-start/pull/116) — `docs(skills): document deco-post-cleanup audit + --fix mode + sync .cursor copy` 🟡 **OPEN**.
    Docs-only follow-up to #115 + a partial D-list cleanup. Updates `.agents/.../post-migration-cleanup.md` to document `--fix` and `--fix --strict`, syncs `.cursor/` copy from `.agents/` (only diff was the audit section), adds a "Post-Migration Audit" section to `deco-migrate-script/SKILL.md` linking the audit + explaining the complementary relationship to `phase-compile` (compile catches what `tsc` can find; audit catches the silent-runtime-stub class of bug — the canonical example is the casaevideo-storefront vtex-shim regression). +99/-10.

27. [`deco-start#117`](https://github.com/decocms/deco-start/pull/117) — `feat(migrate): detect non-classic source layouts and abort with actionable error` 🟡 **OPEN**.
    Closes the first half of plan item **C1**. Adds `scripts/migrate/source-layout.ts` — a pure classifier that returns `classic | modern | mixed | empty` based on which dirs (`sections`, `islands`, `components`, `loaders`, `actions`) exist at root vs under `src/`. Wired as Phase 0 in `migrate.ts` to abort before `analyze()` runs if layout isn't classic, with a focused message explaining the mismatch and the workaround (move `src/*` up to root, re-run). **Zero risk to existing migrations**: casaevideo + baggagio both classify as "classic". Defers native src/ scanning until a real modern-layout site shows up — building against a hypothetical risks fitting the wrong shape. 13 new tests (189 total, all pass). +238/-7.

### Wave 7 — discoveries

- **Process bug: stale stashes are landmines.** Multiple `WIP on <branch>` entries in `git stash list` from previous sessions can pollute working trees if branch-switching is involved. Root cause of the direct-push-to-main mistake. Mitigation going forward: **always run `git status` + `git branch --show-current` immediately before `git commit` and again before `git push`**. Specifically check for unrelated tracked-file modifications that suggest a prior stash was merged in.
- **The audit's findings on production casaevideo-storefront are real, latent runtime bugs.** Segment cookies, intelligent-search auth, vtex-id parsing — all silently stubbed. None of those would show up in `tsc --noEmit` because the dead `~/lib/vtex-*` shims have valid TypeScript signatures; they just resolve to `{}` at runtime. **Compile-phase verification (#112) doesn't catch this class of bug — only the audit does.** Strong argument for both layers: `tsc` for syntax correctness, `deco-post-cleanup` for runtime hygiene.
- **The audit landed value the moment it ran.** Before it existed, finding any of the casaevideo regressions required reading the SKILL doc end-to-end + manually grepping. Now the same finding takes 1 second. Tooling that automates checklists with real false-positive discipline pays for itself quickly.
- **`createUseCart` end-to-end chain proven.** apps-start#32 (factory) → release `1.7.0` → deco-start#114 (template) → release `2.9.0` → baggagio#9 (consumer adopts) — full bookend, real LOC win, zero behaviour change. Validates the framework-PR → release → consumer-PR pattern for the 6th time this session.
- **Audit infrastructure unlocks audit-driven PRs.** baggagio#10 demonstrates the new pattern: run `deco-post-cleanup`, get a precise finding (rule + file + count + suggested fix), open a PR that just executes the fix. Validation step at the end is `re-run audit → 0 findings`. Same loop applies to any future site.
- **`--fix` mode produces byte-identical results to manual fixes.** deco-start#115 was validated by running `--fix` on a temp clone of baggagio pre-fix and `diff`ing against the manual PR. Exit 0. The strongest possible end-to-end confidence signal: the script reproduces a PR a human reviewer can already inspect line-for-line.
- **The detection / fix split is the right architecture.** Three rules can be safely auto-fixed (mechanical: delete or rewrite-imports). Four rules stay detect-only because the right action requires human judgment (which apps export to point at, whether an inline plugin's surrounding code can be safely removed, whether a TODO is shipped/deferred/obsolete). The CLI shows this distinction explicitly, so users always know what's left after `--fix`.

### Session 2026-05-01 — running tally (updated)

**33 PRs touched/created across 4 repos, 1 process exception (direct push), 5 vibe-dex orphans cleaned. 28 merged (#9–#119 batch), 3 in flight (#120 + #210 + #211), 1 closed.**

Repos:
- `decocms/deco-start`: 18 PRs (#102 ✓, #103 ✓, #104 ✓, #105 ✓, #106 ✓, #107 ✓, #108 ✓, #109 ✓, #110 ✓, #111 ✓, #112 ✓, #113 ✓, #114 ✓, #115 ✓, #116 ✓, #117 ✓, #118 ✓, #119 ✓, plus closures of #34, #68; plus 2.11.0 shipped via direct-push exception; plus **#120 🟡 vtex-shim per-symbol classifier**)
- `decocms/apps-start`: 3 PRs (#30 ✓, #31 ✓, #32 ✓) + **5 vibe-dex orphan branches deleted** (athens, vtex-cookie-cache-fix, slim-product-data, product-shelf-lean, cart-staletime-30s)
- `deco-sites/baggagio-tanstack`: 6 PRs (#5 ✓, #6 ✓, #7 ✓, #8 ✓, #9 ✓, #10 lost-merge → #11 ✓)
- `deco-sites/casaevideo-storefront`: **2 PRs (#210 🟡 fetch-utils, #211 🟡 widgets)**

Key durable artifacts beyond the PRs:
- Plan tracker (this file) — running narrative + decisions
- `references/post-migration-cleanup.md` — cleanup checklist as a skill artifact, **now backed by an executable audit (`deco-post-cleanup`)**
- "framework PR → release → consumer PR" pattern, validated 6+ times this session
- `createUseCart` factory pattern + per-site `.deco-migrate.config.json` proven on real sites
- Compile phase + post-cleanup audit complement each other: tsc catches syntax regressions, audit catches runtime stubs

What's still ahead:
- **Per-symbol fix-hint table for `vtex-shim-regression`** (stack on #120): replace generic `fix:` field with per-symbol guidance — "toProduct → 1:1 import swap to `@decocms/apps/vtex/utils/transform`" vs "getSegmentFromBag → call-site refactor required, see skill doc § 5". ~50 LOC, doc reference table. **Best next PR after #120 merges.**
- **Casaevideo-storefront leftover audit findings (post-#210/#211)**: with #120's precision, the breakdown is **4 vtex-shim findings** (smartShelfForYou/intelligenseSearch use `toProduct`, also intelligenseSearch + buyTogether + productReviews use `getSegmentFromBag`) + 2 obsolete-vite-plugins + 1 framework-todo. The `toProduct` cases are 1:1 fixable; `getSegmentFromBag` cases need call-site refactors. Concrete cleanup work, scopable per finding.
- **Migration script: emit `// MIGRATION TODO:` comments on stub templates**: `lib-utils.ts` could include explanatory headers pointing at canonical replacements at the point of edit. Defer until we see users tripping on this — current audit + skill doc cover the same info.
- **`createUseUser`/`createUseWishlist` factories**: defer until a third site needs them or canonical TanStack-Query hooks are deemed the migration target.
- **C1 (phase-analyze + `src/` layouts) — native scanning**: detect-and-abort shipped (#117). Native scanning still deferred until a real modern-layout site appears.
- **C8 (state persistence between migration phases)**: moderate effort, value mostly in skipping `npm install` on phase-9 retries. Polish.
- **`vibe-dex/*` orphan branches in apps-start**: ✅ all 5 cleaned this wave.
- **Apps registry (apps-start#18 + deco-start#81)**: defer until clear consumer.
