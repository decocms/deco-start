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

### 2026-05-01 — Wave 15-A double-check exposed a self-perpetuating template→audit loop

- **Q1 (sites→packages promotion completeness):** Two subagents
  swept `casaevideo-storefront` + `baggagio-tanstack`. The big
  A-list icebergs are caught — but **5 cross-site duplications
  satisfying D4** slipped through (`useSuggestions`, `useOffer`
  forks, `useVariantPossibilities` forks, site-local copies of
  framework `clx` / `useSendEvent`, three competing `Picture`
  APIs). Plus 4 migration debts where the framework already has
  the answer (`useCart` factory not adopted in casaevideo,
  `runtime.ts` inline proxy still scaffolded, location matcher
  duplication, inline cookie helpers).
- **Q2 (script/skill coverage of what we shipped):** Worse. The
  migration script's templates were **scaffolding code that the
  audit's `--fix` then removed** — the textbook
  self-perpetuating loop. `templates/vite-config.ts` was emitting
  `site-manual-chunks` + `deco-stub-meta-gen` (both already
  inside `decoVitePlugin()`). `templates/server-entry.ts` was
  emitting a 47-line `createNestedInvokeProxy` body (already in
  `@decocms/start/sdk`). The factories shipped in W12 (`createUseUser`
  / `createUseWishlist`) had **zero skill mentions** — the
  pre-W12 manual approach was still the canonical doc. Cookie
  passthrough helpers in `cookiePassthrough.ts` were **half-shipped**:
  the deco-start side compiled, the apps-start providers it
  references in its own docstring don't exist, and the migration
  script never wired either.
- **Decided: ship Wave 15-A as a single PR.** Drop the obsolete
  emissions (G1/G2/G4/G5), expand `dead-runtime-shim` to catch
  both the legacy inline shape (with `Runtime` export) and the
  Wave-15-A canonical re-export shape (skip — desired form),
  publish a `platform-hooks-factories.md` skill that supersedes
  the stale README, and update plan + journal.
- **Defer to Wave 15-B / 16:** (G3) promotion of the
  `invoke.gen.ts` 170-LOC server-fn block to apps-start needs
  research on TanStack Start's compiler scanning behaviour
  (whether `createServerFn` can be transformed when it lives in
  a node_module). (H1) full cookie-passthrough provider wiring
  (`setRequestCookieProvider` / `setResponseCookieForwarder` in
  apps-start, auto-wire in `setup.ts`) needs design. The 5
  cross-site convergence promotions (`useSuggestions`,
  `useOffer` factory, `Picture` unification, `clx`/`useSendEvent`
  redirects, `relative()` extension) are now in the priority-2
  backlog, sequenced after Wave 15-A merges.
- **The double-check itself is a useful primitive.** "Did we
  ship script/skill/audit coverage for everything we built?" run
  against the framework + apps inventory consistently surfaces
  these loops. Codify it: when promoting a new factory or
  helper, the PR checklist must include "matching template
  emit", "matching audit-rule expansion", "matching skill doc
  entry". This is the kind of self-check that prevents the next
  16-month-old stale skill.

### 2026-05-01 — Wave 14-A rescoped from three codemods to one based on real als data

- **Pre-data plan vs post-data plan.** The plan called for three
  htmx codemods (`event-handler`, `form-swap`, `click-swap`).
  After running `deco-htmx-analyze` against als-storefront's
  actual code (210 occurrences across 133 files), only the
  `event-handler` bucket (88 occurrences, 42 %) genuinely admits
  a mechanical rewrite — the other buckets need per-call-site
  product decisions a codemod cannot encode. **Decided: ship
  one codemod (W14-A: `htmx-on-event-rename`), defer the other
  two to W15+.** Rationale captured in the Wave 14 — discoveries
  block.
- **Codemod shape generalises:** rename + preserve body +
  conditional file-level TODO. Three outputs, one mechanical,
  one verbatim, one conditional on body-content heuristics. This
  is the shape any future per-pattern codemod should target.
- **Smoke against the real source tree validated the design in
  five minutes.** 754 files scanned, 71 changed, 98 renames, 67
  TODO injections (94 % of changed files). Without that smoke
  step we'd have shipped blind on edge cases like multi-line
  values, mixed standard + lifecycle hooks on the same element,
  and the colon-vs-dash variants both showing up in the same
  file.
- **The codemod + audit pair closes another loop.** Same shape
  as W12 (D3 throwing stubs + audit `--fix` for swap-able
  stubs). The codemod removes the mechanical half of the htmx
  surface; the `htmx-residue` audit catches the surviving half
  in CI. Engineers can never silently ship a half-rewritten
  file.

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

### Wave 12 (kicked off 2026-05-01 after D1–D5 sign-off) — Priority 1 (framework + commerce) — ✅ **COMPLETE**

After surfacing als-storefront as the third migration target (heavy on
htmx, ~120 hx-* files, prior als-tanstack attempt thrown away), the
"wait for 3rd site" deferrals collapse. Wave 12 shipped the abstractions
that als + casaevideo + baggagio had already justified, plus the
audit `--fix` work D3 forces us into. **9 PRs across `deco-start` and
`apps-start`, all merged.**

**Shipped PRs:**

- **W12-A + W12-B** [`apps-start#33`](https://github.com/decocms/apps-start/pull/33) — `feat(vtex/hooks): add createUseUser + createUseWishlist factories` ✅ **MERGED**.
  Mirrors the `createUseCart` shape: invoke-driven legacy state machine, signal-shaped public API (`.value`), independent instances per call. `createUseWishlist` also exposes the `legacyAddArgsToCanonical` and `findWishlistEntry` helpers so site code can keep its old `productId`/`productGroupId` swap convention while routing through the canonical `vtex.actions.{addToWishlist, removeFromWishlist}` signature. New unit tests assert factory shape, instance independence, the arg-swap convention, and the entry-finder helper.
- **(Lint unblock)** [`apps-start#34`](https://github.com/decocms/apps-start/pull/34) — `chore(lint): tighten shopify storefront.graphql.gen.ts types + biome formatting` ✅ **MERGED**.
  Cleared pre-existing `noExplicitAny` failures in `shopify/utils/storefront/storefront.graphql.gen.ts` plus formatting drift in `vtex/__tests__/client-segment-cookie.test.ts` so subsequent Wave 12 PRs in `apps-start` could land on a green CI baseline. Replaced loose `any` types with a structured `ProductFilter` shape (derived from real consumers) and `unknown` elsewhere; ran `biome check --write` to fix import order + formatting.
- **W12-C** [`deco-start#123`](https://github.com/decocms/deco-start/pull/123) — `feat(migrate): D3 — generated stubs throw at runtime` ✅ **MERGED**, released as `@decocms/start@2.16.0`.
  Implements **D3** verbatim. The migration-time stubs in `lib-utils.ts` for `toProduct`, `getISCookiesFromBag`, `getSegmentFromBag`, `withSegmentCookie` no longer return identity-cast values, empty objects, or empty `Headers` — they now `throw new Error(STUB_MSG)` with a per-symbol message that names the canonical replacement, the canonical signature, and the `deco-post-cleanup --fix` invocation. Tests assert the throwing bodies + that other functional helpers (e.g. `parseCookie`, `isFilterParam`) are untouched.
- **W12-D + W12-E** [`deco-start#124`](https://github.com/decocms/deco-start/pull/124) — `feat(audit): vtex-shim-regression --fix for swap-able symbols` ✅ **MERGED**, released as `@decocms/start@2.17.0`.
  Auto-fixes the swap subset of the regression rule: when every imported symbol from a `~/lib/vtex-*` shim has a `kind: "swap"` hint pointing to the same canonical module, the rule rewrites the `from "..."` clause to canonical and leaves the named-import list (including `as`-aliases) verbatim. Mixed swap + refactor surfaces, and shims that mix stubs with real impls (e.g. `isFilterParam`), are deliberately left for manual fix. 6 new tests + skill doc § 5 update.
- **W12-i** [`deco-start#125`](https://github.com/decocms/deco-start/pull/125) — `feat(migrate): scaffold useUser + useWishlist as factory shims (vtex)` ✅ **MERGED**.
  Updates the migration script's `hooks.ts` template so freshly migrated VTEX sites get 3-line factory shims (`export const { useUser, resetUser } = createUseUser({ invoke })`) instead of 200-LOC singletons that were copy-pasted by the old migration. Non-VTEX sites still get the legacy stubs but with docstrings pointing at the factories for parity context. 4 new tests cover both branches and a line-count budget.
- **W12-F** [`deco-start#127`](https://github.com/decocms/deco-start/pull/127) — `feat(audit): obsolete-vite-plugins --fix` ✅ **MERGED**.
  JS-aware applyFix for the rule. Walks `vite.config.ts` with a brace-counter that skips strings, template literals (including `${...}` interpolation), and line/block comments, so nested `{}` inside `config()` / `load()` / `resolveId()` bodies do not throw off boundary detection. Removes the inline literal + trailing `,\n` + the contiguous block of `// ...` comments immediately attached above. Idempotent. 7 new tests + smoke verified against real casaevideo `vite.config.ts` (162 LOC → both plugins gone, 2503 bytes / ~74 LOC removed, structurally identical to baggagio's already-clean shape, post-fix audit returns 0 findings).
- **W12-G** [`apps-start#35`](https://github.com/decocms/apps-start/pull/35) — `docs: add AGENTS.md cross-linking the canonical migration policy` ✅ **MERGED**.
  Adds an AGENTS.md to `apps-start` so any agent or contributor opening that repo knows the canonical migration policy lives in `decocms/deco-start` and what D1–D5 mean specifically inside `apps-start` (especially D4: site-local apps live in the *site*, not in `apps-start`). Architecture overview + cross-link table.
- **W12-H** [`deco-start#126`](https://github.com/decocms/deco-start/pull/126) — `feat(migrate): scaffold migration-tooling-policy pointer rule` ✅ **MERGED**, released as `@decocms/start@2.18.0`.
  Migration scaffold phase now writes `.cursor/rules/migration-tooling-policy.mdc` into every newly migrated site. The pointer is `alwaysApply: true`, links to the canonical rule and plan in `decocms/deco-start`, includes a one-line-per-decision D1–D5 table scoped to the site, and points at the `deco-post-cleanup --fix` / `--strict` commands. Length budget under 3 KB so it stays a pointer, not a copy. 8 new tests.

Wave 12 ships in priority-1 order; Wave 13 starts now.

### Wave 12 — discoveries

- **D3 + audit `--fix` is a closed loop, not an either/or.** The
  symmetry that `--fix` for swap-able stubs (W12-D/E) combined with
  throwing stubs (W12-C) produces is significant: the moment a
  migrated site runs anything that hits a stub'd symbol, it throws
  with an actionable error pointing at the canonical replacement; the
  same moment, `--fix` knows what `from "..."` clause to rewrite. The
  user no longer has a "silent regression" failure mode.
- **Per-symbol fix-hint table now has 5 consumers.** It's read by:
  the rule's prose `fix:` field, the rule's `meta.fixHints`
  structured payload, the runtime stub error message, the `--fix`
  rewriter (selects swap candidates), and the skill doc table. Adding
  a 5th, 6th, Nth stub means appending one entry to `STUB_FIX_HINTS`
  — every consumer picks up the new symbol for free.
- **Site-level policy enforcement at scaffold time, not runtime.**
  W12-H ships the canonical D1–D5 policy *as a pointer* into every
  new site. Cursor sessions in those sites load the rule with
  `alwaysApply: true`, so they know the policy without us having to
  pull a copy of the rule into each repo. Drift-free by construction
  — the canonical rule changes upstream and the pointer keeps
  pointing.
- **Brace-balanced parsing + comment attachment makes
  `obsolete-vite-plugins` `--fix` safe at scale.** The casaevideo
  smoke test confirmed the approach handles real-world vite configs
  with multi-line plugins, attached comments describing the
  workaround, template literals containing `}`, and nested
  `rollupOptions`. Idempotency falls out of "rule found 0 plugins
  → no findings → no fix actions". This is the pattern for any
  future `--fix` that needs to surgically edit a file: extract a
  span helper, write surface-level tests, smoke against a real
  production file, ship.
- **`apps-start` had latent CI debt.** W12 surfaced pre-existing
  `noExplicitAny` failures in `shopify/utils/storefront/storefront.graphql.gen.ts`
  that had been failing on `main` for an unknown duration. The lint
  unblock PR (`apps-start#34`) is the kind of "passing through" fix
  that should land first whenever a CI gate is red. Don't paper
  over it.
- **Factories migrate cleaner than templates.** Comparing
  `apps-start#33` (factories) to `deco-start#125` (template that
  *consumes* the factories), the factory PR is the larger artifact
  but the template PR shipped 4 lines into each generated file.
  Investing once in a well-shaped factory pays a 50:1 multiplier on
  every site that runs the migration after that point. This is the
  D4 promotion path working end-to-end: build it once at site level,
  prove it on 2 sites, promote to `@decocms/apps`, then rewrite the
  template to use the canonical.

### Wave 13 (htmx foundations — Priority 2 part 1) — ✅ **COMPLETE**

Once Wave 12 was in, the migration script needed an htmx track
because als is the first heavy htmx site and we know it won't be
the last (per the user, "some of our sites are, not all, not even
most, some"). **3 PRs in `deco-start`, all merged.** D2 forbids an
htmx adapter package; nothing in Wave 13 ships htmx runtime — only
analysis, rewrite recipes, and a "rewrite-complete" gate.

**Shipped PRs:**

- **W13-A** [`deco-start#129`](https://github.com/decocms/deco-start/pull/129) — `feat(migrate): htmx surface analyzer` ✅ **MERGED**, released as `@decocms/start@2.20.0`.
  Adds `scripts/migrate/analyzers/htmx-analyze.ts` (per-file walker + classifier) and the `deco-htmx-analyze` CLI. The walker is heuristic JSX (regex for `hx-*` attrs, brace-balanced traversal back to the opening tag, forward to the closing `>` / `/>`) — skips strings, template literals, JSX expression slots, and balanced `{...}` blocks. Each occurrence is classified into one of seven categories (`event-handler`, `form-swap`, `click-swap`, `auto-fetch`, `oob-swap`, `boost`, `unmatched`) based on the attribute cluster, not individual attrs (recipes apply to clusters, not attrs in isolation). CLI emits per-category counts, top tags, sample line numbers, and a one-line migration recipe; `--json` for tooling. 24 tests covering classification (all 7 categories + tie-breaks + dash-variant `hx-on`) and real als-shaped fixtures (AddToBagButton, SearchInput, EmailAndPassword, ForgotPassword).
- **W13-B** [`deco-start#130`](https://github.com/decocms/deco-start/pull/130) — `docs(skills): add htmx-rewrite reference` ✅ **MERGED**.
  Per-pattern playbook at `.agents/skills/deco-to-tanstack-migration/references/htmx-rewrite.md`. For each of the seven categories: a "Before" snippet pulled directly from als (so the recipe is grounded in what an engineer is actually staring at), an "After" snippet using the canonical TanStack Start patterns (`useState` + `useCart`, `useNavigate`, `useMutation`, sub-routes), an explicit decision criterion when more than one path is reasonable (e.g. local state machine vs. sub-route for `click-swap`), and a "Gotchas" block enumerating the failure modes humans actually hit (focus loss, double-submit, hydration mismatch, etc.). Cross-linked from `SKILL.md`'s problem table.
- **W13-C** [`deco-start#131`](https://github.com/decocms/deco-start/pull/131) — `feat(audit): htmx-residue rule` ✅ **MERGED**, released as `@decocms/start@2.21.0`.
  Eighth audit rule. Reuses `analyzeFile` from `analyzers/htmx-analyze.ts` to scan `src/**/*.{ts,tsx}` (excluding `*.test.tsx` / `*.spec.ts` / `__tests__/`) and emits one warning per file with a category breakdown (`event-handler=2, form-swap=1`). Severity is `warning` so `--strict` exits 2 — the "rewrite-complete" CI gate. The fix string points at `references/htmx-rewrite.md`. Intentionally **detect-only** — rewrites are non-mechanical (state machine vs. sub-route vs. mutation choices vary per call site), so `--fix` wiring would be misleading; the skill is the playbook. 7 new tests cover aggregation, severity, test-file exclusion, scope (`src/` only), zero-finding gate, line-number reporting, and `supportsAutoFix: false`. Skill doc § 7 added explaining the rule + when to wire it into CI; help text updated.

### Wave 13 — discoveries

- **Heuristic JSX walking is enough; full AST is not needed for
  this surface.** `analyzeFile` goes character-by-character with
  brace-counting and string/template/comment skipping; it correctly
  identifies attribute clusters in 100 % of the als-storefront and
  internal-fixture sample (~120 files, ~270 hx-* attributes), and
  the test corpus pins the tricky cases (dash-variant `hx-on-*`,
  attached comments, balanced JSX expressions inside attributes,
  multiline tags). Pulling in `@swc/core` or `recast` for this
  would be over-engineering — the walker is ~150 LOC, deterministic,
  and shares a single source of truth between the standalone CLI
  (`deco-htmx-analyze`), the post-cleanup audit rule
  (`htmx-residue`), and the per-pattern recipe references.
- **Classify by attribute cluster, not by individual attribute.**
  An `hx-on:click` and `hx-post + hx-target + hx-swap` get
  fundamentally different rewrites. Categorising at the cluster
  level (the JSX tag + all its hx-* attrs) means each finding
  points at exactly one of seven recipes in
  `references/htmx-rewrite.md`. This is the same discipline that
  worked for `STUB_FIX_HINTS` in the vtex-shim rule: the data shape
  encodes the actionability category, the rule is just a thin
  classifier on top.
- **D2 + W13-C form a closed loop, mirroring the W12 D3 + audit
  pattern.** D2 says "no htmx runtime in `@decocms/start`". W13-C's
  `htmx-residue` rule says "fail CI if any `hx-*` survives in
  `src/`". Together: a migrated site cannot accidentally rely on
  htmx because (a) the framework gives them no runtime to import,
  (b) the audit catches every leftover `hx-*` in code review.
- **Detect-only is correct here, not a stop-gap.** Auto-fixing
  htmx is conceptually hard: even a "simple" `<button hx-post>` →
  `useMutation` rewrite has to choose between optimistic vs
  pessimistic UI, error handling shape, where to surface the
  loading state, and whether the response should re-render the
  whole page or a fragment. Each is a per-site product decision.
  The pattern catalog in `references/htmx-rewrite.md` is the
  durable artefact; codemods (Wave 14) can target a specific
  cluster shape (e.g. `hx-post + hx-target=#id + hx-swap=innerHTML`
  with no `hx-trigger`) safely, but they're scoped by category,
  not the rule's auto-fix.
- **The audit registry is now self-shaped for additive growth.**
  Eight rules, three of which (`vtex-shim-regression`,
  `obsolete-vite-plugins`, `htmx-residue`) ship with their own
  analyzer modules. The pattern is set: add a rule to
  `ALL_RULES`, supply `applyFix` only when mechanical, point the
  prose `fix:` field and JSON `meta` at a skill reference. The CLI
  (`migrate-post-cleanup.ts`) is rule-agnostic — adding a ninth
  rule means changing one file, getting `--strict` and `--json`
  for free.

### Wave 14 (htmx codemod — Priority 2 part 2) — ✅ **PARTIAL / RESCOPED**

After shipping the W13 htmx foundations and gathering real data
from als-storefront with `deco-htmx-analyze`, the planned three-codemod
scope was reduced to **one codemod** + **one inventory artefact**.
The other two codemods (form-swap, click-swap) were deferred to W15+,
to be designed *after* als migration data exposes which exact
attribute clusters dominate. **Rationale logged in W14 discoveries.**

**Shipped:**

- **W14-A** [`deco-start#132`](https://github.com/decocms/deco-start/pull/132) — `feat(migrate): htmx-on-event-rename codemod` ✅ **MERGED**, released as `@decocms/start@2.22.0`.
  Adds `scripts/migrate/transforms/htmx-on-events.ts` to the migrate
  `transforms/` pipeline. Mechanically rewrites `hx-on:event=` and
  `hx-on-event=` (colon + dash variants) to the React equivalent
  for every standard DOM event in `STANDARD_EVENT_MAP` (40 entries:
  click, submit, change, input, key*, mouse*, focus*, drag*, touch*,
  paste/copy/cut, scroll, wheel, load, contextmenu). Handler bodies
  are preserved verbatim. **Idempotent** — running twice is a no-op.
  Two safety hatches: htmx lifecycle events (`hx-on:htmx-*`) and
  unknown custom events left alone (the `htmx-residue` audit catches
  them); a single top-of-file MIGRATION TODO comment is injected
  when the body references Fresh-only globals (`useScript(…)`,
  `globalThis.window.STOREFRONT`, `STOREFRONT.…`) so engineers
  don't ship a syntactically-clean file with broken runtime calls.
  29 unit tests + als-shaped fixtures (AddToBagButton, SearchInput,
  RecoveryPassword form, Footer.tsx). 339/339 pass; typecheck clean.
  htmx-rewrite skill § Pattern 1 cross-references the codemod.
- **W14-B** [`deco-start#132`](https://github.com/decocms/deco-start/pull/132) — captured the **als-storefront htmx inventory** in this plan (this section) as a fixture for future W15+ codemod design.

**Deferred (intentionally) — see Wave 14 discoveries:**

- ~~**W14-C** codemod `transforms/htmx-form-post-swap.ts`~~ — moved to W15+. The form-swap rewrite is genuinely non-mechanical (per-call-site decisions about optimistic vs pessimistic UI, where to surface loading state, which response handler shape). A speculative codemod would produce React skeletons that still need ~80 % manual work.
- ~~**W14-D** codemod `transforms/htmx-click-fetch-swap.ts`~~ — moved to W15+. Same logic; on top of that, choosing between local state machine vs sub-route is a routing-architecture decision that varies per page.

#### W14-A smoke + als inventory (captured 2026-05-01)

The W13-A `deco-htmx-analyze` CLI run against als-storefront's
production Fresh tree:

| Category | Count | % | Notes |
|---|---:|---:|---|
| `event-handler` | 88 | 42 % | **Codemoded by W14-A** — mechanical rename |
| `click-swap` | 64 | 30 % | Manual (W15+) — needs state vs sub-route decision |
| `form-swap` | 20 | 10 % | Manual (W15+) — needs `useMutation` shape decision |
| `auto-fetch` | 9 | 4 % | Manual — debounced state + `useQuery` |
| `oob-swap` | 8 | 4 % | Manual — no 1:1 React equivalent |
| `unmatched` | 21 | 10 % | Mostly typed-generic noise (`<string>` from `Map<string,X>`) |
| **Total** | **210** | | across 133 files |

W14-A codemod sweep against the same tree (754 ts/tsx files):

| Metric | Value |
|---|---:|
| Files scanned | 754 |
| Files changed | 71 |
| Total `hx-on:*` attributes renamed | 98 |
| Files getting the MIGRATION TODO | 67 (94 % of changed) |

The 98 vs 88 discrepancy is expected: the analyzer counts attribute
*clusters* per element (an `<input hx-post hx-target hx-on:change>`
classifies as one `auto-fetch`); the codemod counts individual
`hx-on:*` attribute renames (the same element gets one rename
plus the `auto-fetch` cluster left intact for the engineer to
finish). Net effect: ~98 mechanical wins, leaving ~112 cluster
rewrites (click-swap + form-swap + auto-fetch + oob-swap +
unmatched) for the engineer — matching the manual rewrite
recipes in `references/htmx-rewrite.md`.

### Wave 14 — discoveries

- **Speculative codemods are over-engineering; data-driven scope
  is better.** The pre-data plan said three codemods (event-handler,
  form-swap, click-swap). After running `deco-htmx-analyze` against
  als-storefront's actual code, only the event-handler bucket
  (88 occurrences, 42 % of the surface) genuinely admits a
  mechanical rewrite. The other two buckets need per-call-site
  product decisions (state machine vs sub-route, optimistic vs
  pessimistic UI, response-handler shape) that a codemod cannot
  encode without producing React skeletons that still need ~80 %
  manual work — net negative versus the recipe in
  `references/htmx-rewrite.md`. **New rule: codemods come *after*
  the analyzer data, not before.**
- **The smoke-against-real-site step is the design feedback loop.**
  Running the codemod against als's full 754-file tree (98
  renames, 71 files changed, 67 with TODO injection) validated
  three things in five minutes: (a) the rename surface matches
  the inventory (98 vs 88 ratio explained), (b) the TODO
  injection rate is high (94 %) — the marker is essential, not
  defensive, (c) the codemod is idempotent at scale (re-running
  produces zero diffs). Without this step we'd ship blind.
- **The three-output codemod shape (rename + preserve body +
  conditional TODO) generalises.** Same shape any future
  per-pattern codemod should target: do the mechanical part,
  preserve the human-decision-required part, leave a single
  file-level marker the engineer can grep for. Over-eager
  body rewriting is what produces the ~80 % manual cleanup load
  that justifies leaving form-swap / click-swap codemods out for
  now.
- **`htmx-residue` audit + W14-A codemod close another loop.**
  Same pattern as W12 (D3 throwing stubs + audit `--fix` for
  swap-able stubs). The codemod removes the easy half of the
  htmx surface; the audit catches the surviving half. Engineers
  can never accidentally ship a half-rewritten file: the
  attribute is either gone (codemod ran, body might still need
  work — TODO), or it's still there (audit fires in CI).
- **als-storefront's profile probably generalises to other htmx
  sites.** 42 % event-handler is a strong skew toward
  trivially-mechanical rewrites; even if other sites differ,
  this codemod alone removes the largest single bucket. If a
  future site shows 80 % click-swap, *that* would be the cue to
  build the click-swap codemod — not pre-emptively now.
- **Pipeline order matters.** Codemod runs after `transformJsx`
  (which renames `class` → `className` and `onInput` → `onChange`)
  and before `transformFreshApis` (which removes `useScript`
  imports). If `transformFreshApis` ran first, the codemod's
  TODO marker would still fire (we look for `useScript(` calls,
  not the import), but the import-removal would create dead
  references. Order is correct.

### Wave 15-A (close template→audit loops + factories skill — Priority 2 follow-on) — 🟡 **IN FLIGHT**

Triggered by the double-check audit on 2026-05-01: subagent sweeps over
casaevideo-storefront + baggagio-tanstack revealed (a) the migration
template was scaffolding code that the audit's `--fix` then removed,
and (b) the W12 factory hooks (`createUseUser`, `createUseWishlist`)
had no skill coverage. Wave 15-A closes both loops in one PR.

**Shipped (one PR against `decocms/deco-start`):**

37. `feat(migrate): close template→audit loops for vite plugins, runtime, cookies, branding + factories skill` 🟡 **WAITING ON CI**.
    - **`templates/vite-config.ts`** — drop `site-manual-chunks` and
      `deco-stub-meta-gen` plugin emissions. Both already live in
      `decoVitePlugin()` (`src/vite/plugin.js`). The audit's
      `obsolete-vite-plugins --fix` was undoing the template's own
      output; now the template emits clean, the audit catches
      regressions in legacy sites.
    - **`templates/server-entry.ts` `generateRuntime()`** — replace
      the 47-line inline `createNestedInvokeProxy` body with a 6-line
      re-export from `@decocms/start/sdk`. Sites keep
      `import { invoke } from "~/runtime"` and `Runtime.invoke`
      shapes. A2 of the original investigation finally lands at the
      template layer (was previously only patched post-migration by
      the audit).
    - **`templates/server-entry.ts` `generateInvoke()` (VTEX path)**
      — replace inline `mergeSetCookies` helper with
      `forwardResponseCookies` from
      `@decocms/start/sdk/cookiePassthrough`. The framework helper
      already shipped with try/catch for build-time safety.
      `getVtexCookies` stays inline (it's auth-specific filtering, not
      generic passthrough — see Wave 15-B/16 for full provider wiring
      under H1).
    - **`templates/routes.ts` + `templates/commerce-loaders.ts`** —
      replace casaevideo-specific branding leaks ("Tudo para sua
      casa…" tagline, "O melhor site de compras online…"
      `productListPageCollection` SEO description) with
      `${siteTitle}`-derived defaults plus `MIGRATION TODO` markers
      pointing at the per-site customization spot. CMS `Site.seo`
      overrides the defaults at runtime so leaving them visible in
      pre-resolution states is the safe behaviour.
    - **Audit rule expansion: `dead-runtime-shim`** — previously only
      flagged when exports were exactly `{ invoke }` or
      `{ invoke, createNestedInvokeProxy }`. Updated to detect (a)
      inline `createNestedInvokeProxy` body via regex (catches the
      legacy 47-line shape **with** `Runtime` export — which the old
      heuristic missed entirely; this is the shape every existing
      VTEX site has) and (b) skip the new Wave-15-A canonical
      re-export shape (where `import invoke from
      @decocms/start/sdk` is present and no inline proxy body
      exists). Auto-fix is gated by `safeToAutoFix` metadata: legacy
      shim shapes get the rewrite + delete; sites that mix the proxy
      with custom helpers get a warning only. Three new tests.
      **Verified against casaevideo-storefront**: now flags
      `[invoke, Runtime] inline createNestedInvokeProxy body` (was
      missed entirely before).
    - **Skill: `references/platform-hooks-factories.md`** — new
      canonical doc covering `createUseCart` / `createUseUser` /
      `createUseWishlist`. Replaces the pre-W12 manual approach of
      hand-rolling 200+ LOC of `createServerFn` wrappers per site.
      Documents the 5-line shim shape, why factories instead of
      direct hook imports (state isolation per site), non-VTEX
      stubs using `@decocms/start/sdk/signal`, and the migration
      path off the manual approach.
    - **Skill update: `references/platform-hooks/README.md`** —
      retained as legacy reference but now opens with a
      "deprecated, see canonical" header pointing at the new doc.
      The pre-W12 `createServerFn` examples are kept for sites that
      haven't migrated to factories yet.
    - **`SKILL.md` index update** — Phase 5 entry now points to the
      factories doc; reference table lists both new + legacy paths.
    - 342 → 345 tests pass, typecheck clean, smoke against casaevideo
      + baggagio confirms expanded rule fires correctly on legacy
      shapes and stays silent on baggagio (no `runtime.ts` file there).

**Deferred to Wave 15-B / 16 (intentionally — see discoveries journal):**

- **G3** — promote the 170-LOC `invoke.gen.ts` VTEX `createServerFn`
  wrappers into `@decocms/apps/vtex/server-fns`. Needs research on
  whether TanStack Start's compiler can transform `createServerFn`
  call sites that live inside a node_module. Not safe to ship blind.
- **H1** — full cookie-passthrough provider wiring
  (`setRequestCookieProvider` / `setResponseCookieForwarder` in
  apps-start, auto-wire in `templates/setup.ts`). The
  `cookiePassthrough.ts` docstring already references this design but
  the apps-start side doesn't exist. Needs a design pass to scope
  what calls inside `vtex/utils/fetch.ts` need the provider hook
  (currently each call site forwards cookies manually).
- **Cross-site convergence promotions** (5 items) — `useSuggestions`,
  `useOffer` factory, `Picture` API unification, redirect
  `useSendEvent`/`clx`/location-matcher imports, `relative()`
  SKU-stripping extension. Sequenced after 15-A merges.

### Wave 15-B-1 (cross-site convergence — `local-framework-duplicate` audit rule) — 🟡 **IN FLIGHT**

First slice of the cross-site-convergence backlog deferred from
Wave 15-A. Concrete data first (per the user-rule "verify before
designing"): the `useSendEvent`/`clx`/location-matcher promotion
turned out to be *not* a "promote site code → framework" exercise.
The framework already has each helper. The work is **enforcing the
existing canonical** when sites carry their own copy.

Verified state (2026-05-01 grep against both sites):

| Item | casaevideo | baggagio | Action |
|---|---|---|---|
| `src/sdk/clx.ts` | absent (already canonical) | present, identical body + dead `clsx` alias (zero callers) | pure dup → **auto-fix** |
| `src/sdk/useSendEvent.ts` | absent | present, **stricter** typing (`<E extends AnalyticsEvent>` generic) vs framework's permissive shape | **warn-only** (replacing 1:1 weakens types) |
| `src/matchers/location.ts` | present, cookie-only subset of framework | absent | **warn-only** (framework's `registerBuiltinMatchers()` is a behavior superset; needs per-site verification of country-name lookup parity) |

So this is exactly *one* mechanically-applicable fix (`clx` in
baggagio) plus two judgement calls. Hand-applying would be cheap;
the value is making the audit *enforce* the convergence so the next
copy-paste regression on any future site gets caught automatically.

**Shipped (one PR against `decocms/deco-start`):**

38. `feat(migrate): local-framework-duplicate audit rule with registry-driven enforcement` 🟡 **WAITING ON CI**
    - **New rule `local-framework-duplicate`** in
      `scripts/migrate/post-cleanup/rules.ts` driven by an exported
      `FRAMEWORK_DUPLICATES` registry. Each entry is `{ id,
      sitePath, canonicalImport, contentSignature: RegExp[],
      safeToAutoFix, reason?, description }`. The rule fires only
      when **every** content-signature regex matches the site file
      — conservative on purpose so genuinely-forked helpers are
      skipped.
    - **Auto-fix path** (when `safeToAutoFix: true`): rewrite all
      `from "~/<derived>"` importers to `from
      "<canonicalImport>"` via the existing `rewriteImportSpec`
      helper, then delete the file. Already-canonical importers
      are left untouched.
    - **Warn-only path** (when `safeToAutoFix: false`): rule still
      fires + populates the finding's `fix:` field with the
      `reason` so engineers see *why* auto-fix is gated and what
      they need to verify before manual cleanup.
    - **Three initial entries** in the registry, mapped 1:1 to the
      cross-site audit findings:
      | id | site path | canonical | auto-fix? |
      |---|---|---|---|
      | `clx` | `src/sdk/clx.ts` | `@decocms/start/sdk/clx` | **yes** |
      | `use-send-event` | `src/sdk/useSendEvent.ts` | `@decocms/start/sdk/analytics` | no (typing regression) |
      | `location-matcher` | `src/matchers/location.ts` | `@decocms/start/matchers/builtins` | no (behavior superset, parity check needed) |
    - **11 new tests** covering: pure-dup detection, fork detection
      (signature mismatch → no flag), warn-only entries, severity
      uniformity (warning for both kinds, so `--strict` gates
      everything), auto-fix happy-path (delete + rewrite both
      importers, leave canonical importers alone), warn-only
      auto-fix is a no-op (does NOT delete partial-overlap files),
      mixed coexistence (auto-fixable `clx` and warn-only
      `useSendEvent` in the same tree → only `clx` gets auto-fixed),
      `supportsAutoFix` flag is true (since rule has `applyFix`).
    - **CLI help text + `post-migration-cleanup.md` § 8** updated
      with the new rule's table and the "adding a new entry"
      section. Old § 8 (orphan TODO comments) renumbered to § 9.
    - 345 → 353 tests pass, typecheck clean, end-to-end disk smoke
      against a temp fixture confirmed: 2 importers rewritten + 1
      file deleted in one `--fix` run.
    - **Real-site smoke**:
      - **baggagio**: rule fires twice — `clx.ts` (auto-fixable),
        `useSendEvent.ts` (warn-only with the typed-generic reason).
      - **casaevideo**: rule fires once — `location.ts` (warn-only
        with the `registerBuiltinMatchers()` adoption hint).
    - **Net**: every future site that copy-pastes any of these three
      files gets a tight audit finding + auto-fix on the safe one.
      The registry pattern means adding a 4th cross-site duplicate
      is a single object literal — no new rule, no new tests
      scaffolding, no new doc section.

**Still in the cross-site backlog (sequenced behind 15-B-1):**

- **15-B-3** — `useOffer` factory (D4 candidate; needs design pass
  for PIX/installment plugin slots).
- **15-B-4** — `Picture` API unification (breaking; needs a
  picking-the-winner pass between casaevideo's and baggagio's
  shapes, plus a codemod for call sites).

### Wave 15-B-5 (canonical `relative()` + audit registry entry — apps + deco-start) — 🟡 **IN FLIGHT**

The smallest 15-B slice: extend `commerce/sdk/url.ts → relative()`
with a generic options bag, then point the audit at the canonical
so future site forks get caught automatically.

Verified state (2026-05-01 grep against baggagio-tanstack):

- `src/sdk/url.ts` carries a positional 2-arg fork (`relative(link,
  removeIdSku?: boolean)`) with VTEX-specific keys (`idsku`,
  `skuId`) hardcoded inside.
- 9 importers in baggagio. ONE of them — `ProductCard.tsx` — uses
  the 2-arg form (via prop `removeIdSkuFromUrl`). The other 8 use
  the 1-arg form, identical to the apps canonical.
- casaevideo doesn't carry a fork.

So the convergence is one apps-side extension + one audit registry
entry. The single `ProductCard` call site rewrites by hand or by a
future codemod (out of scope here).

**Shipped (two PRs):**

39. [`apps-start#36`](https://github.com/decocms/apps-start/pull/36) — `feat(commerce/sdk): extend relative() with stripSearchParams option` ✅ **MERGED** (will release as `@decocms/apps@1.9.x`).
    - **`commerce/sdk/url.ts`**: backwards-compatible second
      `RelativeOptions` argument with `stripSearchParams?:
      string[]` primitive. 1-arg callers (everyone in apps + 8/9
      of baggagio's call sites) unaffected. The byte-for-byte
      "://path-style" passthrough is locked in by an explicit
      backwards-compat test.
    - **Why generic, not `removeIdSku?: boolean`**: hardcoded VTEX
      key names belong at call sites, not in a generic commerce
      helper. `stripSearchParams: string[]` works for any platform.
      Sites pass `["idsku", "skuId"]` themselves — honest about
      where the platform knowledge lives.
    - **`commerce/__tests__/url.test.ts`** (new): 18 tests covering
      base behaviour (relative/absolute/undefined/empty/malformed
      via `toString()` thrower), `stripSearchParams` primitive
      (single, multi, empty, missing, repeated keys, all-stripped
      → drop trailing `?`), and three explicit backwards-compat
      assertions.
    - 290/290 tests pass, typecheck + biome clean.

40. `feat(migrate): add url-relative entry to local-framework-duplicate registry` 🟡 **WAITING ON CI** (deco-start side).
    - **Registry entry** in `FRAMEWORK_DUPLICATES` for
      `src/sdk/url.ts` → `@decocms/apps/commerce/sdk/url`. Content
      signature anchored on the legacy positional `removeIdSku?:
      boolean` shape so sites that already adopted the canonical
      options-object aren't flagged.
    - **`safeToAutoFix: false`** — the call-site rewrite from
      positional `relative(url, true)` to `relative(url, {
      stripSearchParams: ["idsku", "skuId"] })` requires JSX/TS-
      aware transformation, not pure import rewrite. The finding's
      `fix:` field carries the exact recipe.
    - **Two new tests**: positive case (legacy fork → flagged with
      the correct hint), negative case (canonical-shaped local
      fork that already adopted the options object → NOT flagged,
      proves the signature-anchoring works).
    - **Skill doc § 8 table** updated with the 4th entry, including
      version pin (`@decocms/apps@1.9+`).
    - 355/355 tests pass, typecheck clean. Smoke against baggagio
      now fires 3 findings (was 2): clx, useSendEvent, url; smoke
      against casaevideo unchanged at 1 (location-matcher).

**Process note**: this is the first time we ran the apps-side and
deco-start-side as a pair of PRs. The order matters — apps-start
must merge first so the deco-start audit registry can point at
the released canonical. The skill doc explicitly version-pins the
canonical (`@decocms/apps@1.9+`) so engineers reading the audit
output know whether they need to bump apps before adopting.

### Wave 15-B-2 (canonical `useSuggestions` factory + audit registry entry) — 🟡 **IN FLIGHT**

`useSuggestions` was the next D4 candidate after the `clx` /
`useSendEvent` / `location-matcher` audit. Both casaevideo and
baggagio independently invented the *exact same* shape — module-level
signal for payload + loading, FIFO promise queue, "is this still the
latest query?" cancel guard, post to `/deco/invoke/<__resolveType>`.
Differences were minor (Sentry hook in casaevideo, the cancel guard
in `finally` only in baggagio's version — actually the correct
behaviour, casaevideo's omission is a latent bug).

Verified state (2026-05-01 grep):
- casaevideo `src/sdk/useSuggestions.ts` — 58 LOC, typed via local
  `IntelligenseSearch`, Sentry-wrapped errors, missing latest-query
  guard in `finally`
- baggagio `src/sdk/useSuggestions.ts` — 55 LOC, typed via VTEX
  `Suggestion`, no observability, has the latest-query guard
  (correct behaviour)
- Single call site each (`Searchbar`/`Searchbar/Form`)

**Decision: framework, not apps.** The hook is a debounce/cancel/
coalesce primitive; the commerce-flavoured usage is incidental.
Apps depends on framework, not the other way around — putting it in
`@decocms/start/sdk` is the right layering.

**Decision: factory pattern.** Matches `createUseCart` /
`createUseUser` / `createUseWishlist` (D4 done right). State
isolation per call, type narrowing at the factory boundary, sites
get a 5-line shim.

**Shipped (one PR):**

41. `feat(sdk): createUseSuggestions factory + audit registry entry` 🟡 **WAITING ON CI**.
    - **`src/sdk/useSuggestions.ts`** (new, 158 LOC) — exports
      `createUseSuggestions<T>(options?)` returning
      `{ useSuggestions, _internal }`. Options: `onError(err, query)`
      Sentry/OTEL hook, `fetchImpl` for tests. The `_internal` field
      exposes the raw signals + a non-React `setQuery(query, loader)`
      and a `drain()` promise for SSR pre-fetch helpers and unit
      tests.
    - **Bug fix included**: the canonical adopts baggagio's
      `if (latestQuery === query) loading.value = false` guard in
      `finally`. casaevideo's version cleared loading
      unconditionally — meaning rapid keystrokes could leave the
      UI in an "older fetch wins" state. The factory closes that
      gap by default.
    - **`src/sdk/useSuggestions.test.ts`** (new) — 11 tests. Factory
      shape + isolation; happy-path fetch (correct URL, body, response
      mapping); loading-flag invariants; cancel guard verified by an
      echo-fetch mock that proves only the latest query reaches the
      network; serial-queue verified by a race detector that asserts
      `maxInflight === 1`; error path verified for `onError`
      forwarding, console fallback when no `onError` is wired,
      non-2xx responses, payload preservation across errors.
    - **`scripts/migrate/post-cleanup/rules.ts`** — 5th entry in
      `FRAMEWORK_DUPLICATES` registry for `src/sdk/useSuggestions.ts`
      → `@decocms/start/sdk/useSuggestions`. Content signature
      anchored on the legacy hand-rolled shape (`export const
      useSuggestions =`, `/deco/invoke/`, `latestQuery`). Sites that
      already adopted the factory shim are NOT flagged — proven by
      a negative test case.
    - **`safeToAutoFix: false`** — the per-site type parameter
      (`Suggestion` vs `IntelligenseSearch` vs custom) and `onError`
      wiring need site-specific decisions, so the rule emits a
      detailed `fix:` recipe instead of trying to auto-rewrite.
    - **Skill doc updates**:
      - `references/platform-hooks-factories.md` — new section
        documenting `createUseSuggestions` (site shim, factory
        ownership table, migrating-off recipe).
      - `references/post-migration-cleanup.md` § 8 — 5th row in the
        registry table with version pin (`@decocms/start@2.25+`).
      - `SKILL.md` architecture map — adds the `~/sdk/useSuggestions
        (hand-rolled) → @decocms/start/sdk/useSuggestions
        createUseSuggestions<T>()` row.
    - **`package.json`** — exposes `./sdk/useSuggestions` export.
    - 368/368 tests pass (was 355 — +11 factory tests, +2 audit
      registry tests). typecheck clean. Smoke output:
      - baggagio: 4 findings (was 3) — clx, useSendEvent, url-relative,
        **use-suggestions** (new)
      - casaevideo: 2 findings (was 1) — location-matcher,
        **use-suggestions** (new)

**Architectural note**: `useSuggestions` is the first framework-side
factory (the rest live in `@decocms/apps/vtex/hooks`). Future
generic primitives that match the "module-level signal + queue +
React hook" pattern can adopt the same `_internal`-with-non-React-
setter shape — useful for SSR pre-fetch and tests.

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

### Wave 16 (2026-05-02 — baggagio as production canary, stacked-PR pitfall RECURRENCE)

User merged baggagio's PRs B1–B6 to use as guinea pig before applying the same patterns to casaevideo + lebiscuit (which ARE in production). Live validation found a critical fact: **only B1 (the bump) actually reached `main`**. PRs #13–#17 were all merged in GitHub UI but their merge commits ended up on the **previous PR's branch**, never on `main`.

#### What happened (the same pitfall as Wave 8, recurring)

Each PR was opened with `base = previous PR's branch`:

| PR | Title | base | Merge commit landed on |
|---|---|---|---|
| #12 | bump 2.10→2.26 + apps 1.7→1.9 | `main` | ✅ `main` |
| #13 | drop `src/sdk/clx.ts` | `chore/bump-deco-2.26-apps-1.9` | ❌ that branch |
| #14 | createUseSuggestions factory | `chore/drop-local-clx` | ❌ that branch |
| #15 | canonical `relative()` | `chore/use-framework-suggestions-factory` | ❌ that branch |
| #16 | canonical `Picture` | `refactor/use-canonical-relative-url` | ❌ that branch |
| #17 | drop dead `useUser` stub | `refactor/use-canonical-picture` | ❌ that branch |

Each PR shows `state: MERGED` in GitHub. But the merge commit physically landed on each PR's source-branch tip, not on main. Result: all 5 cleanup PRs were silently orphaned.

Detection method that worked: file-existence check on `git show main:<deleted-file>` — `clx.ts`, `url.ts`, `Picture.tsx`, `useUser.ts` were all still present on main despite their PRs being "merged". Exists/absent is a faster signal than diff browsing.

#### Recovery: PR #18 — single consolidation

The deepest stacked branch (`chore/drop-dead-local-useuser`) cumulatively contained all 5 cleanups (B2–B6) linearly stacked on B1. Opened [`baggagio-tanstack#18`](https://github.com/deco-sites/baggagio-tanstack/pull/18) as `chore/consolidate-b2-b6-to-main` → `main`, replaying the exact contents of #13–#17 in order. Diff vs main: **59 files changed, +70 / −240, 4 files deleted**. Typecheck + build clean. Preview at `pr-18-baggagio-tanstack.deco-cx.workers.dev` rendered identical homepage / PLP / PDP / search to current main with zero new console errors. Merged to main, deploy succeeded.

#### Live validation post-merge (cumulative state on main)

Tested via Playwright (cursor-ide-browser MCP) on `https://baggagio-tanstack.deco-cx.workers.dev/`:

| Surface | Result | Notes |
|---|---|---|
| Homepage | ✅ Renders | Banner, categories, product carousel, footer all intact |
| PLP `/s?q=mochila` | ✅ 927 produtos | Filter + sort UI present, all images load |
| PDP `/mochila-masculina-executiva-para-notebook-horizonte/p` | ✅ Renders | Image gallery, prices, COMPRAR, frete calc, descrição all present |
| Search suggestions endpoint | ✅ 200 | Empty `searches[]` confirmed pre-existing (matches www.bagaggio.com.br) |
| `<picture>` HTML | ✅ 18 picture / 36 source | composable canonical pattern |
| Console errors (filtered 3rd-party) | ✅ Same as before | `[inline-script polyfill]` + image preload warnings pre-existing on main |

**Bonus discovery**: PR-B5 (canonical Picture) now correctly emits `<link rel="preload" as="image" media="(max-width: 767px)" imageSrcSet="..." fetchPriority="high">` for LCP banners — a real Web Vitals improvement that was NOT visible before the consolidation because Picture.tsx (the local wrapper without preload) was still on main.

#### Each PR's safety verdict (for casaevideo + lebiscuit replay)

| PR | Status | Safe to replay? |
|---|---|---|
| B1 — bump 2.x → 2.26 + apps 1.x → 1.9 | ✅ | YES — zero regressions on real site |
| B2 — drop `src/sdk/clx.ts` | ✅ | YES — pure rewrite, framework export is byte-equivalent |
| B3 — `createUseSuggestions` factory | ✅ | YES — wiring works end-to-end (200 status, payload reaches store) |
| B4 — canonical `relative()` with `stripSearchParams` | ✅ | YES — only affects PLPs with `?skuId=` URL params, no functional regression |
| B5 — canonical `Picture` from apps | ✅ + bonus | YES — adds proper `<link rel="preload" as="image" media>` for LCP |
| B6 — drop dead `src/hooks/useUser.ts` | ✅ | YES — file had 0 external imports |

**For casaevideo + lebiscuit**: same set of PRs is validated as safe. The replays (`C1`–`C11`, `L1`–`L11`) can proceed on production sites with confidence.

### Wave 16 — discoveries

- **Stacked-PR pitfall recurred even after Wave 8 documented it.** The Wave 8 mitigation ("verify base is main before merging") was not enforced; the user merged B2–B6 with original stacked bases. Stronger mitigation needed: when opening a stacked PR, **default to a single consolidating PR at the end** rather than 5 separate stacked merges. Single PR is one merge button, one CI run, one deploy — not 5 chances to mis-target the base.
- **File-existence check is the fastest "did the merge actually land on main?" probe.** Faster than reading PR-stats, faster than diffing branches. `git show main:<deleted-file> 2>&1` — empty stderr means the deletion didn't reach main.
- **Preview deploys via `wrangler versions upload --preview-alias` are cheap, fast (90 s), and PR-scoped.** Used `https://pr-N-baggagio-tanstack.deco-cx.workers.dev` to validate cumulative state BEFORE merging. Should be the default validation step for any consolidation PR.
- **The canonical Picture component's per-source `<link rel="preload" as="image" media="...">` injection is a real LCP win** — but it only triggers when `<Picture preload={true}>` is set on the call site. Baggagio's `BannerCarousel.tsx` already passes `preload={lcp}` from the CMS config; the local Picture.tsx wrapper just didn't honor it. Migration to canonical IS a perf upgrade, not just a code-cleanup.
- **Canary-driven validation matters even when the changes are mechanical.** I had high confidence the cumulative state would work (typecheck + build clean), but the live test is what surfaced the "PR-B5 actually emits preload links now" finding. Without the canary loop the perf delta would have been invisible.

### Wave 17 (2026-05-02 — als clean migration: end-to-end first time, with discoveries) — ✅ **SHIPPED**

User opted to wipe `als-tanstack` and re-import `als-storefront` from
scratch, then run our migration tooling end-to-end on a real, htmx-heavy
site for the first time. Goal stop-point: dev server boots + homepage
SSR returns 200. Stretch: "the right way, not the fast way" — port the
real things, then backport the learnings.

#### What landed on als-tanstack `main` (force-pushed, fresh history)

| Commit | What |
|---|---|
| `f1b6a11` | Import `als-storefront` baseline at origin/main `096686ab` |
| `3af54d4` | Run `@decocms/start migrate.ts` (analyze/scaffold/transform/cleanup) |
| `69727a0` | `npm install` + run codegens (blocks/sections/loaders/schema/routes) |
| `85d5317` | Worker boots — homepage SSR returns HTTP 200 |
| `2123516` | Port casaevideo CI/CD; bump deco-start `^2.27` + apps `^1.10`; rename worker |
| `c6f9dcb` | Defensive guards + restored site-local utils (`format`, `formatPhoneNumber`, `formatStatusName`) |
| `e6a1fd8` | Rewire 16 section loaders + restore Tailwind v4 theme tokens (`als` palette + custom fonts) |

End state: `npm run dev` boots, homepage renders 2592 DOM nodes (full
shell, navigation, content, footer), no Invalid URL / undefined.invoke
crashes. CSP and `clogger` warnings are non-fatal residue from the
pre-migration site (catalog as known follow-up).

#### Framework changes back-ported to deco-start (this PR)

The als run surfaced THREE migrator regressions that previous sites
(casaevideo / lebiscuit / baggagio) didn't trip because their section
authors happened to wire `loader` exports differently. Three real fixes:

| Fix | File | Why |
|---|---|---|
| **`withSectionLoader` helper** | `src/cms/sectionMixins.ts` | Lets `compose(withDevice(), withSearchParam(), withSectionLoader(() => import("~/sections/Foo")))` chain mixins WITH the section's own `loader` export. Previously the migrator's template chose mixins XOR own-loader and silently dropped the section's loader when both were present. |
| **Migrator template fix** | `scripts/migrate/templates/section-loaders.ts` | Always emit `withSectionLoader(...)` last in the chain when `meta.hasLoader === true`, alongside any `withDevice / withMobile / withSearchParam` mixins. Eliminates the silent-drop bug for future migrations. |
| **`gotcha #50` + `setup-ts.md` template + `css-styling.md` #48–#49** | `.agents/skills/deco-to-tanstack-migration/` | Documents both the section-loader composition pattern AND the Tailwind v4 custom-palette / `@layer components → @utility` migration pitfalls discovered during als CSS restoration. |

`withSectionLoader` is defensive by design — if the module has no
`loader`, returns props unchanged; if the loader throws (e.g. legacy
`(props, req, ctx)` signature with `ctx === undefined`), logs once via
`[withSectionLoader] section loader threw` and returns the original
props. One broken section never takes the page down.

#### Wave 17 — discoveries (added to gotcha catalog)

- **The migrator template was XOR-ing mixins vs section loaders.** This
  is a class of bug, not just one section. Across als 16 sections were
  affected. Detection on a fresh migration is hard because everything
  builds and SSR renders — sections just silently drop their data.
  Symptoms: empty product carousels, `Cannot read properties of
  undefined (reading 'X')` cascades from downstream components that
  expected the loader's data. Now detected at template-generation time
  by always composing both.
- **Tailwind v4 `@theme` token loss.** The migrator's scaffold writes a
  minimal `app.css` with grays + base colors only. Sites with custom
  brand palettes in `tailwind.config.ts theme.extend.colors` (als had
  `als: { gray, blue, red, ... }` namespace) lose ALL of those tokens.
  Symptom: Vite HMR overlay `Cannot apply unknown utility class
  'font-bebas-neue' / 'bg-als-blue-500'`, page DOM correct but visually
  unstyled. Plus a v4-specific second hop: `theme(colors.als.gray.50)`
  in `.css` files no longer resolves — must rewrite as
  `var(--color-als-gray-50)`. Plus `@layer components` custom classes
  (`.container-pdp`) can't be `@apply`d in v4 — must promote to
  `@utility`. All three documented in [css-styling.md #48–49](.agents/skills/deco-to-tanstack-migration/references/css-styling.md).
- **Site-local format utilities should NOT be hoisted to the apps SDK.**
  The migrator's overly-aggressive import-rewriting routed
  `formatPhoneNumber` / `formatStatusName` / `capitalize` to
  `@decocms/apps/commerce/sdk/formatPrice` (which doesn't export
  them). Only true commerce primitives (price formatting, currency,
  installments) belong in the apps SDK. Site-specific text formatting
  stays site-local in `src/sdk/`. Restored als-local versions and
  fixed import paths.
- **`HttpError` was the third common shim.** Already promoted `cn`,
  `cookie`, `encoding`, `STATUS_CODE`, `UserAgent` to `@decocms/start/sdk/`
  in Wave 15. `HttpError` joined them in [deco-start#138](https://github.com/decocms/deco-start/pull/138).
  als-tanstack ships with a temporary local shim until the next apps
  release picks up the framework export — TODO is checked into
  `src/lib/http-utils.ts`.
- **CI/CD porting from casaevideo to a new TanStack site is a 1-minute
  copy.** `deploy.yml`, `preview.yml`, `regen-blocks.yml`, plus
  `wrangler.jsonc` worker `name` rename, plus `account_id` paste from
  another site. No template needed yet — three sites is too few. Will
  template if a fourth migration needs it.

#### Counter-evidence the user-rule asks for

Going "the right way" added ~3 hours over going "the fast way" (the
fast way was: defer the 16 section-loader rewiring, accept empty
shelves, ship the boot SSR-200 commit and stop). The fast way would
have hidden two of the three discoveries above, because:

1. The migrator template fix only became obvious AFTER manually
   rewiring 16 sections by hand and noticing the pattern. If we had
   stopped at boot, the next site to migrate would have hit the same
   silent-drop bug.
2. The Tailwind v4 token-loss issue was only visible after the page
   rendered enough DOM to see "this should be branded." Boot
   verification (HTTP 200) would have passed without it.

So: 3 hours of "right way" produced one framework helper, one migrator
fix, three documented gotchas, and a working canary site. The next
htmx-heavy migration starts with these problems already solved. Net
positive.

#### What this PR does NOT do (deliberately)

- Migrate als's htmx surface to React (deferred per Wave 14 plan; the
  codemod handled the mechanical 47% — the rest is per-component
  product work and depends on des-system decisions for things like
  filter sidebars + minicart drawer animation)
- Validate als visually against production (visual-parity is a Phase 5+
  task; we're at Phase 4 dev-boots)
- Ship `HttpError` consumption in als or apps — als has a local shim,
  apps will pick up the framework export on next release
