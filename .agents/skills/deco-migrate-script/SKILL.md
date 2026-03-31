---
name: deco-migrate-script
description: Automated migration script that converts Deco storefronts from Fresh/Preact/Deno to TanStack Start/React/Cloudflare Workers. Runs 7 phases (analyze, scaffold, transform, cleanup, report, verify, bootstrap). Use when running the migration script, debugging its output, extending it with new transforms, or understanding what it does. Located at scripts/migrate.ts in @decocms/start.
globs:
  - "scripts/migrate.ts"
  - "scripts/migrate/**/*"
---

# Deco Migration Script

Automated TypeScript script that converts a Deco storefront from Fresh/Preact/Deno to TanStack Start/React/Cloudflare Workers in one pass.

## Quick Start

```bash
# From the NEW site root (already has @decocms/start installed):
npx tsx node_modules/@decocms/start/scripts/migrate.ts --source /path/to/old-site

# Dry run first:
npx tsx node_modules/@decocms/start/scripts/migrate.ts --source /path/to/old-site --dry-run --verbose
```

### Options

| Flag | Description |
|------|-------------|
| `--source <dir>` | Source site directory (default: `.`) |
| `--dry-run` | Preview changes without writing files |
| `--verbose` | Show detailed per-file output |
| `--help` | Show help |

## Architecture

```
scripts/migrate.ts              ← Entry point, runs all phases
scripts/migrate/
├── types.ts                    ← MigrationContext, FileRecord, DetectedPattern
├── colors.ts                   ← Terminal output formatting
├── phase-analyze.ts            ← Phase 1: scan source, detect patterns
├── phase-scaffold.ts           ← Phase 2: generate config files
├── phase-transform.ts          ← Phase 3: apply code transforms
├── phase-cleanup.ts            ← Phase 4: delete old artifacts
├── phase-report.ts             ← Phase 5: generate MIGRATION_REPORT.md
├── phase-verify.ts             ← Phase 6: smoke tests
├── transforms/                 ← Transform modules (applied in order)
│   ├── imports.ts              ← 70+ import rewriting rules
│   ├── jsx.ts                  ← JSX attribute fixes
│   ├── fresh-apis.ts           ← Fresh framework API removal
│   ├── deno-isms.ts            ← Deno-specific cleanup
│   ├── dead-code.ts            ← Old cache/loader system removal
│   └── tailwind.ts             ← Tailwind v3→v4 + DaisyUI v4→v5
└── templates/                  ← Config file generators
    ├── package-json.ts         ← Auto-fetches latest npm versions
    ├── tsconfig.ts
    ├── vite-config.ts
    ├── wrangler.ts
    ├── knip-config.ts
    ├── routes.ts               ← __root, index, $, deco/* routes
    ├── setup.ts                ← CMS block registry
    └── server-entry.ts         ← server.ts + worker-entry.ts
```

## Phases

### Phase 1: Analyze

Scans the source directory to build a `MigrationContext`:

**Pattern detection** — 21 regex patterns:
- `preact-hooks`, `preact-compat`, `preact-signals`
- `fresh-runtime`, `fresh-head`, `fresh-islands`
- `deco-hooks`, `deco-blocks`, `deco-types`
- `apps-commerce`, `apps-website`, `apps-admin`
- `site-alias` (`$store/`, `deco-sites/`, `site/`)
- `class-attr`, `for-attr`, `svg-attrs`
- `use-signal`, `use-computed`

**File categorization**:
- `section` — `src/sections/**/*.tsx`
- `island` — `src/islands/**/*.tsx`
- `component` — `src/components/**/*.tsx`
- `sdk` — `src/sdk/**/*.ts`
- `loader` — `src/loaders/**/*.ts`
- `action` — `src/actions/**/*.ts`
- `route` — `routes/**/*.ts` (marked for deletion)
- `static` — `static/**/*` (marked for move → `public/`)
- `config` — `deno.json`, `fresh.gen.ts`, etc. (marked for deletion)

**Metadata extraction**:
- Site name (from `deno.json` or directory name)
- Platform (VTEX, Shopify, etc. from `apps/site.ts`)
- GTM ID (from `routes/_app.tsx`)
- Theme colors & fonts (from `.deco/blocks/` CMS JSON)
- NPM dependencies (from `npm:` imports and import map)

### Phase 2: Scaffold

Generates 14+ configuration and infrastructure files:

| File | Generator | Notes |
|------|-----------|-------|
| `package.json` | `templates/package-json.ts` | Auto-fetches latest npm versions, extracts deps from deno.json |
| `tsconfig.json` | `templates/tsconfig.ts` | |
| `vite.config.ts` | `templates/vite-config.ts` | Plugins, aliases, manual chunks, meta.gen stub |
| `wrangler.jsonc` | `templates/wrangler.ts` | Cloudflare Worker config |
| `knip.config.ts` | `templates/knip-config.ts` | Unused code detection |
| `src/router.tsx` | `templates/routes.ts` | TanStack Router with search serialization |
| `src/routes/__root.tsx` | `templates/routes.ts` | Layout + GTM + analytics + NavigationProgress |
| `src/routes/index.tsx` | `templates/routes.ts` | Home page with CMS loader |
| `src/routes/$.tsx` | `templates/routes.ts` | Catch-all CMS route |
| `src/routes/deco/meta.ts` | `templates/routes.ts` | Admin schema endpoint |
| `src/routes/deco/invoke.$.ts` | `templates/routes.ts` | RPC handler |
| `src/routes/deco/render.ts` | `templates/routes.ts` | Preview renderer |
| `src/server.ts` | `templates/server-entry.ts` | TanStack handler |
| `src/worker-entry.ts` | `templates/server-entry.ts` | Cloudflare wrapper with admin handlers |
| `src/setup.ts` | `templates/setup.ts` | CMS block registry via `import.meta.glob` |
| `src/runtime.ts` | `templates/server-entry.ts` | Invoke proxy for RPC calls |
| `src/styles/app.css` | inline | DaisyUI v5 CSS with extracted theme colors |

### Phase 3: Transform

Applies 6 transforms in sequence to every source file:

#### 1. `imports.ts` — Import Rewriting (70+ rules)

```
preact/hooks     → react
preact/compat    → react
preact           → react
@preact/signals  → @decocms/start/sdk/signal
@deco/deco/hooks → @decocms/start/sdk/useScript
@deco/deco/blocks→ @decocms/start/types
apps/commerce/*  → @decocms/apps/commerce/*
apps/website/*   → ~/components/ui/* or @decocms/apps/*
site/*           → ~/*
$store/*         → ~/*
deco-sites/NAME/ → ~/
```

Also removes `npm:` prefix, handles relative imports to deleted SDK files (clx, useId, useOffer).

#### 2. `jsx.ts` — JSX Compatibility

```
class=           → className=
onInput=         → onChange=
for=             → htmlFor= (on labels)
tabindex=        → tabIndex=
referrerpolicy=  → referrerPolicy=
ComponentChildren→ ReactNode
JSX.SVGAttributes→ React.SVGAttributes
setTimeout       → window.setTimeout (type safety)
```

#### 3. `fresh-apis.ts` — Fresh Framework Removal

- `asset(url)` → `url` (identity function)
- `scriptAsDataURI()` → detection + warning
- `<Head>` component → flagged for manual review
- `defineApp()` → unwrapped
- `IS_BROWSER` → `typeof window !== "undefined"`
- `Context.active()` → removed

#### 4. `dead-code.ts` — Old Deco Patterns

- Removes: `export const cache`, `export const cacheKey`, `export const loader` (old caching system)
- Handles: `crypto.subtle.digestSync` (Deno-only → async)
- Preserves: `invoke.*` calls (runtime.ts proxy)

#### 5. `deno-isms.ts` — Deno Cleanup

- `deno-lint-ignore` comments → removed
- `npm:` prefix → removed
- `@ts-ignore` → `@ts-expect-error`
- `Deno.*` API usage → flagged
- `/// <reference>` directives → removed

#### 6. `tailwind.ts` — Tailwind v3→v4 + DaisyUI v4→v5

**23 Tailwind class renames:**
```
flex-grow-0   → grow-0
flex-shrink   → shrink
decoration-clone → box-decoration-clone
transform     → (removed, implicit in v4)
filter        → (removed, implicit in v4)
ring          → ring-3 (default changed)
```

**15 DaisyUI v4→v5 renames:**
```
badge-ghost   → badge-soft
card-compact  → card-sm
```

**Arbitrary value simplification:**
```
px-[16px]     → px-4
text-[12px]   → text-xs
```

**Opacity modifier consolidation:**
```
bg-black bg-opacity-20 → bg-black/20
```

**Critical z-index fix** (Tailwind v4 + React stacking contexts):
- `-z-{n}` on `<img>` / `<Image>` → `z-0` + `inset-0`
- Extracts `backgroundColor` into separate overlay div
- Bumps content div to `relative z-20`

### Phase 4: Cleanup

**Deletes directories:**
- `islands/`, `routes/`, `apps/deco/`, `sdk/cart/`

**Deletes root files:**
- `deno.json`, `fresh.gen.ts`, `main.ts`, `dev.ts`, `tailwind.config.ts`, `runtime.ts`, `constants.ts`

**Deletes SDK files** (now in @decocms/start or @decocms/apps):
- `sdk/clx.ts`, `sdk/useId.ts`, `sdk/useOffer.ts`, `sdk/useVariantPossiblities.ts`, `sdk/usePlatform.tsx`

**Moves:**
- `static/` → `public/` (preserves directory structure)

### Phase 5: Report

Generates `MIGRATION_REPORT.md` with:
- Summary table (files analyzed / scaffolded / transformed / deleted / moved)
- Categorized file lists
- Manual review items with severity
- Always-check section (FormEmail, Slider, Theme, DaisyUI, Tailwind)
- Known issues (z-index stacking, opacity modifiers)
- Framework findings (patterns to consolidate into @decocms/start)
- Next steps

### Phase 6: Verify

18+ smoke tests in two tiers:

**Critical (blocks migration):**
- Scaffolded files exist (package.json, vite.config.ts, setup.ts, etc.)
- Old artifacts removed (deno.json, fresh.gen.ts, etc.)
- No preact imports remain
- No `$fresh` imports remain
- No relative imports to deleted SDK files
- package.json has required dependencies

**Warnings (manual review):**
- No `class=` (should be `className=`)
- No `for=` (should be `htmlFor=`)
- No negative z-index on non-images
- No dead `cache`/`cacheKey`/`loader` exports
- No HTMX attributes (`hx-*`)
- No `site/` imports (should use `~/`)
- No `.ts`/`.tsx` extensions in imports
- `.gitignore` has new stack entries
- `public/` has sprites.svg + favicon.ico

### Phase 7: Bootstrap

Runs automatically after all phases (skipped in `--dry-run`):
1. `npm install` (or `bun install`)
2. `npx tsx node_modules/@decocms/start/scripts/generate-blocks.ts`
3. `npx tsr generate`

## Key Design Decisions

### MigrationContext (types.ts)

Central state object threaded through all phases:

```typescript
interface MigrationContext {
  sourceDir: string;
  dryRun: boolean;
  verbose: boolean;
  files: Map<string, FileRecord>;      // path → metadata + action
  metadata: {
    siteName: string;
    platform: Platform;                  // vtex | shopify | wake | ...
    gtmId?: string;
    themeColors: Record<string, string>;
    themeFonts: string[];
    npmDeps: Map<string, string>;        // extracted from deno.json
  };
  report: {
    scaffolded: string[];
    transformed: string[];
    deleted: string[];
    moved: string[];
    manualReview: { file: string; reason: string; severity: string }[];
  };
}
```

### FileRecord

```typescript
interface FileRecord {
  relativePath: string;
  category: "section" | "island" | "component" | "sdk" | "loader" | "action" | "route" | "static" | "config";
  patterns: DetectedPattern[];           // which old-stack patterns were found
  action: "transform" | "delete" | "move" | "scaffold" | "skip";
  targetPath?: string;                   // for moves
  notes: string[];                       // per-file migration notes
}
```

### Platform Detection

```typescript
// From apps/site.ts or deno.json imports:
type Platform = "vtex" | "shopify" | "wake" | "vnda" | "linx" | "nuvemshop" | "custom";
```

Platform affects: commerce type imports, loader registration, setup.ts template, API proxy configuration.

## Extending the Script

### Adding a New Transform

1. Create `scripts/migrate/transforms/my-transform.ts`:

```typescript
import type { TransformResult } from "../types";

export function myTransform(content: string, filePath: string): TransformResult {
  let changed = false;
  const notes: string[] = [];
  let result = content;

  // Apply your regex/string replacements
  const next = result.replace(/oldPattern/g, "newPattern");
  if (next !== result) {
    changed = true;
    notes.push("Replaced oldPattern → newPattern");
    result = next;
  }

  return { content: result, changed, notes };
}
```

2. Import and add to the pipeline in `phase-transform.ts`:

```typescript
import { myTransform } from "./transforms/my-transform";

// In the transform pipeline array:
const transforms = [imports, jsx, freshApis, deadCode, denoIsms, tailwind, myTransform];
```

### Adding a New Template

1. Create `scripts/migrate/templates/my-file.ts`:

```typescript
import type { MigrationContext } from "../types";

export function generateMyFile(ctx: MigrationContext): string {
  return `// Generated by migration script
export const siteName = "${ctx.metadata.siteName}";
`;
}
```

2. Call from `phase-scaffold.ts`:

```typescript
import { generateMyFile } from "./templates/my-file";
writeScaffolded(ctx, "src/my-file.ts", generateMyFile(ctx));
```

### Adding a Smoke Test

In `phase-verify.ts`:

```typescript
checks.push({
  name: "No foo imports",
  level: "critical",  // or "warning"
  test: () => !grepFiles(ctx, /from ["']foo["']/).length,
  message: "Found foo imports — should be replaced with bar",
});
```

## Common Issues & Debugging

### Script fails at Phase 1 (Analyze)

**Cause**: Source directory structure doesn't match expected Deco layout.
**Fix**: Ensure source has `src/sections/` or `sections/`, `deno.json` or `import_map.json`.

### Transform misses some files

**Cause**: Files outside standard directories (`src/`, `components/`, etc.).
**Fix**: Check `phase-analyze.ts` categorization logic — add new glob patterns if needed.

### Z-index stacking issues after migration

**Cause**: Tailwind v4 changed stacking context behavior. The script auto-fixes `-z-{n}` on images but may miss custom patterns.
**Fix**: Search for remaining `-z-` classes and apply the overlay div pattern from `transforms/tailwind.ts`.

### Opacity modifier not consolidated

**Cause**: Non-adjacent `bg-{color}` + `bg-opacity-{n}` pairs can't be safely consolidated.
**Fix**: Check `MIGRATION_REPORT.md` for flagged opacity items and fix manually.

### Bootstrap fails at generate-blocks

**Cause**: Missing or malformed `.deco/blocks/*.json` files.
**Fix**: Ensure `.deco/blocks/` was copied from source. Check JSON validity.

### package.json has wrong versions

**Cause**: npm registry fetch failed during scaffold.
**Fix**: The script falls back to `"latest"` — run `npm install` manually and check for version conflicts.

## Relationship to Manual Migration

This script handles **Phases 0-6** of the [migration playbook](../deco-to-tanstack-migration/SKILL.md):
- Phase 0 (Scaffold) → `phase-scaffold.ts`
- Phase 1 (Imports) → `transforms/imports.ts`
- Phase 2 (Signals) → `transforms/imports.ts` (bulk only — manual `useSignal` → `useState` still needed)
- Phase 3 (Deco Framework) → `transforms/fresh-apis.ts` + `transforms/deno-isms.ts`
- Phase 4 (Commerce) → `transforms/imports.ts`
- Phase 6 (Islands) → `phase-cleanup.ts` (deletes directory, repoints imports)

**Still manual after the script**:
- Phase 5 (Platform Hooks) — `useCart`, `useUser`, `useWishlist` implementation
- Phase 7-12 — Section registry tuning, route customization, matchers, async rendering, search

The script gets you from "raw Fresh site" to "builds with `npm run build` and has ~0 old imports". Human work starts at runtime debugging and feature wiring.
