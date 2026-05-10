# Framework-agnostic Entrypoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `@decocms/start` into three import tiers (`/core`, `/tanstack`, `/next`), publish a compiled `dist/`, and ship a first-party Next.js (App Router) adapter — so webpack/Next.js consumers can use the package without `transpilePackages` workarounds.

**Architecture:** One npm package, three tiers. `core/` is framework-agnostic (no `@tanstack/*`, no `next/*`, no top-level `node:async_hooks`). `tanstack/` is today's behavior, repackaged. `next/` is new (App Router only). Boundaries enforced by per-directory Biome configs and a post-build graph check.

**Tech Stack:** TypeScript 5.9, React 19, `tsup` (new) for JS emit, `tsc` for `.d.ts`, Biome for lint, Vitest for tests, Bun as package manager. Spec at `docs/superpowers/specs/2026-05-10-framework-agnostic-entrypoints-design.md`.

**Delivery:** All work lands on a single branch (`tlgimenes/framework-agnostic`) and is merged via one PR. Local commits at task boundaries are checkpoints, not separate PRs.

**Branch state assumption:** You are on `tlgimenes/framework-agnostic`, which is currently at `main + spec commit`. Working directory clean. `bun install` already done.

---

## File Structure (target)

After the plan, `src/` will look like:

```
src/
├── core/                     ← framework-agnostic
│   ├── index.ts              ← barrel
│   ├── runtime/
│   │   ├── requestStore.ts   ← NEW: RequestStore interface + noop default
│   │   └── index.ts
│   ├── cms/                  ← moved from src/cms/
│   │   ├── index.ts
│   │   ├── loader.ts         ← MODIFIED: uses injected RequestStore
│   │   ├── registry.ts       ← MODIFIED: registerSectionsSync registers a fallback loader
│   │   ├── resolve.ts
│   │   ├── applySectionConventions.ts
│   │   ├── loadCmsPagePure.ts            ← NEW
│   │   ├── resolveDeferredSectionPure.ts ← NEW
│   │   └── *.test.ts
│   ├── sdk/                  ← moved framework-agnostic sdk/* files
│   │   ├── index.ts
│   │   └── (clx, cn, signal, encoding, http, cookie, retry, useId, crypto,
│   │         urlUtils, normalizeUrls, mergeCacheControl, cacheHeaders, sitemap,
│   │         redirects, abTesting, wrapCaughtErrors, csp, useDevice, useHydrated,
│   │         useScript, useSuggestions, analytics, composite, otel, otelAdapters,
│   │         observability [pure parts], instrumentedFetch, logger, serverTimings,
│   │         invoke, djb2, env, htmlShell)
│   ├── matchers/             ← moved from src/matchers/
│   ├── types/                ← moved from src/types/
│   └── admin/                ← moved from src/admin/
│
├── tanstack/                 ← TanStack Start adapter (today's behavior)
│   ├── index.ts
│   ├── runtime/
│   │   └── alsRequestStore.ts            ← NEW: ALS-backed RequestStore impl
│   ├── routes/               ← moved from src/routes/
│   ├── hooks/                ← moved from src/hooks/
│   ├── middleware/           ← moved from src/middleware/
│   ├── sdk/                  ← TanStack-coupled sdk files
│   │   └── (workerEntry, router, createInvoke, requestContext,
│   │         cookiePassthrough, setupApps, cachedLoader)
│   ├── apps/                 ← moved from src/apps/ (uses TanStack request context)
│   ├── daemon/               ← moved from src/daemon/ (TanStack-tied dev tooling)
│   └── vite/                 ← moved from src/vite/
│
├── next/                     ← NEW: Next.js App Router adapter
│   ├── index.ts
│   ├── client.ts             ← client-safe surface (no node:async_hooks transitively)
│   ├── ctx.ts                ← buildMatcherContextFromNext(req)
│   ├── loadCmsPage.ts        ← (req: NextRequest) => Promise<DecoPageResult | null>
│   ├── adminRoute.ts         ← handleDecoAdminRoute (App Router route handler)
│   ├── DecoPage.tsx          ← RSC server component
│   └── client/               ← client-only re-exports
│       ├── LazySection.tsx
│       ├── SectionErrorFallback.tsx
│       └── LiveControls.tsx
│
└── index.ts                  ← top-level barrel; re-exports core only

scripts/
├── check-tier-boundaries.ts  ← NEW: post-build graph check
├── generate-blocks.ts        ← MODIFIED: paths updated for new tree
├── generate-sections.ts      ← MODIFIED: paths updated
├── generate-schema.ts        ← MODIFIED: paths updated
└── (existing scripts: migrate, migrate-post-cleanup, htmx-analyze, migrate-to-cf-observability)

tests/fixtures/next-app/      ← NEW: Next.js App Router CI fixture

tsup.config.ts                ← NEW
tsconfig.build.json           ← NEW (declaration-only emit)
src/core/biome.json           ← NEW (forbid @tanstack/*, next/*, node:async_hooks)
src/tanstack/biome.json       ← NEW (forbid next/*)
src/next/biome.json           ← NEW (forbid @tanstack/react-start, @tanstack/react-router)
```

---

## Phase 1 — Build Pipeline (no source moves yet)

Goal: produce a publishable `dist/` from the current `src/` layout. Webpack consumers can import the package after this phase, even before the tier reorg. We can validate the build pipeline against the existing source before disturbing it.

### Task 1: Add tsup as devDependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install tsup**

```bash
bun add -d tsup@^8.3.0
```

Expected: `package.json` `devDependencies` gains `"tsup": "^8.3.0"`. `bun.lockb` updated.

- [ ] **Step 2: Verify install**

```bash
bunx tsup --version
```

Expected output: a version string (e.g., `8.3.5` or similar).

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore(build): add tsup devDependency"
```

---

### Task 2: Add tsconfig.build.json for declaration-only emit

**Files:**
- Create: `tsconfig.build.json`

- [ ] **Step 1: Create tsconfig.build.json**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "emitDeclarationOnly": true,
    "declaration": true,
    "declarationMap": true,
    "outDir": "dist",
    "noEmit": false,
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test.tsx"]
}
```

- [ ] **Step 2: Run a smoke test that it emits .d.ts only**

```bash
rm -rf dist
bunx tsc -p tsconfig.build.json
ls dist/cms/index.d.ts dist/index.d.ts
```

Expected: both files exist; no `.js` files anywhere under `dist/`.

- [ ] **Step 3: Clean up**

```bash
rm -rf dist
```

- [ ] **Step 4: Commit**

```bash
git add tsconfig.build.json
git commit -m "chore(build): add tsconfig.build.json for declaration emit"
```

---

### Task 3: Add tsup.config.ts

**Files:**
- Create: `tsup.config.ts`

- [ ] **Step 1: Write tsup.config.ts**

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cms/index.ts",
    "src/admin/index.ts",
    "src/hooks/index.ts",
    "src/middleware/index.ts",
    "src/routes/index.ts",
    "src/matchers/builtins.ts",
    "src/matchers/posthog.ts",
    "src/types/index.ts",
    "src/types/widgets.ts",
    "src/sdk/index.ts",
    "src/sdk/*.ts",
    "src/sdk/otelAdapters/*.ts",
    "src/apps/index.ts",
    "src/apps/autoconfig.ts",
    "src/daemon/index.ts",
    "src/setup.ts",
    "src/vite/plugin.js",
    "scripts/generate-blocks.ts",
    "scripts/generate-schema.ts",
    "scripts/generate-invoke.ts",
    "scripts/migrate.ts",
    "scripts/migrate-post-cleanup.ts",
    "scripts/migrate-to-cf-observability.ts",
    "scripts/htmx-analyze.ts",
    "scripts/tailwind-lint.ts",
  ],
  format: ["esm", "cjs"],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  target: "es2022",
  external: [
    "@tanstack/react-query",
    "@tanstack/react-start",
    "@tanstack/react-start/server",
    "@tanstack/react-start/api",
    "@tanstack/react-start/server-entry",
    "@tanstack/react-router",
    "@tanstack/store",
    "react",
    "react-dom",
    "react-dom/server",
    "next",
    "next/server",
    "vite",
    "node:async_hooks",
    "node:stream",
    "node:fs",
    "node:crypto",
    "node:path",
    "node:url",
    "node:util",
  ],
  esbuildOptions(opts) {
    opts.jsx = "automatic";
    opts.platform = "neutral";
  },
  ignoreWatch: ["**/*.test.ts", "**/*.test.tsx"],
});
```

- [ ] **Step 2: Run tsup build**

```bash
rm -rf dist
bunx tsup
```

Expected: `dist/` directory populated with `.js` and `.cjs` files; build exits 0; no errors.

- [ ] **Step 3: Verify entries exist**

```bash
test -f dist/index.js && test -f dist/index.cjs
test -f dist/cms/index.js && test -f dist/cms/index.cjs
test -f dist/sdk/cacheHeaders.js && test -f dist/sdk/cacheHeaders.cjs
test -f dist/vite/plugin.js
echo "ok"
```

Expected: prints `ok`.

- [ ] **Step 4: Run tsc declaration build**

```bash
bunx tsc -p tsconfig.build.json
test -f dist/index.d.ts && test -f dist/cms/index.d.ts && echo "ok"
```

Expected: prints `ok`.

- [ ] **Step 5: Commit**

```bash
git add tsup.config.ts
git commit -m "chore(build): add tsup.config.ts for dist/ emit"
```

---

### Task 4: Update package.json scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update scripts section**

Replace the existing `"build"` script and add new build sub-scripts:

```jsonc
"scripts": {
  "build:js": "tsup",
  "build:types": "tsc -p tsconfig.build.json",
  "build": "bun run build:js && bun run build:types",
  "prepublishOnly": "bun run build",
  "test": "vitest run",
  "typecheck": "tsc --noEmit",
  "lint": "biome check src/ scripts/",
  "lint:fix": "biome check --write src/ scripts/",
  "lint:unused": "knip",
  "format": "biome format src/ scripts/",
  "format:fix": "biome format --write src/ scripts/",
  "check": "bun run typecheck && bun run lint && bun run lint:unused",
  "clean": "rm -rf node_modules .cache dist .wrangler/state node_modules/.vite && bun install"
}
```

- [ ] **Step 2: Run full build**

```bash
rm -rf dist
bun run build
```

Expected: `dist/` populated with `.js`, `.cjs`, `.d.ts`, `.d.cts`, `.d.ts.map` files; exit 0.

- [ ] **Step 3: Verify a representative file pair**

```bash
test -f dist/sdk/cacheHeaders.js \
  && test -f dist/sdk/cacheHeaders.cjs \
  && test -f dist/sdk/cacheHeaders.d.ts \
  && echo "ok"
```

Expected: prints `ok`.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(build): wire build:js + build:types scripts"
```

---

### Task 5: Update package.json exports to point at dist/

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update top-level fields**

Change:
```jsonc
"main": "./src/index.ts",
```
to:
```jsonc
"main": "./dist/index.cjs",
"module": "./dist/index.js",
"types": "./dist/index.d.ts",
"sideEffects": false,
```

- [ ] **Step 2: Rewrite the entire `exports` map**

Replace the existing `"exports"` map with the conditional-exports form. Every export gets:
```jsonc
"./<path>": {
  "types": "./dist/<path>.d.ts",
  "import": "./dist/<path>.js",
  "require": "./dist/<path>.cjs"
}
```

The full new `exports` map:

```jsonc
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js",
    "require": "./dist/index.cjs"
  },
  "./cms": {
    "types": "./dist/cms/index.d.ts",
    "import": "./dist/cms/index.js",
    "require": "./dist/cms/index.cjs"
  },
  "./admin": {
    "types": "./dist/admin/index.d.ts",
    "import": "./dist/admin/index.js",
    "require": "./dist/admin/index.cjs"
  },
  "./hooks": {
    "types": "./dist/hooks/index.d.ts",
    "import": "./dist/hooks/index.js",
    "require": "./dist/hooks/index.cjs"
  },
  "./types": {
    "types": "./dist/types/index.d.ts",
    "import": "./dist/types/index.js",
    "require": "./dist/types/index.cjs"
  },
  "./types/widgets": {
    "types": "./dist/types/widgets.d.ts",
    "import": "./dist/types/widgets.js",
    "require": "./dist/types/widgets.cjs"
  },
  "./sdk": {
    "types": "./dist/sdk/index.d.ts",
    "import": "./dist/sdk/index.js",
    "require": "./dist/sdk/index.cjs"
  },
  "./sdk/useScript":          { "types": "./dist/sdk/useScript.d.ts",          "import": "./dist/sdk/useScript.js",          "require": "./dist/sdk/useScript.cjs" },
  "./sdk/signal":             { "types": "./dist/sdk/signal.d.ts",             "import": "./dist/sdk/signal.js",             "require": "./dist/sdk/signal.cjs" },
  "./sdk/clx":                { "types": "./dist/sdk/clx.d.ts",                "import": "./dist/sdk/clx.js",                "require": "./dist/sdk/clx.cjs" },
  "./sdk/cn":                 { "types": "./dist/sdk/cn.d.ts",                 "import": "./dist/sdk/cn.js",                 "require": "./dist/sdk/cn.cjs" },
  "./sdk/encoding":           { "types": "./dist/sdk/encoding.d.ts",           "import": "./dist/sdk/encoding.js",           "require": "./dist/sdk/encoding.cjs" },
  "./sdk/http":               { "types": "./dist/sdk/http.d.ts",               "import": "./dist/sdk/http.js",               "require": "./dist/sdk/http.cjs" },
  "./sdk/useSuggestions":     { "types": "./dist/sdk/useSuggestions.d.ts",     "import": "./dist/sdk/useSuggestions.js",     "require": "./dist/sdk/useSuggestions.cjs" },
  "./sdk/retry":              { "types": "./dist/sdk/retry.d.ts",              "import": "./dist/sdk/retry.js",              "require": "./dist/sdk/retry.cjs" },
  "./sdk/useId":              { "types": "./dist/sdk/useId.d.ts",              "import": "./dist/sdk/useId.js",              "require": "./dist/sdk/useId.cjs" },
  "./sdk/cookie":             { "types": "./dist/sdk/cookie.d.ts",             "import": "./dist/sdk/cookie.js",             "require": "./dist/sdk/cookie.cjs" },
  "./sdk/cookiePassthrough":  { "types": "./dist/sdk/cookiePassthrough.d.ts",  "import": "./dist/sdk/cookiePassthrough.js",  "require": "./dist/sdk/cookiePassthrough.cjs" },
  "./sdk/analytics":          { "types": "./dist/sdk/analytics.d.ts",          "import": "./dist/sdk/analytics.js",          "require": "./dist/sdk/analytics.cjs" },
  "./sdk/cachedLoader":       { "types": "./dist/sdk/cachedLoader.d.ts",       "import": "./dist/sdk/cachedLoader.js",       "require": "./dist/sdk/cachedLoader.cjs" },
  "./sdk/serverTimings":      { "types": "./dist/sdk/serverTimings.d.ts",      "import": "./dist/sdk/serverTimings.js",      "require": "./dist/sdk/serverTimings.cjs" },
  "./sdk/cacheHeaders":       { "types": "./dist/sdk/cacheHeaders.d.ts",       "import": "./dist/sdk/cacheHeaders.js",       "require": "./dist/sdk/cacheHeaders.cjs" },
  "./sdk/crypto":             { "types": "./dist/sdk/crypto.d.ts",             "import": "./dist/sdk/crypto.js",             "require": "./dist/sdk/crypto.cjs" },
  "./sdk/invoke":             { "types": "./dist/sdk/invoke.d.ts",             "import": "./dist/sdk/invoke.js",             "require": "./dist/sdk/invoke.cjs" },
  "./sdk/instrumentedFetch":  { "types": "./dist/sdk/instrumentedFetch.d.ts",  "import": "./dist/sdk/instrumentedFetch.js",  "require": "./dist/sdk/instrumentedFetch.cjs" },
  "./sdk/otel":               { "types": "./dist/sdk/otel.d.ts",               "import": "./dist/sdk/otel.js",               "require": "./dist/sdk/otel.cjs" },
  "./sdk/logger":             { "types": "./dist/sdk/logger.d.ts",             "import": "./dist/sdk/logger.js",             "require": "./dist/sdk/logger.cjs" },
  "./sdk/composite":          { "types": "./dist/sdk/composite.d.ts",          "import": "./dist/sdk/composite.js",          "require": "./dist/sdk/composite.cjs" },
  "./sdk/otelAdapters":       { "types": "./dist/sdk/otelAdapters.d.ts",       "import": "./dist/sdk/otelAdapters.js",       "require": "./dist/sdk/otelAdapters.cjs" },
  "./sdk/otelAdapters/clickhouseCollector": { "types": "./dist/sdk/otelAdapters/clickhouseCollector.d.ts", "import": "./dist/sdk/otelAdapters/clickhouseCollector.js", "require": "./dist/sdk/otelAdapters/clickhouseCollector.cjs" },
  "./sdk/observability":      { "types": "./dist/sdk/observability.d.ts",      "import": "./dist/sdk/observability.js",      "require": "./dist/sdk/observability.cjs" },
  "./sdk/workerEntry":        { "types": "./dist/sdk/workerEntry.d.ts",        "import": "./dist/sdk/workerEntry.js",        "require": "./dist/sdk/workerEntry.cjs" },
  "./sdk/abTesting":          { "types": "./dist/sdk/abTesting.d.ts",          "import": "./dist/sdk/abTesting.js",          "require": "./dist/sdk/abTesting.cjs" },
  "./sdk/redirects":          { "types": "./dist/sdk/redirects.d.ts",          "import": "./dist/sdk/redirects.js",          "require": "./dist/sdk/redirects.cjs" },
  "./sdk/sitemap":            { "types": "./dist/sdk/sitemap.d.ts",            "import": "./dist/sdk/sitemap.js",            "require": "./dist/sdk/sitemap.cjs" },
  "./sdk/useDevice":          { "types": "./dist/sdk/useDevice.d.ts",          "import": "./dist/sdk/useDevice.js",          "require": "./dist/sdk/useDevice.cjs" },
  "./sdk/useHydrated":        { "types": "./dist/sdk/useHydrated.d.ts",        "import": "./dist/sdk/useHydrated.js",        "require": "./dist/sdk/useHydrated.cjs" },
  "./sdk/wrapCaughtErrors":   { "types": "./dist/sdk/wrapCaughtErrors.d.ts",   "import": "./dist/sdk/wrapCaughtErrors.js",   "require": "./dist/sdk/wrapCaughtErrors.cjs" },
  "./sdk/csp":                { "types": "./dist/sdk/csp.d.ts",                "import": "./dist/sdk/csp.js",                "require": "./dist/sdk/csp.cjs" },
  "./sdk/urlUtils":           { "types": "./dist/sdk/urlUtils.d.ts",           "import": "./dist/sdk/urlUtils.js",           "require": "./dist/sdk/urlUtils.cjs" },
  "./sdk/normalizeUrls":      { "types": "./dist/sdk/normalizeUrls.d.ts",      "import": "./dist/sdk/normalizeUrls.js",      "require": "./dist/sdk/normalizeUrls.cjs" },
  "./sdk/mergeCacheControl":  { "types": "./dist/sdk/mergeCacheControl.d.ts",  "import": "./dist/sdk/mergeCacheControl.js",  "require": "./dist/sdk/mergeCacheControl.cjs" },
  "./sdk/requestContext":     { "types": "./dist/sdk/requestContext.d.ts",     "import": "./dist/sdk/requestContext.js",     "require": "./dist/sdk/requestContext.cjs" },
  "./sdk/createInvoke":       { "types": "./dist/sdk/createInvoke.d.ts",       "import": "./dist/sdk/createInvoke.js",       "require": "./dist/sdk/createInvoke.cjs" },
  "./sdk/router":             { "types": "./dist/sdk/router.d.ts",             "import": "./dist/sdk/router.js",             "require": "./dist/sdk/router.cjs" },
  "./sdk/setupApps":          { "types": "./dist/sdk/setupApps.d.ts",          "import": "./dist/sdk/setupApps.js",          "require": "./dist/sdk/setupApps.cjs" },
  "./middleware":             { "types": "./dist/middleware/index.d.ts",       "import": "./dist/middleware/index.js",       "require": "./dist/middleware/index.cjs" },
  "./middleware/healthMetrics":     { "types": "./dist/middleware/healthMetrics.d.ts",     "import": "./dist/middleware/healthMetrics.js",     "require": "./dist/middleware/healthMetrics.cjs" },
  "./middleware/hydrationContext":  { "types": "./dist/middleware/hydrationContext.d.ts",  "import": "./dist/middleware/hydrationContext.js",  "require": "./dist/middleware/hydrationContext.cjs" },
  "./middleware/validateSection":   { "types": "./dist/middleware/validateSection.d.ts",   "import": "./dist/middleware/validateSection.js",   "require": "./dist/middleware/validateSection.cjs" },
  "./matchers/posthog":   { "types": "./dist/matchers/posthog.d.ts",   "import": "./dist/matchers/posthog.js",   "require": "./dist/matchers/posthog.cjs" },
  "./matchers/builtins":  { "types": "./dist/matchers/builtins.d.ts",  "import": "./dist/matchers/builtins.js",  "require": "./dist/matchers/builtins.cjs" },
  "./apps":             { "types": "./dist/apps/index.d.ts",       "import": "./dist/apps/index.js",       "require": "./dist/apps/index.cjs" },
  "./apps/autoconfig":  { "types": "./dist/apps/autoconfig.d.ts",  "import": "./dist/apps/autoconfig.js",  "require": "./dist/apps/autoconfig.cjs" },
  "./setup":            { "types": "./dist/setup.d.ts",            "import": "./dist/setup.js",            "require": "./dist/setup.cjs" },
  "./routes":           { "types": "./dist/routes/index.d.ts",     "import": "./dist/routes/index.js",     "require": "./dist/routes/index.cjs" },
  "./scripts/generate-blocks":               { "types": "./dist/scripts/generate-blocks.d.ts",               "import": "./dist/scripts/generate-blocks.js",               "require": "./dist/scripts/generate-blocks.cjs" },
  "./scripts/generate-schema":               { "types": "./dist/scripts/generate-schema.d.ts",               "import": "./dist/scripts/generate-schema.js",               "require": "./dist/scripts/generate-schema.cjs" },
  "./scripts/generate-invoke":               { "types": "./dist/scripts/generate-invoke.d.ts",               "import": "./dist/scripts/generate-invoke.js",               "require": "./dist/scripts/generate-invoke.cjs" },
  "./scripts/migrate":                       { "types": "./dist/scripts/migrate.d.ts",                       "import": "./dist/scripts/migrate.js",                       "require": "./dist/scripts/migrate.cjs" },
  "./scripts/migrate-post-cleanup":          { "types": "./dist/scripts/migrate-post-cleanup.d.ts",          "import": "./dist/scripts/migrate-post-cleanup.js",          "require": "./dist/scripts/migrate-post-cleanup.cjs" },
  "./scripts/migrate-to-cf-observability":   { "types": "./dist/scripts/migrate-to-cf-observability.d.ts",   "import": "./dist/scripts/migrate-to-cf-observability.js",   "require": "./dist/scripts/migrate-to-cf-observability.cjs" },
  "./scripts/tailwind-lint":                 { "types": "./dist/scripts/tailwind-lint.d.ts",                 "import": "./dist/scripts/tailwind-lint.js",                 "require": "./dist/scripts/tailwind-lint.cjs" },
  "./vite":             { "import": "./dist/vite/plugin.js", "require": "./dist/vite/plugin.cjs" },
  "./daemon":           { "types": "./dist/daemon/index.d.ts",     "import": "./dist/daemon/index.js",     "require": "./dist/daemon/index.cjs" }
}
```

(NOTE: `./vite` has no `types` because the plugin is plain JS.)

- [ ] **Step 3: Update bin section to compiled paths**

Change:
```jsonc
"bin": {
  "deco-migrate": "./scripts/migrate.ts",
  "deco-post-cleanup": "./scripts/migrate-post-cleanup.ts",
  "deco-htmx-analyze": "./scripts/htmx-analyze.ts",
  "deco-cf-observability": "./scripts/migrate-to-cf-observability.ts"
}
```
to:
```jsonc
"bin": {
  "deco-migrate": "./dist/scripts/migrate.cjs",
  "deco-post-cleanup": "./dist/scripts/migrate-post-cleanup.cjs",
  "deco-htmx-analyze": "./dist/scripts/htmx-analyze.cjs",
  "deco-cf-observability": "./dist/scripts/migrate-to-cf-observability.cjs"
}
```

- [ ] **Step 4: Add files field**

Add at the top level of package.json (next to `keywords`):

```jsonc
"files": ["dist", "README.md", "LICENSE"],
```

- [ ] **Step 5: Run full build**

```bash
rm -rf dist
bun run build
```

Expected: clean build, exit 0.

- [ ] **Step 6: Run typecheck against the package's own source**

```bash
bun run typecheck
```

Expected: exit 0. (Source still references its own files via relative paths, so this should pass.)

- [ ] **Step 7: Sanity-check resolution**

```bash
node -e "console.log(require.resolve('@decocms/start/sdk/cacheHeaders'))" 2>&1 | head -5
```

If run from the repo root, this should resolve to `dist/sdk/cacheHeaders.cjs`. The exact path may vary; the important check: it should NOT mention `src/`.

- [ ] **Step 8: Commit**

```bash
git add package.json
git commit -m "chore(build): repoint package.json exports at dist/"
```

---

### Task 6: Add #!/usr/bin/env node shebang to compiled bin scripts

The `bin` entries in `package.json` now point at compiled `.cjs` files, but `tsup` doesn't add shebangs to CJS output. Without a shebang, `npx deco-migrate` and friends won't be executable as binaries.

**Files:**
- Modify: `tsup.config.ts`

- [ ] **Step 1: Add shebang to bin entries via tsup banner**

The cleanest approach: tsup supports per-entry banners, but the simplest is to add a `banner` option scoped via a glob match. Since tsup doesn't natively support per-glob banners in a simple form, use the `onSuccess` post-build hook to prepend shebangs to bin files:

Update `tsup.config.ts`. Replace the existing `defineConfig({ ... })` body with:

```ts
import { defineConfig } from "tsup";
import { promises as fs } from "node:fs";
import { join } from "node:path";

const BIN_FILES = [
  "dist/scripts/migrate.cjs",
  "dist/scripts/migrate-post-cleanup.cjs",
  "dist/scripts/htmx-analyze.cjs",
  "dist/scripts/migrate-to-cf-observability.cjs",
];

export default defineConfig({
  entry: [
    /* same as before */
  ],
  format: ["esm", "cjs"],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  target: "es2022",
  external: [
    /* same as before */
  ],
  esbuildOptions(opts) {
    opts.jsx = "automatic";
    opts.platform = "neutral";
  },
  ignoreWatch: ["**/*.test.ts", "**/*.test.tsx"],
  async onSuccess() {
    const SHEBANG = "#!/usr/bin/env node\n";
    for (const file of BIN_FILES) {
      const path = join(process.cwd(), file);
      try {
        const content = await fs.readFile(path, "utf8");
        if (!content.startsWith("#!")) {
          await fs.writeFile(path, SHEBANG + content, "utf8");
          await fs.chmod(path, 0o755);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  },
});
```

(Re-include the `entry` array and `external` array verbatim from Task 3; this is just showing the additions. **Be sure to preserve them in full.**)

- [ ] **Step 2: Run build**

```bash
rm -rf dist
bun run build
```

Expected: build succeeds.

- [ ] **Step 3: Verify shebangs**

```bash
head -1 dist/scripts/migrate.cjs
head -1 dist/scripts/migrate-post-cleanup.cjs
head -1 dist/scripts/htmx-analyze.cjs
head -1 dist/scripts/migrate-to-cf-observability.cjs
```

Expected: each prints `#!/usr/bin/env node`.

- [ ] **Step 4: Verify executable permission**

```bash
ls -l dist/scripts/migrate.cjs | awk '{print $1}'
```

Expected: contains `x` (e.g., `-rwxr-xr-x`).

- [ ] **Step 5: Commit**

```bash
git add tsup.config.ts
git commit -m "chore(build): add shebang + chmod +x to compiled bin scripts"
```

---

### Task 7: Add Next.js App Router fixture for CI validation

The Next.js fixture is the validation gate for the entire effort. Set it up early so every subsequent phase can validate against it.

**Files:**
- Create: `tests/fixtures/next-app/package.json`
- Create: `tests/fixtures/next-app/tsconfig.json`
- Create: `tests/fixtures/next-app/next.config.mjs`
- Create: `tests/fixtures/next-app/app/layout.tsx`
- Create: `tests/fixtures/next-app/app/page.tsx`
- Create: `tests/fixtures/next-app/app/_smoke/page.tsx`
- Create: `tests/fixtures/next-app/.gitignore`

- [ ] **Step 1: Create the fixture package.json**

```json
{
  "name": "decocms-start-next-fixture",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "next build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@decocms/start": "file:../../..",
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 2: Create the fixture tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create next.config.mjs**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  // intentionally NOT using transpilePackages — we want to prove
  // @decocms/start is consumable without it.
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
```

- [ ] **Step 4: Create app/layout.tsx**

```tsx
import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 5: Create app/page.tsx**

```tsx
export default function Page() {
  return <main>fixture root</main>;
}
```

- [ ] **Step 6: Create app/_smoke/page.tsx**

This page imports from `@decocms/start` to prove the package is consumable. Until later phases add the `/next` adapter, just smoke-test that core CMS exports parse and resolve under webpack:

```tsx
import { findPageByPath, registerSectionsSync } from "@decocms/start/cms";
import { cacheHeaders } from "@decocms/start/sdk/cacheHeaders";

export default async function SmokePage() {
  // Reference imports so they're not tree-shaken away
  const types = [typeof findPageByPath, typeof registerSectionsSync, typeof cacheHeaders];
  return <pre>{JSON.stringify({ types }, null, 2)}</pre>;
}
```

- [ ] **Step 7: Create .gitignore**

```
node_modules
.next
out
*.tsbuildinfo
next-env.d.ts
```

- [ ] **Step 8: Build the fixture**

```bash
cd tests/fixtures/next-app
bun install --no-save
bun run typecheck
bun run build
cd ../../..
```

Expected: `bun install` succeeds, `tsc` passes, `next build` succeeds. If `next build` complains about `node:async_hooks`, that's the gotcha #2 from the issue — it's expected to fail at this point because the smoke page indirectly imports `cms/loader.ts` (which uses `node:async_hooks`). **If it fails for that reason, simplify the smoke page** to import only `@decocms/start/sdk/cacheHeaders` (which is purely runtime-agnostic):

```tsx
import { cacheHeaders } from "@decocms/start/sdk/cacheHeaders";

export default function SmokePage() {
  return <pre>cacheHeaders: {typeof cacheHeaders}</pre>;
}
```

The full CMS-import smoke test gets re-enabled in Phase 7 once `node:async_hooks` is purged from `core/`.

- [ ] **Step 9: Commit**

```bash
git add tests/fixtures/next-app
git commit -m "test(next-fixture): add Next.js App Router fixture for build validation"
```

---

### Task 8: Update .gitignore to exclude dist/

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Check current .gitignore**

```bash
grep -E "^(dist|/dist)$" .gitignore || echo "MISSING"
```

If it prints `MISSING`, append `dist/` to `.gitignore`:

```
dist/
```

If it already contains `dist`, skip to Step 3.

- [ ] **Step 2: Verify**

```bash
grep -E "^(dist|/dist|dist/)$" .gitignore
```

Expected: prints the matching line.

- [ ] **Step 3: Commit if changed**

```bash
git status .gitignore
# If changed:
git add .gitignore
git commit -m "chore: exclude dist/ from git"
```

If `.gitignore` was unchanged, skip the commit.

---

### Task 9: Phase 1 validation gate

- [ ] **Step 1: Run full build**

```bash
rm -rf dist
bun run build
```

Expected: exit 0.

- [ ] **Step 2: Run tests**

```bash
bun run test
```

Expected: all existing tests pass.

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

Expected: exit 0.

- [ ] **Step 4: Run lint**

```bash
bun run lint
```

Expected: exit 0 or only pre-existing warnings.

- [ ] **Step 5: Run Next.js fixture build**

```bash
cd tests/fixtures/next-app
rm -rf node_modules .next
bun install --no-save
bun run build
cd ../../..
```

Expected: `next build` succeeds. **This is the proof that issue #163's primary parse error is fixed.**

- [ ] **Step 6: No commit** (gate check only)

If any step failed, fix before proceeding to Phase 2.

---

## Phase 2 — Carve out `src/core/`

Goal: relocate framework-agnostic files into `src/core/`. No behavior changes; existing exports continue to work via re-exports (we update package.json to point at the moved files, but the public surface is unchanged).

### Task 10: Add /core export to package.json (preparatory)

We'll add the export entry now so subsequent moves can validate against it incrementally.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the /core entry to exports**

Insert into the `exports` map (alphabetically, near the top):

```jsonc
"./core": {
  "types": "./dist/core/index.d.ts",
  "import": "./dist/core/index.js",
  "require": "./dist/core/index.cjs"
},
```

- [ ] **Step 2: Add core entries to tsup.config.ts**

In `tsup.config.ts`, add to the `entry` array:

```
"src/core/index.ts",
"src/core/cms/index.ts",
"src/core/sdk/index.ts",
"src/core/sdk/*.ts",
"src/core/sdk/otelAdapters/*.ts",
"src/core/admin/index.ts",
"src/core/matchers/builtins.ts",
"src/core/matchers/posthog.ts",
"src/core/types/index.ts",
"src/core/types/widgets.ts",
"src/core/runtime/index.ts",
"src/core/runtime/*.ts",
```

These directories don't exist yet — that's fine; tsup tolerates missing globs and the entries get matched after the moves in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add package.json tsup.config.ts
git commit -m "chore(exports): pre-register /core tier in package.json + tsup"
```

---

### Task 11: Create src/core/runtime/requestStore.ts (RequestStore interface)

This is the abstraction that lets `core/` exist without `node:async_hooks`. **Behavioral change** — TDD.

**Files:**
- Create: `src/core/runtime/requestStore.ts`
- Create: `src/core/runtime/requestStore.test.ts`
- Create: `src/core/runtime/index.ts`

- [ ] **Step 1: Write the failing test**

`src/core/runtime/requestStore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { noopRequestStore, type RequestStore } from "./requestStore";

describe("noopRequestStore", () => {
  it("get() returns undefined when nothing is stored", () => {
    expect(noopRequestStore.get()).toBeUndefined();
  });

  it("run() invokes the callback and returns its result", () => {
    const result = noopRequestStore.run({ foo: 1 }, () => "ok");
    expect(result).toBe("ok");
  });

  it("get() inside run() still returns undefined (noop)", () => {
    let observed: unknown = "untouched";
    noopRequestStore.run({ bar: 2 }, () => {
      observed = noopRequestStore.get();
    });
    expect(observed).toBeUndefined();
  });

  it("RequestStore is a generic interface", () => {
    const store: RequestStore<{ x: number }> = noopRequestStore as RequestStore<{ x: number }>;
    expect(store.get()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
bunx vitest run src/core/runtime/requestStore.test.ts
```

Expected: fails because `./requestStore` doesn't exist.

- [ ] **Step 3: Create requestStore.ts with minimal implementation**

`src/core/runtime/requestStore.ts`:

```ts
/**
 * Per-request context storage abstraction.
 *
 * Implementations may use AsyncLocalStorage (Node), explicit-pass (Next.js),
 * or no-op (client / non-server contexts). Decoupled here so framework-
 * agnostic core code never imports `node:async_hooks`.
 */
export interface RequestStore<T> {
  /** Returns the current value if inside a `run()` scope, else undefined. */
  get(): T | undefined;
  /** Invokes `fn` with the value made available via `get()` inside its scope. */
  run<R>(value: T, fn: () => R): R;
}

class NoopRequestStore implements RequestStore<unknown> {
  get(): undefined {
    return undefined;
  }
  run<R>(_value: unknown, fn: () => R): R {
    return fn();
  }
}

export const noopRequestStore: RequestStore<unknown> = new NoopRequestStore();
```

- [ ] **Step 4: Run test to verify pass**

```bash
bunx vitest run src/core/runtime/requestStore.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Create runtime/index.ts barrel**

`src/core/runtime/index.ts`:

```ts
export { noopRequestStore, type RequestStore } from "./requestStore";
```

- [ ] **Step 6: Commit**

```bash
git add src/core/runtime
git commit -m "feat(core): add RequestStore interface and noop implementation"
```

---

### Task 12: Move `src/sdk/*` framework-agnostic files into `src/core/sdk/`

This is a large mechanical relocation. Group by movement to keep commits coherent. **No code changes inside files** — only `git mv` and import-path updates.

The framework-agnostic sdk files (those that do NOT import `@tanstack/*` or use `node:async_hooks` directly):

- `clx.ts`, `cn.ts`, `cn.test.ts`
- `signal.ts` (uses `@tanstack/store`, but that's a peer dep with no runtime; allowed in core)
- `encoding.ts`, `encoding.test.ts`
- `http.ts`, `http.test.ts`
- `cookie.ts`, `cookie.test.ts`
- `retry.ts`
- `useId.ts`
- `crypto.ts`
- `urlUtils.ts`
- `normalizeUrls.ts`
- `mergeCacheControl.ts`
- `cacheHeaders.ts`
- `sitemap.ts`
- `redirects.ts`
- `abTesting.ts`
- `wrapCaughtErrors.ts`
- `csp.ts`
- `useDevice.ts`, `useDevice.test.ts`
- `useHydrated.ts`
- `useScript.ts`, `useScript.test.ts`
- `useSuggestions.ts`, `useSuggestions.test.ts`
- `analytics.ts`
- `composite.ts`, `composite.test.ts`
- `otel.ts`, `otel.test.ts`
- `otelAdapters.ts`, `otelAdapters.test.ts`
- `otelAdapters/clickhouseCollector.ts`
- `instrumentedFetch.ts`
- `logger.ts`, `logger.test.ts`
- `serverTimings.ts`
- `invoke.ts`, `invoke.test.ts`
- `djb2.ts`
- `env.ts`
- `htmlShell.ts`
- `index.ts` (barrel)

The TanStack-coupled ones stay in `src/sdk/` for now (moved in Phase 4):

- `workerEntry.ts`, `router.ts`, `createInvoke.ts`, `requestContext.ts`, `cookiePassthrough.ts`, `setupApps.ts`, `cachedLoader.ts`, `observability.ts` (uses ALS — see Task 19)

**Files:**
- Move: `src/sdk/{listed-above}` → `src/core/sdk/{same}`

- [ ] **Step 1: Verify no TanStack imports in the files to move**

```bash
for f in src/sdk/clx.ts src/sdk/cn.ts src/sdk/signal.ts src/sdk/encoding.ts \
         src/sdk/http.ts src/sdk/cookie.ts src/sdk/retry.ts src/sdk/useId.ts \
         src/sdk/crypto.ts src/sdk/urlUtils.ts src/sdk/normalizeUrls.ts \
         src/sdk/mergeCacheControl.ts src/sdk/cacheHeaders.ts src/sdk/sitemap.ts \
         src/sdk/redirects.ts src/sdk/abTesting.ts src/sdk/wrapCaughtErrors.ts \
         src/sdk/csp.ts src/sdk/useDevice.ts src/sdk/useHydrated.ts \
         src/sdk/useScript.ts src/sdk/useSuggestions.ts src/sdk/analytics.ts \
         src/sdk/composite.ts src/sdk/otel.ts src/sdk/otelAdapters.ts \
         src/sdk/otelAdapters/clickhouseCollector.ts src/sdk/instrumentedFetch.ts \
         src/sdk/logger.ts src/sdk/serverTimings.ts src/sdk/invoke.ts \
         src/sdk/djb2.ts src/sdk/env.ts src/sdk/htmlShell.ts; do
  if [ -f "$f" ]; then
    if grep -E '@tanstack/(react-start|react-router)' "$f"; then
      echo "  ↑ TANSTACK IMPORT IN $f"
    fi
  fi
done
echo "scan done"
```

Expected: only `scan done`. If any line precedes it, that file must NOT be moved (escalate to plan author).

- [ ] **Step 2: Create target directory and move with git mv**

```bash
mkdir -p src/core/sdk/otelAdapters
git mv src/sdk/clx.ts src/core/sdk/clx.ts
git mv src/sdk/cn.ts src/core/sdk/cn.ts
git mv src/sdk/cn.test.ts src/core/sdk/cn.test.ts
git mv src/sdk/signal.ts src/core/sdk/signal.ts
git mv src/sdk/encoding.ts src/core/sdk/encoding.ts
git mv src/sdk/encoding.test.ts src/core/sdk/encoding.test.ts
git mv src/sdk/http.ts src/core/sdk/http.ts
git mv src/sdk/http.test.ts src/core/sdk/http.test.ts
git mv src/sdk/cookie.ts src/core/sdk/cookie.ts
git mv src/sdk/cookie.test.ts src/core/sdk/cookie.test.ts
git mv src/sdk/retry.ts src/core/sdk/retry.ts
git mv src/sdk/useId.ts src/core/sdk/useId.ts
git mv src/sdk/crypto.ts src/core/sdk/crypto.ts
git mv src/sdk/urlUtils.ts src/core/sdk/urlUtils.ts
git mv src/sdk/normalizeUrls.ts src/core/sdk/normalizeUrls.ts
git mv src/sdk/mergeCacheControl.ts src/core/sdk/mergeCacheControl.ts
git mv src/sdk/cacheHeaders.ts src/core/sdk/cacheHeaders.ts
git mv src/sdk/sitemap.ts src/core/sdk/sitemap.ts
git mv src/sdk/redirects.ts src/core/sdk/redirects.ts
git mv src/sdk/abTesting.ts src/core/sdk/abTesting.ts
git mv src/sdk/wrapCaughtErrors.ts src/core/sdk/wrapCaughtErrors.ts
git mv src/sdk/csp.ts src/core/sdk/csp.ts
git mv src/sdk/useDevice.ts src/core/sdk/useDevice.ts
git mv src/sdk/useDevice.test.ts src/core/sdk/useDevice.test.ts
git mv src/sdk/useHydrated.ts src/core/sdk/useHydrated.ts
git mv src/sdk/useScript.ts src/core/sdk/useScript.ts
git mv src/sdk/useScript.test.ts src/core/sdk/useScript.test.ts
git mv src/sdk/useSuggestions.ts src/core/sdk/useSuggestions.ts
git mv src/sdk/useSuggestions.test.ts src/core/sdk/useSuggestions.test.ts
git mv src/sdk/analytics.ts src/core/sdk/analytics.ts
git mv src/sdk/composite.ts src/core/sdk/composite.ts
git mv src/sdk/composite.test.ts src/core/sdk/composite.test.ts
git mv src/sdk/otel.ts src/core/sdk/otel.ts
git mv src/sdk/otel.test.ts src/core/sdk/otel.test.ts
git mv src/sdk/otelAdapters.ts src/core/sdk/otelAdapters.ts
git mv src/sdk/otelAdapters.test.ts src/core/sdk/otelAdapters.test.ts
git mv src/sdk/otelAdapters/clickhouseCollector.ts src/core/sdk/otelAdapters/clickhouseCollector.ts
git mv src/sdk/instrumentedFetch.ts src/core/sdk/instrumentedFetch.ts
git mv src/sdk/logger.ts src/core/sdk/logger.ts
git mv src/sdk/logger.test.ts src/core/sdk/logger.test.ts
git mv src/sdk/serverTimings.ts src/core/sdk/serverTimings.ts
git mv src/sdk/invoke.ts src/core/sdk/invoke.ts
git mv src/sdk/invoke.test.ts src/core/sdk/invoke.test.ts
git mv src/sdk/djb2.ts src/core/sdk/djb2.ts
git mv src/sdk/env.ts src/core/sdk/env.ts
git mv src/sdk/htmlShell.ts src/core/sdk/htmlShell.ts
```

- [ ] **Step 3: Move the index barrel**

```bash
git mv src/sdk/index.ts src/core/sdk/index.ts
```

(The barrel re-exports from sibling files; since they all moved together with relative imports preserved, no edit is needed.)

- [ ] **Step 4: Find broken imports**

```bash
bun run typecheck 2>&1 | head -80
```

Expected: many "Cannot find module" errors pointing at `src/sdk/<file>` from outside files (e.g., `src/cms/`, `src/admin/`, `src/hooks/`, `src/middleware/`, `src/routes/`).

- [ ] **Step 5: Rewrite imports outside src/core to point at src/core/sdk/**

Use a single sed-style rewrite. For each pattern, run:

```bash
# Rewrite relative imports from src/cms/, src/admin/, src/hooks/, src/middleware/, src/routes/ etc.
# Pattern: ../sdk/<name> → ../core/sdk/<name>
# Pattern: ../../sdk/<name> → ../../core/sdk/<name> (for nested files like src/sdk/otelAdapters/)
```

Use the Edit tool or this script:

```bash
# Rewrite any "../sdk/<name>" → "../core/sdk/<name>" inside files NOT under src/core
# (run from repo root)
node -e '
const fs = require("fs");
const path = require("path");
const root = "src";
const moved = new Set([
  "clx","cn","signal","encoding","http","cookie","retry","useId","crypto",
  "urlUtils","normalizeUrls","mergeCacheControl","cacheHeaders","sitemap",
  "redirects","abTesting","wrapCaughtErrors","csp","useDevice","useHydrated",
  "useScript","useSuggestions","analytics","composite","otel","otelAdapters",
  "instrumentedFetch","logger","serverTimings","invoke","djb2","env","htmlShell"
]);
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (full.startsWith("src/core")) continue;
      walk(full);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      let src = fs.readFileSync(full, "utf8");
      const orig = src;
      // ../sdk/<name>(/x)? → ../core/sdk/<name>(/x)?
      src = src.replace(/(\.{1,2}\/)+sdk\/([\w-]+)/g, (m, prefix, name) => {
        if (moved.has(name) || name === "index" || name === "otelAdapters") {
          // Compute new prefix: caller already uses prefix to climb to src/, then sdk/.
          // Inserting "core/" between requires we know the caller's depth.
          // Simpler: just prefix path with "core/" inside the relative.
          return prefix + "core/sdk/" + name;
        }
        return m;
      });
      if (src !== orig) {
        fs.writeFileSync(full, src);
        console.log("rewrote", full);
      }
    }
  }
}
walk(root);
'
```

- [ ] **Step 6: Re-run typecheck**

```bash
bun run typecheck 2>&1 | head -40
```

Expected: import errors related to sdk/* moves should be gone. Some may remain (for files that still need moving in later tasks). Document remaining errors but proceed if they're all `src/cms/*`, `src/admin/*`, etc. issues that will be resolved later (none should remain at this point — only sdk/* was moved, and other files referenced sdk/* by name; if other-folder errors remain, the sed didn't fix them — investigate manually).

- [ ] **Step 7: Build and run tests**

```bash
rm -rf dist
bun run build 2>&1 | tail -20
bun run test 2>&1 | tail -20
```

Expected: build and tests pass.

- [ ] **Step 8: Run Next.js fixture build**

```bash
cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: passes (the fixture's smoke page should still resolve `@decocms/start/sdk/cacheHeaders` correctly because `package.json` exports were updated in Task 5… **wait** — they still point at `dist/sdk/cacheHeaders.*`, but tsup now emits to `dist/core/sdk/cacheHeaders.*`. We need to update package.json exports too).

- [ ] **Step 9: Update package.json exports for moved sdk files**

For every entry under `./sdk/<name>` (and `./sdk` itself), repoint:

- `"./dist/sdk/<name>.d.ts"` → `"./dist/core/sdk/<name>.d.ts"`
- `"./dist/sdk/<name>.js"` → `"./dist/core/sdk/<name>.js"`
- `"./dist/sdk/<name>.cjs"` → `"./dist/core/sdk/<name>.cjs"`

And for `./sdk/otelAdapters/clickhouseCollector`, repoint to `./dist/core/sdk/otelAdapters/clickhouseCollector.*`.

Leave the entries for `./sdk/workerEntry`, `./sdk/router`, `./sdk/createInvoke`, `./sdk/requestContext`, `./sdk/cookiePassthrough`, `./sdk/setupApps`, `./sdk/cachedLoader`, `./sdk/observability` pointing at `./dist/sdk/<name>.*` for now — they'll move in Phase 4.

(Use the Edit tool with multiple string replacements; this is mechanical.)

- [ ] **Step 10: Re-run build and Next.js fixture**

```bash
rm -rf dist && bun run build && cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: both succeed.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor(core): move framework-agnostic sdk/* into core/sdk/"
```

---

### Task 13: Move `src/cms/` into `src/core/cms/`

**Files:**
- Move: `src/cms/*` → `src/core/cms/*`

- [ ] **Step 1: git mv all cms files**

```bash
mkdir -p src/core/cms
git mv src/cms/applySectionConventions.ts src/core/cms/applySectionConventions.ts
git mv src/cms/index.ts src/core/cms/index.ts
git mv src/cms/loader.ts src/core/cms/loader.ts
git mv src/cms/registry.ts src/core/cms/registry.ts
git mv src/cms/registry.test.ts src/core/cms/registry.test.ts
git mv src/cms/resolve.ts src/core/cms/resolve.ts
git mv src/cms/resolve.test.ts src/core/cms/resolve.test.ts
git mv src/cms/sectionLoaders.ts src/core/cms/sectionLoaders.ts
git mv src/cms/sectionLoaders.test.ts src/core/cms/sectionLoaders.test.ts
git mv src/cms/sectionMixins.ts src/core/cms/sectionMixins.ts
git mv src/cms/sectionMixins.test.ts src/core/cms/sectionMixins.test.ts
```

- [ ] **Step 2: Rewrite imports outside src/core/ that point to ../cms/ or ./cms/**

Use the Grep tool first to find them:

```bash
bun run typecheck 2>&1 | grep "Cannot find module" | head -40
```

Then run a similar Node script as in Task 12, replacing `sdk` patterns with `cms`:

```bash
node -e '
const fs = require("fs");
const path = require("path");
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (full.startsWith("src/core")) continue;
      walk(full);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      let src = fs.readFileSync(full, "utf8");
      const orig = src;
      src = src.replace(/(\.{1,2}\/)+cms\/([\w-]+)/g, (m, prefix, name) => prefix + "core/cms/" + name);
      // also handle `from "../cms"` (no trailing path)
      src = src.replace(/from\s+(["'\''])((?:\.{1,2}\/)+)cms\1/g, (m, q, prefix) => `from ${q}${prefix}core/cms${q}`);
      if (src !== orig) {
        fs.writeFileSync(full, src);
        console.log("rewrote", full);
      }
    }
  }
}
walk("src");
'
```

- [ ] **Step 3: Rewrite imports INSIDE moved cms files that point to ../sdk/**

The files just moved from `src/cms/` to `src/core/cms/`, so any `../sdk/<name>` imports now need to become `../sdk/<name>` (still relative within `core/`) — but Task 12 already moved sdk into `src/core/sdk/`, so the relative path `../sdk/<name>` from `src/core/cms/foo.ts` correctly resolves to `src/core/sdk/<name>`. Confirm:

```bash
bun run typecheck 2>&1 | head -20
```

Expected: any errors point at the *not-yet-moved* parts (admin, matchers, types) or are gone.

- [ ] **Step 4: Update package.json `./cms` export**

Change:
```jsonc
"./cms": {
  "types": "./dist/cms/index.d.ts",
  "import": "./dist/cms/index.js",
  "require": "./dist/cms/index.cjs"
}
```
to:
```jsonc
"./cms": {
  "types": "./dist/core/cms/index.d.ts",
  "import": "./dist/core/cms/index.js",
  "require": "./dist/core/cms/index.cjs"
}
```

- [ ] **Step 5: Build, test, fixture**

```bash
rm -rf dist && bun run build && bun run test && cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(core): move cms/ into core/cms/"
```

---

### Task 14: Move `src/admin/`, `src/matchers/`, `src/types/` into `src/core/`

**Files:**
- Move: `src/admin/*` → `src/core/admin/*`
- Move: `src/matchers/*` → `src/core/matchers/*`
- Move: `src/types/*` → `src/core/types/*`

- [ ] **Step 1: git mv**

```bash
mkdir -p src/core/admin src/core/matchers src/core/types
for f in src/admin/*; do git mv "$f" "src/core/admin/$(basename "$f")"; done
for f in src/matchers/*; do git mv "$f" "src/core/matchers/$(basename "$f")"; done
for f in src/types/*; do git mv "$f" "src/core/types/$(basename "$f")"; done
```

- [ ] **Step 2: Rewrite imports OUTSIDE src/core/**

```bash
node -e '
const fs = require("fs");
const path = require("path");
const targets = ["admin","matchers","types"];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (full.startsWith("src/core")) continue;
      walk(full);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      let src = fs.readFileSync(full, "utf8");
      const orig = src;
      for (const t of targets) {
        const re1 = new RegExp(`(\\.{1,2}\\/)+${t}\\/([\\w-]+)`, "g");
        src = src.replace(re1, (m, prefix, name) => prefix + "core/" + t + "/" + name);
        const re2 = new RegExp(`from\\s+(["'\''])((?:\\.{1,2}\\/)+)${t}\\1`, "g");
        src = src.replace(re2, (m, q, prefix) => `from ${q}${prefix}core/${t}${q}`);
      }
      if (src !== orig) {
        fs.writeFileSync(full, src);
        console.log("rewrote", full);
      }
    }
  }
}
walk("src");
'
```

- [ ] **Step 3: Rewrite imports INSIDE moved files that referenced sdk/cms/etc.**

Inside `src/core/admin/`, `src/core/matchers/`, `src/core/types/`, any `../sdk/<x>` or `../cms/<x>` reference must become `../sdk/<x>` or `../cms/<x>` — which is correct because those moved into `src/core/` too. Verify:

```bash
bun run typecheck 2>&1 | head -40
```

Fix any remaining errors manually with the Edit tool.

- [ ] **Step 4: Update package.json exports**

For each of `./admin`, `./matchers/builtins`, `./matchers/posthog`, `./types`, `./types/widgets`, repoint to `./dist/core/<rest>`:

```jsonc
"./admin":             { "types": "./dist/core/admin/index.d.ts",     "import": "./dist/core/admin/index.js",     "require": "./dist/core/admin/index.cjs" },
"./matchers/posthog":  { "types": "./dist/core/matchers/posthog.d.ts","import": "./dist/core/matchers/posthog.js","require": "./dist/core/matchers/posthog.cjs" },
"./matchers/builtins": { "types": "./dist/core/matchers/builtins.d.ts","import": "./dist/core/matchers/builtins.js","require": "./dist/core/matchers/builtins.cjs" },
"./types":             { "types": "./dist/core/types/index.d.ts",     "import": "./dist/core/types/index.js",     "require": "./dist/core/types/index.cjs" },
"./types/widgets":     { "types": "./dist/core/types/widgets.d.ts",   "import": "./dist/core/types/widgets.js",   "require": "./dist/core/types/widgets.cjs" }
```

- [ ] **Step 5: Build, test, fixture**

```bash
rm -rf dist && bun run build && bun run test && cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(core): move admin/, matchers/, types/ into core/"
```

---

### Task 15: Create `src/core/index.ts` barrel

**Files:**
- Create: `src/core/index.ts`

- [ ] **Step 1: Write the barrel**

```ts
/**
 * @decocms/start/core — framework-agnostic surface.
 *
 * No imports from @tanstack/*, next/*, or top-level node:async_hooks.
 * Safe to use from any host (TanStack, Next.js, plain Node, browsers).
 */

// CMS resolution & registry
export * from "./cms/index";

// Admin protocol handlers (request/response via Web APIs only)
export * as admin from "./admin/index";

// Matchers
export * as matchers from "./matchers/builtins";

// Types
export * from "./types/index";

// SDK utilities
export * from "./sdk/index";

// Runtime abstractions
export { noopRequestStore, type RequestStore } from "./runtime/index";
```

- [ ] **Step 2: Build**

```bash
rm -rf dist && bun run build
test -f dist/core/index.js && test -f dist/core/index.cjs && test -f dist/core/index.d.ts && echo "ok"
```

Expected: prints `ok`.

- [ ] **Step 3: Quick sanity import in fixture**

Edit `tests/fixtures/next-app/app/_smoke/page.tsx` temporarily to also import from `@decocms/start/core`:

```tsx
import { cacheHeaders } from "@decocms/start/sdk/cacheHeaders";
import { findPageByPath } from "@decocms/start/core";

export default function SmokePage() {
  return <pre>{typeof cacheHeaders} / {typeof findPageByPath}</pre>;
}
```

- [ ] **Step 4: Build the fixture**

```bash
cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

If it fails on `node:async_hooks`, **revert the fixture page** to import only `@decocms/start/sdk/cacheHeaders` and document this as expected — `core/cms/loader.ts` still uses ALS at this point. Phase 3 fixes it.

```tsx
import { cacheHeaders } from "@decocms/start/sdk/cacheHeaders";
export default function SmokePage() { return <pre>{typeof cacheHeaders}</pre>; }
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): add core/index.ts barrel"
```

---

### Task 16: Phase 2 validation gate

- [ ] **Step 1: Full check**

```bash
rm -rf dist
bun run check
bun run test
bun run build
cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: all green.

- [ ] **Step 2: Verify directory structure**

```bash
ls src/core
```

Expected: `admin  cms  index.ts  matchers  runtime  sdk  types`

```bash
ls src/sdk 2>/dev/null
```

Expected: only TanStack-coupled files remain (workerEntry, router, createInvoke, requestContext, cookiePassthrough, setupApps, cachedLoader, observability) — moved in Phase 4.

```bash
test ! -d src/cms && test ! -d src/admin && test ! -d src/matchers && test ! -d src/types && echo "ok"
```

Expected: prints `ok`.

---

## Phase 3 — RequestStore wiring & `node:async_hooks` purge from `core/`

Goal: replace direct `AsyncLocalStorage` usage in `core/cms/loader.ts` with the `RequestStore` interface. The TanStack tier supplies an ALS-backed store; the Next.js tier supplies an explicit-pass store. **After this phase, `src/core/` contains zero references to `node:async_hooks`.**

### Task 17: Identify all current ALS usage in core

- [ ] **Step 1: Grep for AsyncLocalStorage and node:async_hooks references in src/core/**

Use Grep on `src/core/`:

Pattern: `node:async_hooks`
Glob: `src/core/**/*.ts`

And:

Pattern: `AsyncLocalStorage`
Glob: `src/core/**/*.ts`

Expected: hits in `src/core/cms/loader.ts` (graceful fallback for blocks override). Document line numbers. (`src/sdk/requestContext.ts`, `src/middleware/observability.ts` are NOT in `core/` — they remain in `src/sdk/` and `src/middleware/` respectively at this point.)

- [ ] **Step 2: No commit** (read-only).

---

### Task 18: Refactor `src/core/cms/loader.ts` to use RequestStore

The current `loader.ts` uses a graceful-fallback ALS pattern for blocks override. Replace with explicit `RequestStore` injection.

**Files:**
- Modify: `src/core/cms/loader.ts`
- Modify: `src/core/cms/registry.test.ts` (or create new `loader.test.ts` if needed)

- [ ] **Step 1: Read current loader.ts**

Use the Read tool on `src/core/cms/loader.ts`. Identify the ALS code block (around lines 1, 32-35 per the survey).

- [ ] **Step 2: Write a failing test for blocks-override behavior with explicit RequestStore**

Create `src/core/cms/loader.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  setBlocksOverrideStore,
  withBlocksOverride,
  getActiveBlocksOverride,
} from "./loader";
import type { RequestStore } from "../runtime/requestStore";

class TestStore<T> implements RequestStore<T> {
  private current: T | undefined;
  get() { return this.current; }
  run<R>(value: T, fn: () => R): R {
    const prev = this.current;
    this.current = value;
    try { return fn(); } finally { this.current = prev; }
  }
}

describe("blocks override store", () => {
  it("withBlocksOverride exposes the override inside the callback", () => {
    const store = new TestStore<Record<string, unknown>>();
    setBlocksOverrideStore(store);
    const override = { foo: "bar" } as Record<string, unknown>;
    let observed: Record<string, unknown> | undefined;
    withBlocksOverride(override, () => {
      observed = getActiveBlocksOverride();
    });
    expect(observed).toEqual(override);
  });

  it("getActiveBlocksOverride returns undefined outside withBlocksOverride", () => {
    const store = new TestStore<Record<string, unknown>>();
    setBlocksOverrideStore(store);
    expect(getActiveBlocksOverride()).toBeUndefined();
  });

  it("default store (noop) makes withBlocksOverride still execute fn", () => {
    setBlocksOverrideStore(undefined);  // reset to default
    let executed = false;
    withBlocksOverride({ a: 1 }, () => { executed = true; });
    expect(executed).toBe(true);
  });
});
```

- [ ] **Step 3: Run failing test**

```bash
bunx vitest run src/core/cms/loader.test.ts
```

Expected: fails because `setBlocksOverrideStore`, `withBlocksOverride`, `getActiveBlocksOverride` may not exist with these exact names yet, or the AsyncLocalStorage internals diverge.

- [ ] **Step 4: Refactor loader.ts**

Replace the top-of-file ALS import and any `new AsyncLocalStorage()` calls with:

```ts
// At the top — REMOVE any "import * as asyncHooks from 'node:async_hooks'" or "AsyncLocalStorage"
import {
  noopRequestStore,
  type RequestStore,
} from "../runtime/requestStore";

let blocksOverrideStore: RequestStore<Record<string, unknown>> = noopRequestStore as RequestStore<Record<string, unknown>>;

export function setBlocksOverrideStore(
  store: RequestStore<Record<string, unknown>> | undefined,
): void {
  blocksOverrideStore = store ?? (noopRequestStore as RequestStore<Record<string, unknown>>);
}

export function withBlocksOverride<R>(
  override: Record<string, unknown>,
  fn: () => R,
): R {
  return blocksOverrideStore.run(override, fn);
}

export function getActiveBlocksOverride(): Record<string, unknown> | undefined {
  return blocksOverrideStore.get();
}
```

Then update any internal callers in `loader.ts` that previously did:

```ts
const override = blocksOverrideAls?.getStore();
```

to:

```ts
const override = getActiveBlocksOverride();
```

(Use Read to see the exact existing names; rename internal calls to the new exported names.)

- [ ] **Step 5: Run test to verify pass**

```bash
bunx vitest run src/core/cms/loader.test.ts
```

Expected: 3 passing.

- [ ] **Step 6: Verify no node:async_hooks reference remains in core**

Use Grep:

Pattern: `node:async_hooks|AsyncLocalStorage`
Glob: `src/core/**/*.ts`

Expected: zero hits.

- [ ] **Step 7: Build, full tests**

```bash
rm -rf dist && bun run build && bun run test
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(core): inject RequestStore into cms/loader.ts (purge node:async_hooks)"
```

---

### Task 19: Add `src/tanstack/runtime/alsRequestStore.ts` (ALS-backed impl)

This lives in the TanStack tier (which is allowed to use `node:async_hooks`). Sites running on TanStack/Cloudflare Workers wire this in at app boot.

**Files:**
- Create: `src/tanstack/runtime/alsRequestStore.ts`
- Create: `src/tanstack/runtime/alsRequestStore.test.ts`
- Create: `src/tanstack/runtime/index.ts`

- [ ] **Step 1: Write failing test**

`src/tanstack/runtime/alsRequestStore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createAlsRequestStore } from "./alsRequestStore";

describe("alsRequestStore", () => {
  it("isolates values across run() scopes", () => {
    const store = createAlsRequestStore<{ x: number }>();
    let outer: { x: number } | undefined;
    let inner: { x: number } | undefined;
    store.run({ x: 1 }, () => {
      outer = store.get();
      store.run({ x: 2 }, () => {
        inner = store.get();
      });
    });
    expect(outer).toEqual({ x: 1 });
    expect(inner).toEqual({ x: 2 });
  });

  it("get() returns undefined outside run()", () => {
    const store = createAlsRequestStore<string>();
    expect(store.get()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
bunx vitest run src/tanstack/runtime/alsRequestStore.test.ts
```

Expected: fails because file doesn't exist.

- [ ] **Step 3: Create alsRequestStore.ts**

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestStore } from "../../core/runtime/requestStore";

class AlsRequestStore<T> implements RequestStore<T> {
  private als = new AsyncLocalStorage<T>();
  get(): T | undefined {
    return this.als.getStore();
  }
  run<R>(value: T, fn: () => R): R {
    return this.als.run(value, fn);
  }
}

export function createAlsRequestStore<T>(): RequestStore<T> {
  return new AlsRequestStore<T>();
}
```

- [ ] **Step 4: Create runtime/index.ts**

```ts
export { createAlsRequestStore } from "./alsRequestStore";
```

- [ ] **Step 5: Run test to verify pass**

```bash
bunx vitest run src/tanstack/runtime/alsRequestStore.test.ts
```

Expected: 2 passing.

- [ ] **Step 6: Commit**

```bash
git add src/tanstack/runtime
git commit -m "feat(tanstack): add ALS-backed RequestStore implementation"
```

---

### Task 20: Wire ALS store into TanStack's blocks-override path

`src/admin/render.ts` (now `src/core/admin/render.ts`) and any other site that calls `withBlocksOverride` needs the TanStack-side wiring to install the ALS store. Find the wiring point.

**Files:**
- Modify: `src/core/admin/render.ts` (or wherever the existing `withBlocksOverride` is initialized)
- Modify: `src/tanstack/setup.ts` (if it exists) or the TanStack barrel

- [ ] **Step 1: Find existing initialization point**

Use Grep:

Pattern: `withBlocksOverride|blocksOverrideAls`
Glob: `src/**/*.ts`

Expected: `src/core/cms/loader.ts` (the new exports), and consumer sites in `src/core/admin/render.ts`.

- [ ] **Step 2: Add a TanStack-tier setup file that installs ALS store**

Create `src/tanstack/setup.ts` (or modify if already exists — there is `src/setup.ts` at root from the survey; that file becomes `src/tanstack/setup.ts` in Phase 4. For now create a new one at the TanStack tier without moving the existing yet):

```ts
import { setBlocksOverrideStore } from "../core/cms/loader";
import { createAlsRequestStore } from "./runtime/alsRequestStore";

let installed = false;

/**
 * Install ALS-backed runtime stores for the TanStack/Cloudflare Worker host.
 * Idempotent — safe to call multiple times.
 */
export function installTanStackRuntime(): void {
  if (installed) return;
  installed = true;
  setBlocksOverrideStore(createAlsRequestStore<Record<string, unknown>>());
}
```

- [ ] **Step 3: Call it from worker entry**

Use Read on `src/sdk/workerEntry.ts` to find the entry point. At the top of the exported `createDecoWorkerEntry` function (or near the top of the module), add:

```ts
import { installTanStackRuntime } from "../tanstack/setup";

// ... at module top, before any handler runs:
installTanStackRuntime();
```

(Use Edit on the specific file with the precise import and call.)

- [ ] **Step 4: Build and test**

```bash
rm -rf dist && bun run build && bun run test
```

Expected: pass. The TanStack-tied tests still get ALS behavior because `installTanStackRuntime()` runs on worker boot.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tanstack): install ALS-backed RequestStore at worker boot"
```

---

### Task 21: Verify Next.js fixture can now import core/cms safely

The whole point of Phase 3.

**Files:**
- Modify: `tests/fixtures/next-app/app/_smoke/page.tsx`

- [ ] **Step 1: Re-enable the full CMS import**

```tsx
import { findPageByPath, registerSectionsSync } from "@decocms/start/cms";
import { cacheHeaders } from "@decocms/start/sdk/cacheHeaders";

export default async function SmokePage() {
  const types = [typeof findPageByPath, typeof registerSectionsSync, typeof cacheHeaders];
  return <pre>{JSON.stringify({ types }, null, 2)}</pre>;
}
```

- [ ] **Step 2: Build the fixture**

```bash
rm -rf dist && bun run build
cd tests/fixtures/next-app && rm -rf .next node_modules && bun install --no-save && bun run build && cd ../../..
```

Expected: passes. **This is the proof that gotcha #2 (`node:async_hooks` leak into client bundle) is fixed.**

If it fails with `UnhandledSchemeError: node:async_hooks`, run:

```bash
grep -r "node:async_hooks\|AsyncLocalStorage" dist/core/ 2>&1 || echo "clean"
```

Expected: prints `clean`. If hits remain, find which file in `src/core/**` is still importing ALS and fix.

- [ ] **Step 3: Commit fixture update**

```bash
git add tests/fixtures/next-app
git commit -m "test(next-fixture): exercise full CMS import (validates async_hooks purge)"
```

---

### Task 22: Phase 3 validation gate

- [ ] **Step 1: Final assertions**

```bash
# core/ has no node:async_hooks reference
grep -r "node:async_hooks\|AsyncLocalStorage" src/core/ 2>&1 || echo "core clean"
# core/ has no @tanstack imports
grep -rE "@tanstack/(react-start|react-router)" src/core/ 2>&1 || echo "core tanstack-free"
# tanstack/ has the ALS impl
test -f src/tanstack/runtime/alsRequestStore.ts && echo "ok"
```

Expected: prints `core clean`, `core tanstack-free`, `ok`.

- [ ] **Step 2: Build, test, fixture**

```bash
rm -rf dist && bun run build && bun run test
cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: all pass.

---

## Phase 4 — Carve out `src/tanstack/`

Goal: relocate TanStack-coupled files into `src/tanstack/`. Existing exports (`/routes`, `/hooks`, `/middleware`, `/sdk/workerEntry`, etc.) continue to work via re-pointed paths.

### Task 23: Move `src/routes/` into `src/tanstack/routes/`

**Files:**
- Move: `src/routes/*` → `src/tanstack/routes/*`

- [ ] **Step 1: git mv**

```bash
mkdir -p src/tanstack/routes
git mv src/routes/adminRoutes.ts src/tanstack/routes/adminRoutes.ts
git mv src/routes/cmsRoute.ts src/tanstack/routes/cmsRoute.ts
git mv src/routes/components.tsx src/tanstack/routes/components.tsx
git mv src/routes/index.ts src/tanstack/routes/index.ts
git mv src/routes/withSiteGlobals.test.ts src/tanstack/routes/withSiteGlobals.test.ts
git mv src/routes/withSiteGlobals.ts src/tanstack/routes/withSiteGlobals.ts
```

- [ ] **Step 2: Rewrite imports OUTSIDE src/tanstack/ pointing at routes/**

```bash
node -e '
const fs = require("fs");
const path = require("path");
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (full.startsWith("src/tanstack")) continue;
      walk(full);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      let src = fs.readFileSync(full, "utf8");
      const orig = src;
      src = src.replace(/(\.{1,2}\/)+routes\/([\w-]+)/g, (m, p, n) => p + "tanstack/routes/" + n);
      src = src.replace(/from\s+(["'\''])((?:\.{1,2}\/)+)routes\1/g, (m, q, p) => `from ${q}${p}tanstack/routes${q}`);
      if (src !== orig) {
        fs.writeFileSync(full, src);
        console.log("rewrote", full);
      }
    }
  }
}
walk("src");
'
```

- [ ] **Step 3: Rewrite imports INSIDE moved routes files**

The moved files were at `src/routes/` and now live at `src/tanstack/routes/`. Their relative imports (e.g., `../cms/`, `../core/cms/`, `../sdk/`) need to climb one extra level:

- `../cms/<x>` → `../../core/cms/<x>` (since cms moved to core/cms)
- `../core/cms/<x>` → `../../core/cms/<x>`
- `../sdk/<x>` → `../../core/sdk/<x>` (for moved sdk files) OR `../sdk/<x>` (for not-yet-moved TanStack sdk files — these will become `../sdk/` siblings within tanstack/, so we'll fix again in Task 26)
- `../hooks/<x>` → `../../hooks/<x>` for now (hooks moves in Task 24)
- `../middleware/<x>` → `../../middleware/<x>` for now (middleware moves in Task 25)
- `../admin/<x>` → `../../core/admin/<x>`
- `../matchers/<x>` → `../../core/matchers/<x>`
- `../types/<x>` → `../../core/types/<x>`
- `../core/<x>` → `../../core/<x>`

Use Read + Edit on each file to apply these transforms manually. Or use a more careful sed:

```bash
node -e '
const fs = require("fs");
const path = require("path");
const files = [
  "src/tanstack/routes/adminRoutes.ts",
  "src/tanstack/routes/cmsRoute.ts",
  "src/tanstack/routes/components.tsx",
  "src/tanstack/routes/index.ts",
  "src/tanstack/routes/withSiteGlobals.test.ts",
  "src/tanstack/routes/withSiteGlobals.ts",
];
const replaceMap = [
  // Single-up (../) → moved core dirs
  [/from\s+(["'\''])\.\.\/core\//g, "from $1../../core/"],
  [/from\s+(["'\''])\.\.\/cms\//g, "from $1../../core/cms/"],   // (already would have been rewritten in earlier task, this is a safety net)
  [/from\s+(["'\''])\.\.\/admin\//g, "from $1../../core/admin/"],
  [/from\s+(["'\''])\.\.\/matchers\//g, "from $1../../core/matchers/"],
  [/from\s+(["'\''])\.\.\/types\//g, "from $1../../core/types/"],
  [/from\s+(["'\''])\.\.\/types\1/g, "from $1../../core/types$1"],
  [/from\s+(["'\''])\.\.\/sdk\//g, "from $1../../core/sdk/"],   // see note below
  [/from\s+(["'\''])\.\.\/hooks\//g, "from $1../../hooks/"],   // hooks moves in Task 24
  [/from\s+(["'\''])\.\.\/middleware\//g, "from $1../../middleware/"], // middleware moves in Task 25
];
for (const f of files) {
  let src = fs.readFileSync(f, "utf8");
  const orig = src;
  for (const [re, rep] of replaceMap) src = src.replace(re, rep);
  if (src !== orig) {
    fs.writeFileSync(f, src);
    console.log("rewrote", f);
  }
}
'
```

**Note on `../sdk/` rewrite:** Some sdk imports point at TanStack-coupled sdk files (e.g., `../sdk/workerEntry`, `../sdk/router`) that have NOT been moved yet. After the bulk rewrite above, those broken imports will surface as typecheck errors. Fix them by reverting the specific rewrites:

```bash
bun run typecheck 2>&1 | grep "Cannot find module '../../core/sdk/" | sort -u
```

For each module name in the output (e.g., `workerEntry`, `router`, `createInvoke`, `requestContext`, `cookiePassthrough`, `setupApps`, `cachedLoader`, `observability`), use Edit to revert `../../core/sdk/<name>` → `../../sdk/<name>` in the affected route files. (These rewrites will be fixed again in Task 26 when those sdk files move into `src/tanstack/sdk/`.)

- [ ] **Step 4: Build and typecheck**

```bash
rm -rf dist && bun run typecheck && bun run build
```

Expected: pass.

- [ ] **Step 5: Update package.json `./routes` export**

Change `./routes` to point at `./dist/tanstack/routes/index.*`.

- [ ] **Step 6: Update tsup.config.ts**

In `entry`, change `"src/routes/index.ts"` to `"src/tanstack/routes/index.ts"`.

- [ ] **Step 7: Build + fixture**

```bash
rm -rf dist && bun run build
cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(tanstack): move routes/ into tanstack/routes/"
```

---

### Task 24: Move `src/hooks/` into `src/tanstack/hooks/`

**Files:**
- Move: `src/hooks/*` → `src/tanstack/hooks/*`

- [ ] **Step 1: git mv**

```bash
mkdir -p src/tanstack/hooks
for f in src/hooks/*; do git mv "$f" "src/tanstack/hooks/$(basename "$f")"; done
```

- [ ] **Step 2: Rewrite imports OUTSIDE src/tanstack/**

```bash
node -e '
const fs = require("fs");
const path = require("path");
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (full.startsWith("src/tanstack")) continue;
      walk(full);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      let src = fs.readFileSync(full, "utf8");
      const orig = src;
      src = src.replace(/(\.{1,2}\/)+hooks\/([\w-]+)/g, (m, p, n) => p + "tanstack/hooks/" + n);
      if (src !== orig) {
        fs.writeFileSync(full, src);
        console.log("rewrote", full);
      }
    }
  }
}
walk("src");
'
```

- [ ] **Step 3: Rewrite imports INSIDE moved hooks files (climb one extra level)**

Apply analogous rewrites as Task 23 Step 3, scoped to `src/tanstack/hooks/*`. Specifically:

- `../sdk/<x>` (where x is in core/sdk) → `../../core/sdk/<x>`
- `../sdk/<x>` (where x is TanStack-coupled) → `../sdk/<x>` (will resolve once sdk moves in Task 26; for now revert the over-eager rewrite, similar to Task 23)
- `../core/<x>` → `../../core/<x>`
- `../routes/<x>` → `../routes/<x>` (already in tanstack/routes — relative siblings work; the regex above won't match this since it's inside src/tanstack)
- `../middleware/<x>` → `../../middleware/<x>` (until middleware moves in Task 25)
- `../admin/<x>` → `../../core/admin/<x>`
- `../matchers/<x>` → `../../core/matchers/<x>`
- `../types/<x>` → `../../core/types/<x>`

(Use the Node script pattern from Task 23 Step 3, adapted for `src/tanstack/hooks/*`.)

- [ ] **Step 4: Update package.json `./hooks` export**

Change `./hooks` to point at `./dist/tanstack/hooks/index.*`.

- [ ] **Step 5: Update tsup.config.ts**

`"src/hooks/index.ts"` → `"src/tanstack/hooks/index.ts"`

- [ ] **Step 6: Build, test, fixture**

```bash
rm -rf dist && bun run build && bun run test
cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(tanstack): move hooks/ into tanstack/hooks/"
```

---

### Task 25: Move `src/middleware/` into `src/tanstack/middleware/`

**Files:**
- Move: `src/middleware/*` → `src/tanstack/middleware/*`

- [ ] **Step 1: git mv**

```bash
mkdir -p src/tanstack/middleware
for f in src/middleware/*; do git mv "$f" "src/tanstack/middleware/$(basename "$f")"; done
```

- [ ] **Step 2: Rewrite imports OUTSIDE src/tanstack/**

Same pattern as Tasks 23–24, replacing `middleware` segment.

- [ ] **Step 3: Rewrite imports INSIDE moved middleware files**

Same pattern. Particular attention: `src/middleware/observability.ts` uses `AsyncLocalStorage` directly. Since we're moving it OUT of core's reach into `tanstack/middleware/`, the direct import is fine (TanStack tier may use `node:async_hooks`).

- [ ] **Step 4: Update package.json**

Repoint `./middleware`, `./middleware/healthMetrics`, `./middleware/hydrationContext`, `./middleware/validateSection` to `./dist/tanstack/middleware/<name>.*`.

- [ ] **Step 5: Update tsup.config.ts**

`"src/middleware/index.ts"` → `"src/tanstack/middleware/index.ts"`. Also remove any individual `src/middleware/*.ts` entries if they were listed and re-add as `src/tanstack/middleware/*.ts`.

- [ ] **Step 6: Build, test, fixture**

```bash
rm -rf dist && bun run build && bun run test
cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(tanstack): move middleware/ into tanstack/middleware/"
```

---

### Task 26: Move TanStack-coupled `src/sdk/*` files into `src/tanstack/sdk/`

The remaining TanStack-coupled sdk files: `workerEntry.ts`, `router.ts`, `createInvoke.ts`, `requestContext.ts`, `cookiePassthrough.ts`, `setupApps.ts`, `cachedLoader.ts`, `observability.ts`.

**Files:**
- Move: those eight files

- [ ] **Step 1: git mv**

```bash
mkdir -p src/tanstack/sdk
git mv src/sdk/workerEntry.ts src/tanstack/sdk/workerEntry.ts
git mv src/sdk/router.ts src/tanstack/sdk/router.ts
git mv src/sdk/createInvoke.ts src/tanstack/sdk/createInvoke.ts
git mv src/sdk/requestContext.ts src/tanstack/sdk/requestContext.ts
git mv src/sdk/cookiePassthrough.ts src/tanstack/sdk/cookiePassthrough.ts
git mv src/sdk/setupApps.ts src/tanstack/sdk/setupApps.ts
git mv src/sdk/cachedLoader.ts src/tanstack/sdk/cachedLoader.ts
git mv src/sdk/observability.ts src/tanstack/sdk/observability.ts
# Also remove the now-empty src/sdk directory if not already gone:
rmdir src/sdk 2>/dev/null || true
```

- [ ] **Step 2: Rewrite imports OUTSIDE src/tanstack/**

Pattern: `(../)+sdk/<one-of-the-eight>` → `(../)+tanstack/sdk/<name>`. The other sdk files already moved to core; that rewrite happened in Task 12.

```bash
node -e '
const fs = require("fs");
const path = require("path");
const tsModules = new Set([
  "workerEntry","router","createInvoke","requestContext",
  "cookiePassthrough","setupApps","cachedLoader","observability"
]);
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (full.startsWith("src/tanstack")) continue;
      walk(full);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      let src = fs.readFileSync(full, "utf8");
      const orig = src;
      src = src.replace(/(\.{1,2}\/)+sdk\/([\w-]+)/g, (m, prefix, name) => {
        if (tsModules.has(name)) return prefix + "tanstack/sdk/" + name;
        return m; // already-moved core sdk files
      });
      if (src !== orig) {
        fs.writeFileSync(full, src);
        console.log("rewrote", full);
      }
    }
  }
}
walk("src");
'
```

- [ ] **Step 3: Rewrite imports INSIDE moved tanstack sdk files**

Each moved file climbs one extra level when referencing core. Manually inspect and fix:

```bash
bun run typecheck 2>&1 | grep "Cannot find module" | head -40
```

Apply Edit calls for each broken import. Common fix-ups:

- `../core/<x>` → `../../core/<x>`
- `../routes/<x>` → `../routes/<x>` (siblings within tanstack)
- `../hooks/<x>` → `../hooks/<x>` (siblings)
- `../middleware/<x>` → `../middleware/<x>` (siblings)

- [ ] **Step 4: Update package.json exports**

Repoint these exports to `./dist/tanstack/sdk/<name>.*`:

- `./sdk/workerEntry`
- `./sdk/router`
- `./sdk/createInvoke`
- `./sdk/requestContext`
- `./sdk/cookiePassthrough`
- `./sdk/setupApps`
- `./sdk/cachedLoader`
- `./sdk/observability`

- [ ] **Step 5: Update tsup.config.ts entries**

In `tsup.config.ts`, change `"src/sdk/*.ts"` (which previously matched everything) to `"src/core/sdk/*.ts"` only, and add `"src/tanstack/sdk/*.ts"` as a separate entry. Also the `"src/sdk/otelAdapters/*.ts"` should already have become `"src/core/sdk/otelAdapters/*.ts"` in Task 12.

- [ ] **Step 6: Build, test, fixture**

```bash
rm -rf dist && bun run build && bun run test
cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(tanstack): move TanStack-coupled sdk files into tanstack/sdk/"
```

---

### Task 27: Move `src/apps/`, `src/daemon/`, `src/vite/` into `src/tanstack/`

These are TanStack-tied dev tooling. `src/apps/` uses TanStack request context; `src/daemon/` is the Vite-side dev daemon; `src/vite/plugin.js` is Vite-specific.

**Files:**
- Move: `src/apps/* → src/tanstack/apps/*`
- Move: `src/daemon/* → src/tanstack/daemon/*`
- Move: `src/vite/* → src/tanstack/vite/*`

- [ ] **Step 1: git mv**

```bash
mkdir -p src/tanstack/apps src/tanstack/daemon src/tanstack/vite
for f in src/apps/*; do git mv "$f" "src/tanstack/apps/$(basename "$f")"; done
for f in src/daemon/*; do git mv "$f" "src/tanstack/daemon/$(basename "$f")"; done
for f in src/vite/*; do git mv "$f" "src/tanstack/vite/$(basename "$f")"; done
```

- [ ] **Step 2: Rewrite imports OUTSIDE src/tanstack/**

Same pattern: `(../)+(apps|daemon|vite)/<x>` → `(../)+tanstack/(apps|daemon|vite)/<x>`.

- [ ] **Step 3: Rewrite imports INSIDE moved files**

Each climbs one extra level for any `../core/`, `../sdk/`, etc.

- [ ] **Step 4: Update package.json exports**

- `./apps` → `./dist/tanstack/apps/index.*`
- `./apps/autoconfig` → `./dist/tanstack/apps/autoconfig.*`
- `./daemon` → `./dist/tanstack/daemon/index.*`
- `./vite` → `./dist/tanstack/vite/plugin.{js,cjs}` (no `.d.ts`)

- [ ] **Step 5: Update tsup.config.ts**

Replace `"src/apps/*"`, `"src/daemon/index.ts"`, `"src/vite/plugin.js"` entries with `"src/tanstack/apps/*"`, `"src/tanstack/daemon/index.ts"`, `"src/tanstack/vite/plugin.js"`.

- [ ] **Step 6: Build, test, fixture**

```bash
rm -rf dist && bun run build && bun run test
cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(tanstack): move apps/, daemon/, vite/ into tanstack/"
```

---

### Task 28: Move `src/setup.ts` into `src/tanstack/setup.ts` (merge with Phase 3 stub)

Phase 3 created a NEW `src/tanstack/setup.ts` for `installTanStackRuntime`. The original `src/setup.ts` may have other content. Merge them.

**Files:**
- Read: `src/setup.ts`
- Modify: `src/tanstack/setup.ts`

- [ ] **Step 1: Read both files**

Use Read tool on `src/setup.ts` and `src/tanstack/setup.ts`.

- [ ] **Step 2: Merge content**

Combine the existing `src/setup.ts` exports with the `installTanStackRuntime` function from `src/tanstack/setup.ts`. Keep all existing exports.

- [ ] **Step 3: Delete old setup.ts**

```bash
git rm src/setup.ts
```

- [ ] **Step 4: Update package.json `./setup` export**

`./setup` → `./dist/tanstack/setup.*`

- [ ] **Step 5: Update tsup.config.ts**

`"src/setup.ts"` → `"src/tanstack/setup.ts"`. Add `"src/tanstack/runtime/*.ts"` to the entries.

- [ ] **Step 6: Rewrite consumers of `from "../setup"` etc.**

Use Grep:

Pattern: `from\s+["'](\.{1,2}/)+setup`
Glob: `src/**/*.ts*`

Update each match.

- [ ] **Step 7: Build, test, fixture**

```bash
rm -rf dist && bun run build && bun run test
cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(tanstack): merge setup.ts into tanstack/setup.ts"
```

---

### Task 29: Create `src/tanstack/index.ts` barrel and add /tanstack export

**Files:**
- Create: `src/tanstack/index.ts`
- Modify: `package.json`
- Modify: `tsup.config.ts`

- [ ] **Step 1: Write the barrel**

```ts
/**
 * @decocms/start/tanstack — TanStack Start adapter.
 *
 * CMS routes, hooks, middleware, vite plugin, worker entry. May import
 * @tanstack/* and node:async_hooks. Imports from /core; never from /next.
 */
export * from "./routes/index";
export * from "./hooks/index";
export * from "./middleware/index";
export { installTanStackRuntime } from "./setup";
export { createAlsRequestStore } from "./runtime/index";
```

- [ ] **Step 2: Add /tanstack export to package.json**

```jsonc
"./tanstack": {
  "types": "./dist/tanstack/index.d.ts",
  "import": "./dist/tanstack/index.js",
  "require": "./dist/tanstack/index.cjs"
}
```

- [ ] **Step 3: Add `src/tanstack/index.ts` to tsup.config.ts entries**

- [ ] **Step 4: Build, test, fixture**

```bash
rm -rf dist && bun run build && bun run test
cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tanstack): add tanstack/index.ts barrel and /tanstack export"
```

---

### Task 30: Update generator scripts for new paths

`scripts/generate-blocks.ts`, `scripts/generate-sections.ts` (if exists), `scripts/generate-schema.ts` may scan `src/sections/` (consumer-side, not affected) or reference `@decocms/start` paths internally. Update.

**Files:**
- Modify: `scripts/generate-blocks.ts`
- Modify: `scripts/generate-schema.ts`
- Modify: `scripts/generate-invoke.ts` (if it references moved paths)

- [ ] **Step 1: Read each script**

Use Read to find any references to `src/cms`, `src/admin`, `src/sdk`, `src/routes`, etc.

- [ ] **Step 2: Update path references**

Common fixes: `src/cms/` → `src/core/cms/`, etc.

- [ ] **Step 3: Run a generator end-to-end against a sample site (if possible)**

If there's a `run-migration` skill or sample site fixture available:

```bash
bun run scripts/generate-schema.ts --help 2>&1 | head -5
```

Just confirm the script still loads. Full integration test deferred.

- [ ] **Step 4: Build**

```bash
rm -rf dist && bun run build
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(scripts): update generator paths for new src/ tree"
```

---

### Task 31: Phase 4 validation gate

- [ ] **Step 1: Verify directory structure**

```bash
ls src
```

Expected: `core  index.ts  tanstack` (and possibly nothing else).

```bash
test ! -d src/sdk && test ! -d src/cms && test ! -d src/admin && \
test ! -d src/hooks && test ! -d src/middleware && test ! -d src/routes && \
test ! -d src/apps && test ! -d src/daemon && test ! -d src/vite && \
test ! -d src/matchers && test ! -d src/types && \
echo "ok"
```

Expected: prints `ok`.

- [ ] **Step 2: Build, test, fixture**

```bash
rm -rf dist && bun run check && bun run test
cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: all green.

- [ ] **Step 3: Update src/index.ts (top-level barrel)**

The top-level `src/index.ts` now lives alongside `src/core/` and `src/tanstack/`. Update it to re-export only `core` (keep top-level surface framework-agnostic):

```ts
export * from "./core/index";
```

```bash
rm -rf dist && bun run build
git add src/index.ts
git commit -m "refactor: top-level barrel re-exports core only"
```

---

## Phase 5 — `registerSectionsSync` fix (gotcha #1)

Goal: `getSection()` should find sync-registered sections.

### Task 32: Write failing test for getSection() finding sync-registered sections

**Files:**
- Modify: `src/core/cms/registry.test.ts`

- [ ] **Step 1: Read existing test file**

Use Read on `src/core/cms/registry.test.ts`.

- [ ] **Step 2: Append the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import {
  getSection,
  registerSectionsSync,
  resetRegistryForTests, // confirm this helper exists; if not, see Step 3 note
} from "./registry";

describe("registerSectionsSync ↔ getSection integration (gotcha #1)", () => {
  beforeEach(() => {
    if (typeof resetRegistryForTests === "function") resetRegistryForTests();
  });

  it("getSection() returns an entry for sync-registered sections", async () => {
    const FakeComponent = () => null;
    registerSectionsSync({
      "site/sections/Foo.tsx": FakeComponent,
    });
    const entry = getSection("site/sections/Foo.tsx");
    expect(entry).toBeDefined();
    // The fallback loader should resolve to the same module
    const mod = await entry!.loader();
    expect(mod.default).toBe(FakeComponent);
  });
});
```

**Note on `resetRegistryForTests`:** if the registry doesn't expose a reset helper, the test must instead use a fresh module instance per test or use `vi.resetModules()`. Check what exists; if neither, add `resetRegistryForTests` as part of this task (export from `src/core/cms/registry.ts`).

- [ ] **Step 3: Run failing test**

```bash
bunx vitest run src/core/cms/registry.test.ts -t "getSection"
```

Expected: fails — `getSection()` returns `undefined` because `registerSectionsSync` doesn't populate `registry`.

---

### Task 33: Implement registerSectionsSync registry-fallback

**Files:**
- Modify: `src/core/cms/registry.ts`

- [ ] **Step 1: Read registry.ts**

Use Read on `src/core/cms/registry.ts`. Locate `registerSectionsSync` (around line 186 per the survey) and `getSection` (around line 78).

- [ ] **Step 2: Modify registerSectionsSync to also register a trivial loader**

Inside `registerSectionsSync(sections)`, after the existing `syncComponents` and `resolvedComponents` writes, add:

```ts
// Also register a trivial async loader so getSection() (which reads `registry`)
// finds sync-registered sections. Fixes gotcha #1.
for (const [key, component] of Object.entries(sections)) {
  if (registry[key]) continue;  // don't clobber a real loader
  registry[key] = {
    loader: () => Promise.resolve({ default: component }),
    options: sectionOptions[key] ?? {},
  };
}
```

(Adjust `RegistryEntry` shape to match the actual one in the file.)

- [ ] **Step 3: Run test to verify pass**

```bash
bunx vitest run src/core/cms/registry.test.ts -t "getSection"
```

Expected: passing.

- [ ] **Step 4: Run full registry tests**

```bash
bunx vitest run src/core/cms/registry.test.ts
```

Expected: all passing (no regressions in existing tests).

- [ ] **Step 5: Run full test suite**

```bash
bun run test
```

Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add src/core/cms/registry.ts src/core/cms/registry.test.ts
git commit -m "fix(cms): registerSectionsSync also populates registry (gotcha #1)"
```

---

## Phase 6 — `loadCmsPagePure` + extended `MatcherContext`

Goal: provide a framework-agnostic `loadCmsPagePure(fullPath, ctx)` and `resolveDeferredSectionPure`. Refactor TanStack's `loadCmsPage` to delegate.

### Task 34: Extend `MatcherContext` type with optional `headers` and `request`

**Files:**
- Modify: `src/core/types/index.ts` (or wherever `MatcherContext` is defined)

- [ ] **Step 1: Find MatcherContext definition**

Use Grep:

Pattern: `interface MatcherContext|type MatcherContext`
Glob: `src/**/*.ts`

- [ ] **Step 2: Read the file**

Use Read on the matching file.

- [ ] **Step 3: Extend the type**

Add `headers?: Record<string, string>;` and `request?: Request;` as optional fields:

```ts
export interface MatcherContext {
  userAgent: string;
  url: string;
  path: string;
  cookies: Record<string, string>;
  /** Optional. Standard Web API request headers as a plain object. */
  headers?: Record<string, string>;
  /** Optional. Standard Web API Request — for matchers that need raw request access. */
  request?: Request;
}
```

- [ ] **Step 4: Build and typecheck**

```bash
rm -rf dist && bun run build && bun run typecheck
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): extend MatcherContext with optional headers and request"
```

---

### Task 35: Write failing test for `loadCmsPagePure`

**Files:**
- Create: `src/core/cms/loadCmsPagePure.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it, beforeEach, vi } from "vitest";
import { loadCmsPagePure } from "./loadCmsPagePure";
import type { MatcherContext } from "../types/index";

describe("loadCmsPagePure", () => {
  it("is a function with signature (fullPath, ctx)", () => {
    expect(typeof loadCmsPagePure).toBe("function");
    expect(loadCmsPagePure.length).toBe(2);
  });

  it("returns null for an unknown path", async () => {
    const ctx: MatcherContext = {
      userAgent: "vitest",
      url: "http://test.local/",
      path: "/",
      cookies: {},
    };
    // Without any blocks loaded, an unknown path returns null
    const result = await loadCmsPagePure("/this-path-does-not-exist", ctx);
    expect(result).toBeNull();
  });

  it("does not call any TanStack request primitives", async () => {
    // Sentinel: importing this module must not throw, and the function
    // body must not require getRequestUrl / getCookies / getRequest at runtime.
    const ctx: MatcherContext = {
      userAgent: "",
      url: "http://test.local/",
      path: "/",
      cookies: {},
    };
    // If the implementation accidentally calls getRequestUrl(), this would throw.
    await expect(loadCmsPagePure("/", ctx)).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
bunx vitest run src/core/cms/loadCmsPagePure.test.ts
```

Expected: fails because the file doesn't exist.

---

### Task 36: Implement `loadCmsPagePure`

**Files:**
- Create: `src/core/cms/loadCmsPagePure.ts`
- Read: `src/tanstack/routes/cmsRoute.ts` (to copy the body)

- [ ] **Step 1: Read cmsRoute.ts to understand `loadCmsPageInternal`**

Use Read on `src/tanstack/routes/cmsRoute.ts`. Identify `loadCmsPageInternal(fullPath: string)` — the function that takes a full path and returns a `DecoPageResult | null`.

Note all the calls it makes that depend on TanStack request context:
- `getRequestUrl()`
- `getCookies()`
- `getRequest()`
- `getRequestHeader(name)`
- `setResponseHeader(...)` (for `X-Deco-Cacheable`)

- [ ] **Step 2: Write loadCmsPagePure.ts**

```ts
import { resolveDecoPage } from "./resolve";
import { findPageByPath } from "./loader";
import type { MatcherContext } from "../types/index";

/**
 * Framework-agnostic page loader. Behaves identically to the TanStack
 * `loadCmsPage` server function but takes its inputs explicitly:
 * caller is responsible for building the `MatcherContext` and for setting
 * any response headers based on the returned cache metadata.
 *
 * Use this from any non-TanStack host (Next.js, Remix, plain Node, etc.).
 *
 * @returns `DecoPageResult` (resolved sections + SEO + cache metadata) or
 *          `null` if no page matches the path.
 */
export async function loadCmsPagePure(
  fullPath: string,
  ctx: MatcherContext,
): Promise<DecoPageResult | null> {
  const [basePath] = fullPath.split("?");
  const page = findPageByPath(basePath);
  if (!page) return null;
  return await resolveDecoPage(basePath, ctx, page);
}

export interface DecoPageResult {
  resolvedSections: unknown[];
  seoSection: unknown | null;
  deferredSections: unknown[];
  cacheMetadata: {
    cacheable: boolean;
    cacheControl?: string;
  };
}
```

**Note on signatures:** the actual `resolveDecoPage` signature in `src/core/cms/resolve.ts` may take different arguments. Read it first to confirm. The body above is the conceptual sketch; align field names and call shape with the real `resolve.ts`.

- [ ] **Step 3: Run test to verify pass**

```bash
bunx vitest run src/core/cms/loadCmsPagePure.test.ts
```

Expected: 3 passing.

- [ ] **Step 4: Export from cms/index.ts**

Add to `src/core/cms/index.ts`:

```ts
export { loadCmsPagePure } from "./loadCmsPagePure";
export type { DecoPageResult } from "./loadCmsPagePure";
```

- [ ] **Step 5: Build**

```bash
rm -rf dist && bun run build
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/cms/loadCmsPagePure.ts src/core/cms/loadCmsPagePure.test.ts src/core/cms/index.ts
git commit -m "feat(core): add loadCmsPagePure — framework-agnostic page loader"
```

---

### Task 37: Write & implement `resolveDeferredSectionPure`

**Files:**
- Create: `src/core/cms/resolveDeferredSectionPure.ts`
- Create: `src/core/cms/resolveDeferredSectionPure.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { resolveDeferredSectionPure } from "./resolveDeferredSectionPure";
import type { MatcherContext } from "../types/index";

describe("resolveDeferredSectionPure", () => {
  it("is a function (path, sectionKey, ctx, opts?)", () => {
    expect(typeof resolveDeferredSectionPure).toBe("function");
  });

  it("returns null for an unknown section", async () => {
    const ctx: MatcherContext = { userAgent: "", url: "http://t/", path: "/", cookies: {} };
    const r = await resolveDeferredSectionPure("/", "site/sections/DoesNotExist.tsx", ctx);
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
bunx vitest run src/core/cms/resolveDeferredSectionPure.test.ts
```

Expected: fails.

- [ ] **Step 3: Read TanStack's loadDeferredSection in src/tanstack/routes/cmsRoute.ts**

Use Read. Note its body (around line 198 per survey).

- [ ] **Step 4: Implement resolveDeferredSectionPure**

```ts
import { resolveDeferredSection } from "./resolve";
import type { MatcherContext } from "../types/index";

export async function resolveDeferredSectionPure(
  fullPath: string,
  sectionKey: string,
  ctx: MatcherContext,
  opts?: { rawProps?: unknown },
): Promise<ResolvedSection | null> {
  return await resolveDeferredSection(fullPath, sectionKey, ctx, opts);
}

export interface ResolvedSection {
  component: string;
  props: unknown;
}
```

(Align signature/types with the actual `resolveDeferredSection` in `src/core/cms/resolve.ts`.)

- [ ] **Step 5: Run test, build**

```bash
bunx vitest run src/core/cms/resolveDeferredSectionPure.test.ts
rm -rf dist && bun run build
```

Expected: tests pass, build green.

- [ ] **Step 6: Export from cms/index.ts and commit**

Add to `src/core/cms/index.ts`:

```ts
export { resolveDeferredSectionPure } from "./resolveDeferredSectionPure";
```

```bash
git add src/core/cms/resolveDeferredSectionPure.ts src/core/cms/resolveDeferredSectionPure.test.ts src/core/cms/index.ts
git commit -m "feat(core): add resolveDeferredSectionPure"
```

---

### Task 38: Refactor TanStack's `loadCmsPage` to delegate to `loadCmsPagePure`

**Files:**
- Modify: `src/tanstack/routes/cmsRoute.ts`

- [ ] **Step 1: Read cmsRoute.ts**

Identify the existing `loadCmsPageInternal(fullPath)` body.

- [ ] **Step 2: Refactor loadCmsPageInternal to delegate**

Replace the body with:

```ts
import {
  getCookies, getRequest, getRequestHeader, getRequestUrl, setResponseHeader,
} from "@tanstack/react-start/server";
import { loadCmsPagePure } from "../../core/cms/loadCmsPagePure";
import type { MatcherContext } from "../../core/types/index";

async function loadCmsPageInternal(fullPath: string) {
  const url = getRequestUrl();
  const cookies = getCookies() ?? {};
  const req = getRequest();
  const userAgent = getRequestHeader("user-agent") ?? "";
  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) headers[k] = v;

  const [basePath] = fullPath.split("?");
  const ctx: MatcherContext = {
    userAgent,
    url: url.toString(),
    path: basePath,
    cookies,
    headers,
    request: req,
  };

  const result = await loadCmsPagePure(fullPath, ctx);

  if (result?.cacheMetadata.cacheable) {
    setResponseHeader("X-Deco-Cacheable", "true");
    if (result.cacheMetadata.cacheControl) {
      setResponseHeader("Cache-Control", result.cacheMetadata.cacheControl);
    }
  }

  return result;
}
```

(Adjust to match the actual existing function shape — header set logic, return type wrapping, etc. The principle: TanStack code only handles `getRequest*` ↔ `MatcherContext` translation and response-header writing. Page resolution is delegated.)

- [ ] **Step 3: Build, test, fixture**

```bash
rm -rf dist && bun run build && bun run test
cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/tanstack/routes/cmsRoute.ts
git commit -m "refactor(tanstack): loadCmsPage delegates to loadCmsPagePure"
```

---

### Task 39: Phase 6 validation gate

- [ ] **Step 1: Run full check**

```bash
rm -rf dist && bun run check && bun run test
cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: all green.

---

## Phase 7 — `src/next/` App Router adapter

Goal: ship a first-party Next.js (App Router) adapter.

### Task 40: Add `next` as devDependency for fixture & adapter typing

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install**

```bash
bun add -d next@^15.0.0
```

- [ ] **Step 2: Add to peerDependencies (optional)**

In `package.json`, add to `peerDependencies`:

```jsonc
"next": ">=15.0.0",
```

And mark it optional in `peerDependenciesMeta`:

```jsonc
"peerDependenciesMeta": {
  "next": { "optional": true }
}
```

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore(deps): add next as optional peer + dev dependency"
```

---

### Task 41: Implement `buildMatcherContextFromNext`

**Files:**
- Create: `src/next/ctx.ts`
- Create: `src/next/ctx.test.ts`

- [ ] **Step 1: Write failing test**

`src/next/ctx.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildMatcherContextFromNext } from "./ctx";

describe("buildMatcherContextFromNext", () => {
  it("extracts userAgent, url, path, cookies, headers from a NextRequest-like object", () => {
    const req = new Request("http://example.test/products/foo?bar=1", {
      headers: {
        "user-agent": "vitest",
        "cookie": "session=abc; theme=dark",
        "x-forwarded-host": "example.test",
      },
    });
    const ctx = buildMatcherContextFromNext(req);
    expect(ctx.userAgent).toBe("vitest");
    expect(ctx.url).toBe("http://example.test/products/foo?bar=1");
    expect(ctx.path).toBe("/products/foo");
    expect(ctx.cookies.session).toBe("abc");
    expect(ctx.cookies.theme).toBe("dark");
    expect(ctx.headers?.["user-agent"]).toBe("vitest");
    expect(ctx.request).toBe(req);
  });

  it("returns empty defaults when headers/cookies are absent", () => {
    const req = new Request("http://example.test/");
    const ctx = buildMatcherContextFromNext(req);
    expect(ctx.userAgent).toBe("");
    expect(ctx.cookies).toEqual({});
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
bunx vitest run src/next/ctx.test.ts
```

Expected: fails (file doesn't exist).

- [ ] **Step 3: Implement ctx.ts**

```ts
import type { MatcherContext } from "../core/types/index";

function parseCookieHeader(raw: string | null): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * Build a framework-agnostic MatcherContext from a Next.js (or any standard
 * Web API) Request. Use the result with loadCmsPagePure / resolveDeferredSectionPure.
 */
export function buildMatcherContextFromNext(req: Request): MatcherContext {
  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) headers[k] = v;
  return {
    userAgent: req.headers.get("user-agent") ?? "",
    url: req.url,
    path: url.pathname,
    cookies: parseCookieHeader(req.headers.get("cookie")),
    headers,
    request: req,
  };
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
bunx vitest run src/next/ctx.test.ts
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/next/ctx.ts src/next/ctx.test.ts
git commit -m "feat(next): buildMatcherContextFromNext helper"
```

---

### Task 42: Implement `src/next/loadCmsPage`

**Files:**
- Create: `src/next/loadCmsPage.ts`
- Create: `src/next/loadCmsPage.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { loadCmsPage } from "./loadCmsPage";

describe("next/loadCmsPage", () => {
  it("accepts a Request and returns null for unknown path", async () => {
    const req = new Request("http://t/this-doesnt-exist");
    const result = await loadCmsPage(req);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
bunx vitest run src/next/loadCmsPage.test.ts
```

Expected: fails.

- [ ] **Step 3: Implement**

```ts
import { loadCmsPagePure, type DecoPageResult } from "../core/cms/loadCmsPagePure";
import { buildMatcherContextFromNext } from "./ctx";

/**
 * Load a Deco CMS page from a Next.js App Router route handler or RSC.
 * Returns the resolved page or null if no page matches.
 *
 * @example
 * // app/[[...path]]/page.tsx
 * import { loadCmsPage } from "@decocms/start/next";
 * export default async function Page({ params }: { params: Promise<{ path?: string[] }> }) {
 *   const req = new Request(`http://localhost/${(await params).path?.join("/") ?? ""}`);
 *   const result = await loadCmsPage(req);
 *   if (!result) return <NotFound />;
 *   return <DecoSections result={result} />;
 * }
 */
export async function loadCmsPage(req: Request): Promise<DecoPageResult | null> {
  const ctx = buildMatcherContextFromNext(req);
  return await loadCmsPagePure(req.url, ctx);
}
```

- [ ] **Step 4: Run test, build**

```bash
bunx vitest run src/next/loadCmsPage.test.ts
rm -rf dist && bun run build
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/next/loadCmsPage.ts src/next/loadCmsPage.test.ts
git commit -m "feat(next): loadCmsPage(req) — App Router page loader"
```

---

### Task 43: Implement `handleDecoAdminRoute`

**Files:**
- Create: `src/next/adminRoute.ts`
- Create: `src/next/adminRoute.test.ts`

- [ ] **Step 1: Read existing TanStack admin handler**

Use Read on `src/tanstack/routes/adminRoutes.ts` (or `src/core/admin/index.ts`). The admin protocol routes are documented in CLAUDE.md:

- `GET /live/_meta` → JSON Schema + manifest
- `GET /.decofile` → site content blocks
- `POST /deco/render` → section/page preview
- `POST /deco/invoke` → loader/action execution

The core handlers are already in `src/core/admin/`. The Next adapter just plugs Next's request/response convention into them.

- [ ] **Step 2: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { handleDecoAdminRoute } from "./adminRoute";

describe("handleDecoAdminRoute", () => {
  it("returns 404 for non-admin paths", async () => {
    const req = new Request("http://t/some/random/path");
    const res = await handleDecoAdminRoute(req);
    expect(res.status).toBe(404);
  });

  it("routes /live/_meta to the admin meta handler", async () => {
    const req = new Request("http://t/live/_meta");
    const res = await handleDecoAdminRoute(req);
    expect([200, 401, 403]).toContain(res.status); // 200 if unauthenticated allowed; else admin auth
  });
});
```

- [ ] **Step 3: Run failing test**

```bash
bunx vitest run src/next/adminRoute.test.ts
```

Expected: fails.

- [ ] **Step 4: Implement adminRoute.ts**

```ts
import { handleMeta } from "../core/admin/meta";
import { handleDecofile } from "../core/admin/decofile";
import { handleRender } from "../core/admin/render";
import { handleInvoke } from "../core/admin/invoke";

/**
 * Dispatch a Next.js App Router request to the appropriate Deco admin handler.
 * Wire as both GET and POST in app/[[...catchall]]/route.ts:
 *
 * @example
 * // app/(deco-admin)/[...path]/route.ts
 * import { handleDecoAdminRoute } from "@decocms/start/next";
 * export const GET = handleDecoAdminRoute;
 * export const POST = handleDecoAdminRoute;
 */
export async function handleDecoAdminRoute(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/live/_meta") return handleMeta(req);
  if (url.pathname === "/.decofile") return handleDecofile(req);
  if (url.pathname === "/deco/render") return handleRender(req);
  if (url.pathname === "/deco/invoke") return handleInvoke(req);
  return new Response("Not Found", { status: 404 });
}
```

(Adjust handler names to match what's exported from `src/core/admin/`.)

- [ ] **Step 5: Test, build**

```bash
bunx vitest run src/next/adminRoute.test.ts
rm -rf dist && bun run build
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/next/adminRoute.ts src/next/adminRoute.test.ts
git commit -m "feat(next): handleDecoAdminRoute for App Router admin protocol"
```

---

### Task 44: Implement `DecoPage` server component

**Files:**
- Create: `src/next/DecoPage.tsx`

- [ ] **Step 1: Write the component**

```tsx
import type { ReactNode } from "react";
import { loadCmsPage } from "./loadCmsPage";

/**
 * RSC server component that renders a Deco CMS page.
 *
 * @example
 * // app/[[...path]]/page.tsx
 * import { DecoPage } from "@decocms/start/next";
 * export default async function Page() {
 *   return <DecoPage />;
 * }
 */
export async function DecoPage(): Promise<ReactNode> {
  // In an App Router server component, the request is provided via the
  // `headers()` API from "next/headers". We don't import it directly to
  // keep the package's dependency on next optional; consumers can pass
  // a Request directly via DecoPage.fromRequest.
  const { headers } = await import("next/headers");
  const h = await headers();
  const url = new URL(h.get("x-url") ?? `http://localhost${h.get("x-pathname") ?? "/"}`);
  // Reconstruct a Request from the inbound headers
  const reqHeaders = new Headers();
  h.forEach((value, key) => reqHeaders.set(key, value));
  const req = new Request(url, { headers: reqHeaders });
  const result = await loadCmsPage(req);
  if (!result) return <NotFound />;
  return <DecoSections result={result} />;
}

function NotFound() {
  return <main>Not Found</main>;
}

function DecoSections({ result }: { result: NonNullable<Awaited<ReturnType<typeof loadCmsPage>>> }) {
  // Minimal shell — consumers replace this with their own renderer.
  // Sections require client-side hydration via the registered components.
  return (
    <main>
      <pre style={{ display: "none" }}>{JSON.stringify(result, null, 2)}</pre>
      {/* Real renderer: map result.resolvedSections over a hydrated component map */}
    </main>
  );
}
```

**Note:** App Router doesn't expose the inbound URL/headers cleanly — consumers typically install a Next.js middleware that sets `x-url` / `x-pathname`. Document this in the README. A more featureful renderer is out of scope for the first cut.

- [ ] **Step 2: Build**

```bash
rm -rf dist && bun run build
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/next/DecoPage.tsx
git commit -m "feat(next): minimal DecoPage RSC server component"
```

---

### Task 45: Implement `src/next/client.ts` (client-safe surface)

**Files:**
- Create: `src/next/client.ts`

- [ ] **Step 1: Write the client barrel**

```ts
/**
 * @decocms/start/next/client — client-safe surface.
 *
 * Imports here MUST NOT transitively reach node:async_hooks, node:fs,
 * or any other Node-only module. Validated by scripts/check-tier-boundaries.ts.
 */
export { useDevice } from "../core/sdk/useDevice";
export { useHydrated } from "../core/sdk/useHydrated";
export { signal } from "../core/sdk/signal";
export { LiveControls } from "../tanstack/hooks/LiveControls";
export { LazySection } from "../tanstack/hooks/LazySection";
export { SectionErrorFallback } from "../tanstack/hooks/SectionErrorFallback";
```

**Caveat:** `LiveControls`, `LazySection`, `SectionErrorFallback` live in `src/tanstack/hooks/` — they import from `@tanstack/react-router`. For a Next.js consumer, importing these from `next/client` would pull TanStack into the Next bundle, which is wrong.

**Resolution:** if any of these hooks pulls TanStack, **move the framework-agnostic parts to `src/core/components/` first** (or duplicate the React-only logic). For the first cut, **only export hooks that genuinely don't import TanStack**:

```ts
export { useDevice } from "../core/sdk/useDevice";
export { useHydrated } from "../core/sdk/useHydrated";
export { signal } from "../core/sdk/signal";
```

The `LazySection`/`LiveControls` story is a follow-up; document it in the README.

- [ ] **Step 2: Build**

```bash
rm -rf dist && bun run build
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/next/client.ts
git commit -m "feat(next): minimal next/client surface (useDevice, useHydrated, signal)"
```

---

### Task 46: Create `src/next/index.ts` barrel and add /next exports to package.json

**Files:**
- Create: `src/next/index.ts`
- Modify: `package.json`
- Modify: `tsup.config.ts`

- [ ] **Step 1: Write the barrel**

```ts
/**
 * @decocms/start/next — Next.js App Router adapter.
 *
 * App Router only. Pages Router not supported.
 */
export { loadCmsPage } from "./loadCmsPage";
export { buildMatcherContextFromNext } from "./ctx";
export { handleDecoAdminRoute } from "./adminRoute";
export { DecoPage } from "./DecoPage";
```

- [ ] **Step 2: Add /next exports to package.json**

```jsonc
"./next": {
  "types": "./dist/next/index.d.ts",
  "import": "./dist/next/index.js",
  "require": "./dist/next/index.cjs"
},
"./next/client": {
  "types": "./dist/next/client.d.ts",
  "import": "./dist/next/client.js",
  "require": "./dist/next/client.cjs"
}
```

- [ ] **Step 3: Add to tsup.config.ts entries**

```
"src/next/index.ts",
"src/next/client.ts",
```

- [ ] **Step 4: Build, test**

```bash
rm -rf dist && bun run build && bun run test
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(next): add next/index.ts barrel and /next exports"
```

---

### Task 47: Wire Next.js fixture to use `@decocms/start/next`

**Files:**
- Modify: `tests/fixtures/next-app/app/_smoke/page.tsx`

- [ ] **Step 1: Update the fixture smoke page to exercise /next**

```tsx
import { buildMatcherContextFromNext, loadCmsPage } from "@decocms/start/next";
import { findPageByPath } from "@decocms/start/cms";
import { cacheHeaders } from "@decocms/start/sdk/cacheHeaders";

export default async function SmokePage() {
  // Smoke: build a request and ensure types resolve at compile time.
  const req = new Request("http://localhost/");
  const ctx = buildMatcherContextFromNext(req);
  // Don't actually call loadCmsPage in the test (no blocks loaded);
  // just reference the symbols so they're not tree-shaken.
  const types = [
    typeof loadCmsPage,
    typeof findPageByPath,
    typeof cacheHeaders,
    typeof ctx,
  ];
  return <pre>{JSON.stringify({ types }, null, 2)}</pre>;
}
```

- [ ] **Step 2: Build the fixture**

```bash
rm -rf dist && bun run build
cd tests/fixtures/next-app && rm -rf .next node_modules && bun install --no-save && bun run build && cd ../../..
```

Expected: succeeds. **This proves the Next.js adapter is functional.**

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/next-app
git commit -m "test(next-fixture): exercise /next adapter end-to-end"
```

---

### Task 48: Phase 7 validation gate

- [ ] **Step 1: Full check**

```bash
rm -rf dist && bun run check && bun run test
cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: all green.

---

## Phase 8 — Boundary enforcement

Goal: per-directory Biome configs forbidding cross-tier imports + a post-build graph check.

### Task 49: Add per-directory Biome configs

**Files:**
- Create: `src/core/biome.json`
- Create: `src/tanstack/biome.json`
- Create: `src/next/biome.json`

- [ ] **Step 1: Read root biome.json**

Use Read on `biome.json` (root). Note its structure for `noRestrictedImports`.

- [ ] **Step 2: Create src/core/biome.json**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.6/schema.json",
  "extends": ["//"],
  "linter": {
    "rules": {
      "style": {
        "noRestrictedImports": {
          "level": "error",
          "options": {
            "paths": {
              "@tanstack/react-start": "Forbidden in core/** — use the RequestStore abstraction in core/runtime/.",
              "@tanstack/react-start/server": "Forbidden in core/** — accept inputs as arguments.",
              "@tanstack/react-start/api": "Forbidden in core/**.",
              "@tanstack/react-start/server-entry": "Forbidden in core/**.",
              "@tanstack/react-router": "Forbidden in core/** — core is framework-agnostic.",
              "next": "Forbidden in core/**.",
              "next/server": "Forbidden in core/**.",
              "next/headers": "Forbidden in core/**.",
              "node:async_hooks": "Forbidden in core/** — use injected RequestStore."
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 3: Create src/tanstack/biome.json**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.6/schema.json",
  "extends": ["//"],
  "linter": {
    "rules": {
      "style": {
        "noRestrictedImports": {
          "level": "error",
          "options": {
            "paths": {
              "next": "Forbidden in tanstack/**.",
              "next/server": "Forbidden in tanstack/**.",
              "next/headers": "Forbidden in tanstack/**."
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Create src/next/biome.json**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.6/schema.json",
  "extends": ["//"],
  "linter": {
    "rules": {
      "style": {
        "noRestrictedImports": {
          "level": "error",
          "options": {
            "paths": {
              "@tanstack/react-start": "Forbidden in next/**.",
              "@tanstack/react-start/server": "Forbidden in next/**.",
              "@tanstack/react-router": "Forbidden in next/**."
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 5: Run lint**

```bash
bun run lint
```

Expected: passes (or surfaces only pre-existing lint issues unrelated to imports). If the per-directory configs surface real cross-tier imports, that's a bug — investigate and fix in `src/`.

- [ ] **Step 6: Commit**

```bash
git add src/core/biome.json src/tanstack/biome.json src/next/biome.json
git commit -m "chore(boundary): add per-directory Biome noRestrictedImports rules"
```

---

### Task 50: Write `scripts/check-tier-boundaries.ts`

**Files:**
- Create: `scripts/check-tier-boundaries.ts`
- Create: `scripts/check-tier-boundaries.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { checkTierBoundaries } from "./check-tier-boundaries";

describe("checkTierBoundaries", () => {
  it("returns no violations when run against a clean dist/ tree", async () => {
    // Assume `bun run build` has been run before invoking tests.
    const result = await checkTierBoundaries({ distDir: "dist" });
    expect(result.violations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
bunx vitest run scripts/check-tier-boundaries.test.ts
```

Expected: fails (file doesn't exist).

- [ ] **Step 3: Implement check-tier-boundaries.ts**

```ts
#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { join } from "node:path";

interface Violation {
  file: string;
  imported: string;
  reason: string;
}

interface Options {
  distDir: string;
}

const FORBIDDEN_IN_CORE = [
  /@tanstack\/react-start/,
  /@tanstack\/react-router/,
  /^next$/,
  /^next\//,
  /node:async_hooks/,
];

const FORBIDDEN_IN_NEXT_FROM_TANSTACK = [
  /@tanstack\/react-start/,
  /@tanstack\/react-router/,
];

const FORBIDDEN_CROSS_TIER_TANSTACK = [/^\.\.\/(tanstack|next)\//];
const FORBIDDEN_CROSS_TIER_NEXT = [/^\.\.\/tanstack\//];

const IMPORT_RE = /(?:from|import\()\s*["']([^"']+)["']/g;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) yield path;
  }
}

function tierOf(path: string): "core" | "tanstack" | "next" | "other" {
  if (path.includes("/dist/core/")) return "core";
  if (path.includes("/dist/tanstack/")) return "tanstack";
  if (path.includes("/dist/next/")) return "next";
  return "other";
}

export async function checkTierBoundaries(opts: Options): Promise<{ violations: Violation[] }> {
  const violations: Violation[] = [];
  for await (const path of walk(opts.distDir)) {
    const content = await fs.readFile(path, "utf8");
    const tier = tierOf(path);
    const imports: string[] = [];
    for (const m of content.matchAll(IMPORT_RE)) imports.push(m[1]);

    for (const imp of imports) {
      if (tier === "core") {
        for (const re of FORBIDDEN_IN_CORE) {
          if (re.test(imp)) violations.push({ file: path, imported: imp, reason: `core forbids ${imp}` });
        }
      } else if (tier === "next") {
        for (const re of FORBIDDEN_IN_NEXT_FROM_TANSTACK) {
          if (re.test(imp)) violations.push({ file: path, imported: imp, reason: `next forbids ${imp}` });
        }
        for (const re of FORBIDDEN_CROSS_TIER_NEXT) {
          if (re.test(imp)) violations.push({ file: path, imported: imp, reason: `next must not import from tanstack` });
        }
      } else if (tier === "tanstack") {
        for (const re of FORBIDDEN_CROSS_TIER_TANSTACK) {
          if (re.test(imp) && imp.includes("/next/")) {
            violations.push({ file: path, imported: imp, reason: `tanstack must not import from next` });
          }
        }
      }
    }
  }
  return { violations };
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await checkTierBoundaries({ distDir: "dist" });
  if (result.violations.length === 0) {
    console.log("✓ tier boundaries clean");
    process.exit(0);
  }
  console.error("✗ tier boundary violations:");
  for (const v of result.violations) console.error(`  ${v.file}: ${v.imported} (${v.reason})`);
  process.exit(1);
}
```

- [ ] **Step 4: Run test (after building)**

```bash
rm -rf dist && bun run build
bunx vitest run scripts/check-tier-boundaries.test.ts
```

Expected: passing — `dist/` is clean from the prior phases.

- [ ] **Step 5: Add to package.json scripts**

Update `"check"`:

```jsonc
"check": "bun run typecheck && bun run lint && bun run lint:unused && bun run build && bun run scripts/check-tier-boundaries.ts"
```

- [ ] **Step 6: Run full check**

```bash
bun run check
```

Expected: prints `✓ tier boundaries clean` at the end, exit 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/check-tier-boundaries.ts scripts/check-tier-boundaries.test.ts package.json
git commit -m "feat(check): add post-build tier-boundary verification script"
```

---

### Task 51: Verify check-tier-boundaries catches deliberate violations

**Files:**
- (temporary modifications — reverted)

- [ ] **Step 1: Introduce a deliberate violation**

Use Edit to add to `src/core/cms/loadCmsPagePure.ts`:

```ts
// VIOLATION (temporary)
import { getRequestUrl } from "@tanstack/react-start/server";
console.log(getRequestUrl);
```

- [ ] **Step 2: Build and run check**

```bash
rm -rf dist && bun run build
bun run scripts/check-tier-boundaries.ts || echo "violation caught (expected)"
```

Expected: prints `violation caught (expected)` because the script exits 1 with a violation listing.

- [ ] **Step 3: Verify lint catches it**

```bash
bun run lint 2>&1 | grep -i "noRestrictedImports\|@tanstack/react-start" | head -3
```

Expected: at least one matching line — Biome's noRestrictedImports rule fires.

- [ ] **Step 4: Revert the deliberate violation**

Use Edit to remove the two added lines.

- [ ] **Step 5: Re-run check**

```bash
bun run check
```

Expected: passes.

- [ ] **Step 6: No commit** (temporary changes reverted)

---

### Task 52: Phase 8 validation gate

- [ ] **Step 1: Full check + fixture**

```bash
rm -rf dist && bun run check && bun run test
cd tests/fixtures/next-app && rm -rf .next && bun run build && cd ../../..
```

Expected: all green.

---

## Phase 9 — Documentation

### Task 53: Update README.md with three-tier explanation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read existing README**

Use Read on `README.md`.

- [ ] **Step 2: Add a new section**

Insert (after the package overview, before any "Getting Started" section):

````markdown
## Import Tiers

`@decocms/start` exposes three import tiers, each with a distinct dependency budget:

### `@decocms/start/core` — framework-agnostic

CMS resolution, registry, blocks, matchers, schema, plain SDK utilities. Zero imports from `@tanstack/*`, `next/*`, or `node:async_hooks`. Safe to use from any host:

```ts
import {
  resolveDecoPage,
  loadCmsPagePure,
  registerSectionsSync,
  loadAllDecofileBlocks,
} from "@decocms/start/core";
```

### `@decocms/start/tanstack` — TanStack Start adapter

Routes, hooks, middleware, worker entry, vite plugin. The default for storefronts on Cloudflare Workers + TanStack Start.

```ts
import { loadCmsPage, cmsRouteConfig } from "@decocms/start/tanstack";
```

### `@decocms/start/next` — Next.js (App Router) adapter

```ts
import {
  loadCmsPage,
  buildMatcherContextFromNext,
  handleDecoAdminRoute,
  DecoPage,
} from "@decocms/start/next";

// app/[[...path]]/page.tsx
export default DecoPage;

// app/(deco-admin)/[...path]/route.ts
import { handleDecoAdminRoute } from "@decocms/start/next";
export const GET = handleDecoAdminRoute;
export const POST = handleDecoAdminRoute;
```

For client-only components (no `node:async_hooks` in the bundle):

```ts
import { useDevice, useHydrated, signal } from "@decocms/start/next/client";
```

**Caveat:** Next.js Pages Router is not supported. App Router only.
````

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document /core, /tanstack, /next import tiers"
```

---

### Task 54: Add "Using @decocms/start from Next.js" guide

**Files:**
- Create: `docs/using-from-nextjs.md`

- [ ] **Step 1: Write the guide**

````markdown
# Using @decocms/start from Next.js (App Router)

`@decocms/start` ships a first-party Next.js adapter at `@decocms/start/next`. App Router only.

## Install

```bash
bun add @decocms/start @decocms/apps
# Required peer dependencies (you almost certainly already have these in a Next 15 app)
bun add next@^15 react@^19 react-dom@^19
```

`tsconfig.json` must use `moduleResolution: "bundler"` (the Next 15 default).

## Configure

No `transpilePackages` in `next.config.js` is needed — the package ships compiled JavaScript.

## Render a CMS page from a route

```tsx
// app/[[...path]]/page.tsx
import { loadCmsPage } from "@decocms/start/next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

export default async function Page() {
  const h = await headers();
  const url = new URL(h.get("x-url") ?? `http://localhost${h.get("x-pathname") ?? "/"}`);
  const reqHeaders = new Headers();
  h.forEach((value, key) => reqHeaders.set(key, value));
  const req = new Request(url, { headers: reqHeaders });

  const result = await loadCmsPage(req);
  if (!result) notFound();

  // Render result.resolvedSections via your component map.
  // (Example renderer omitted — wire to your registered sections.)
  return <YourSectionsRenderer result={result} />;
}
```

To populate `x-url` / `x-pathname`, install a Next.js middleware:

```ts
// middleware.ts
import { NextResponse } from "next/server";
export function middleware(req) {
  const url = req.nextUrl.clone();
  const res = NextResponse.next();
  res.headers.set("x-url", req.url);
  res.headers.set("x-pathname", url.pathname);
  return res;
}
export const config = { matcher: ["/((?!_next).*)"] };
```

## Wire admin protocol routes

The Deco admin UI talks to your storefront via `/live/_meta`, `/.decofile`, `/deco/render`, `/deco/invoke`. Expose them with a single catch-all:

```ts
// app/(deco-admin)/[...path]/route.ts
import { handleDecoAdminRoute } from "@decocms/start/next";
export const GET = handleDecoAdminRoute;
export const POST = handleDecoAdminRoute;
```

## Register sections

At app boot (before any request handler runs):

```ts
// src/sections/registry.ts
import { registerSectionsSync, setBlocks } from "@decocms/start/cms";
import * as MyHero from "./MyHero";
import * as MyBanner from "./MyBanner";
import blocks from "./.deco/blocks/site.json";

setBlocks(blocks);
registerSectionsSync({
  "site/sections/MyHero.tsx": MyHero.default,
  "site/sections/MyBanner.tsx": MyBanner.default,
});
```

Import this from `app/layout.tsx` (or any module that runs at boot) so it executes before any page renders.

## Limitations

- App Router only. Pages Router is not supported.
- The minimal `DecoPage` component shipped with the package is a starting point; production renderers should provide their own.
- `@decocms/start/next/client` exports only `useDevice`, `useHydrated`, `signal`. The TanStack-specific hooks (`LiveControls`, `LazySection`) are not yet ported.
````

- [ ] **Step 2: Commit**

```bash
git add docs/using-from-nextjs.md
git commit -m "docs: add Next.js (App Router) usage guide"
```

---

### Task 55: Update CLAUDE.md to reflect new tier boundaries

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Read CLAUDE.md**

- [ ] **Step 2: Replace the "Architecture" section**

Find the existing `## Architecture` section. Replace its `src/` tree with:

```
src/
├── core/             # framework-agnostic. NO @tanstack/* / next/* / node:async_hooks.
│   ├── cms/          # Block loading, page resolution, registry, loadCmsPagePure
│   ├── sdk/          # Plain utilities (clx, signal, http, cookie, …)
│   ├── admin/        # Admin protocol handlers (Web API only)
│   ├── matchers/     # PostHog, built-in feature flag matchers
│   ├── types/        # FnContext, Section, MatcherContext, widgets
│   └── runtime/      # RequestStore interface (noop default)
├── tanstack/         # TanStack Start adapter (today's behavior)
│   ├── routes/       # createServerFn-wrapped loaders
│   ├── hooks/        # DecoPageRenderer, LiveControls, LazySection, …
│   ├── middleware/   # observability (ALS), decoState, hydrationContext
│   ├── sdk/          # workerEntry, router, requestContext (TanStack-coupled)
│   ├── apps/         # commerce app autoconfig
│   ├── daemon/       # dev tooling (tunnel, watch)
│   ├── vite/         # Vite plugin
│   └── runtime/      # AlsRequestStore implementation
├── next/             # Next.js App Router adapter
│   ├── loadCmsPage.ts
│   ├── ctx.ts
│   ├── adminRoute.ts
│   ├── DecoPage.tsx
│   └── client.ts
└── index.ts          # top-level barrel; re-exports core only
```

- [ ] **Step 3: Add a new "Import Tiers" section**

```markdown
## Import Tiers (constitutional)

The package has three tiers, each enforced by a per-directory `biome.json` `noRestrictedImports` config and the post-build `scripts/check-tier-boundaries.ts`:

1. **`/core`**: No imports from `@tanstack/*`, `next`, `next/*`, top-level `node:async_hooks`. Pure functions; explicit-pass context.
2. **`/tanstack`**: Today's behavior. May use `@tanstack/*`, `node:async_hooks`. May import from `core/`. May NOT import from `next/`.
3. **`/next`**: Next.js (App Router) adapter. May use `next`. May import from `core/`. May NOT import from `tanstack/` or `@tanstack/*`.

When adding new files, place them in the lowest-coupling tier that satisfies their dependencies. If you reach for `@tanstack/react-start/server` inside `core/`, stop — accept the value as a function argument or use the `RequestStore` interface in `core/runtime/`.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): document import-tier boundaries and new src/ tree"
```

---

### Task 56: Final validation gate (full PR)

- [ ] **Step 1: Clean rebuild + everything**

```bash
rm -rf dist node_modules
bun install
bun run check
bun run test
```

Expected: all green.

- [ ] **Step 2: Next.js fixture clean rebuild**

```bash
cd tests/fixtures/next-app
rm -rf node_modules .next
bun install --no-save
bun run typecheck
bun run build
cd ../../..
```

Expected: all green.

- [ ] **Step 3: Verify all bin scripts are runnable**

```bash
test -x dist/scripts/migrate.cjs && \
test -x dist/scripts/migrate-post-cleanup.cjs && \
test -x dist/scripts/htmx-analyze.cjs && \
test -x dist/scripts/migrate-to-cf-observability.cjs && \
echo "ok"
```

Expected: prints `ok`.

- [ ] **Step 4: Verify package.json exports resolve**

```bash
node -e "
const checks = [
  '@decocms/start',
  '@decocms/start/core',
  '@decocms/start/tanstack',
  '@decocms/start/next',
  '@decocms/start/next/client',
  '@decocms/start/cms',
  '@decocms/start/hooks',
  '@decocms/start/routes',
  '@decocms/start/middleware',
  '@decocms/start/sdk/cacheHeaders',
  '@decocms/start/sdk/workerEntry',
  '@decocms/start/admin',
  '@decocms/start/vite',
];
for (const id of checks) {
  try { require.resolve(id); console.log('✓', id); }
  catch (e) { console.log('✗', id, '-', e.message); process.exit(1); }
}
"
```

Expected: every line starts with `✓`.

- [ ] **Step 5: Run the existing migration test against a sample site (if available)**

If `run-migration` skill or sample fixture exists, run it. Otherwise document this as a manual smoke test the maintainer must do before merging.

- [ ] **Step 6: No commit needed for the gate** — the work is the commits done so far.

---

## Final review

Check the entire branch end-to-end:

- [ ] **Step 1: Review the diff**

```bash
git log --oneline origin/main..HEAD | head -60
git diff --stat origin/main...HEAD | tail -20
```

Expected: ~30+ commits, all with conventional-commit prefixes (`feat(*)`, `refactor(*)`, `fix(*)`, `chore(*)`, `docs(*)`, `test(*)`).

- [ ] **Step 2: Verify final structure**

```bash
ls src
# Expected: core  index.ts  next  tanstack
```

- [ ] **Step 3: Verify no stale source paths**

```bash
test ! -d src/cms && test ! -d src/sdk && test ! -d src/admin && \
test ! -d src/hooks && test ! -d src/middleware && test ! -d src/routes && \
test ! -d src/apps && test ! -d src/daemon && test ! -d src/vite && \
test ! -d src/matchers && test ! -d src/types && \
echo "tree clean"
```

Expected: prints `tree clean`.

- [ ] **Step 4: Confirm CHANGELOG/version stays at 5.0.0 for now**

The branch's commits cover the full spec. Version bump and CHANGELOG entry are handled by the existing semantic-release workflow on merge — no manual changes needed in this branch.

---

## Self-review checklist (run before handing off for review)

- All test files have proper assertions (no `expect(true).toBe(true)` placeholders).
- Every code block in the plan compiles or runs as written.
- `bun run check` exits 0.
- `bun run test` exits 0 with all tests passing.
- `tests/fixtures/next-app && bun run build` exits 0.
- `dist/` includes `.js`, `.cjs`, and `.d.ts` for every entry in `tsup.config.ts`.
- `package.json` `exports` paths all resolve to existing files in `dist/`.
- `scripts/check-tier-boundaries.ts` reports zero violations.
- `src/core/**` contains no `@tanstack/*`, `next/*`, or top-level `node:async_hooks` imports.
- `src/next/**` contains no `@tanstack/*` imports.
- `src/tanstack/**` contains no `next/*` imports.
- README and CLAUDE.md are updated.
