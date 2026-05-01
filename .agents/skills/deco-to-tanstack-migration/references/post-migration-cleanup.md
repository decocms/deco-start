# Post-Migration Cleanup

After the migration script runs and the site builds + boots, there's a
recurring set of dead-code and boilerplate cleanup that every migrated
site benefits from. Run this checklist before the first PR review, not
after the site has been shipping for weeks.

## Run the audit first

This whole checklist is now automated by the **`deco-post-cleanup`**
audit script (added in `@decocms/start >= 2.11.0`, `--fix` mode in
`>= 2.12.0`). Run it from the site repo to get a structured report
of which sections below actually apply to your codebase:

```bash
# Pretty text output, exits 0 unless --strict is passed
npx -p @decocms/start deco-post-cleanup

# Auto-apply mechanical fixes for the safe rules, then report what's left.
# Safe rules: dead-lib-shims, dead-runtime-shim, local-widgets-types,
# vtex-shim-regression (swap subset), obsolete-vite-plugins,
# local-framework-duplicate (auto-fixable subset of the registry).
# Other rules — and the warn-only entries of local-framework-duplicate —
# stay detect-only. They require human judgment.
npx -p @decocms/start deco-post-cleanup --fix

# Combine for CI: auto-fix safe rules, fail (exit 2) if warnings remain.
npx -p @decocms/start deco-post-cleanup --fix --strict

# Machine-readable JSON for dashboards
npx -p @decocms/start deco-post-cleanup --json
```

The audit covers all 9 rules below and prints the exact file path +
suggested fix for each finding. With `--fix`, the safe rules
auto-apply: `rm` for dead files, regex-anchored import rewrites for
shadowed shims (`local-widgets-types`, `dead-runtime-shim`), the swap
subset of `vtex-shim-regression`, JS-aware removal of obsolete
inline plugin literals from `vite.config.ts`, and rewrite-imports +
delete for the auto-fixable subset of `local-framework-duplicate`
(see § 8). The output explicitly tags rules that require manual work
as `(0 fixed, manual)`, so you always know what's left after auto-fix
runs.

Real-world signal: on baggagio, `--fix` produced a byte-identical
diff to the manual cleanup PR a human had just made (45 files,
+45/-53). On casaevideo-storefront (production), the audit caught
six silent VTEX shim regressions that no `tsc --noEmit` run can
detect — `--fix` covers the swap subset of those automatically since
`>= 2.16.0`. On the same site's `vite.config.ts`, `--fix` removes
both obsolete inline plugins (`site-manual-chunks` +
`deco-stub-meta-gen`) cleanly — ~74 LOC / 2.5 KB gone, attached
comments included.

## 1. Delete unused `src/lib/*` shims

The migration script's `templates/lib-utils.ts` generates 11 shim files
under `src/lib/`. Most of them are NO-OP stubs intended as defensive
bridges for signature mismatches. In practice many sites use zero of them
because their loaders import directly from `@decocms/apps/vtex/utils/*`.

### How to detect

```bash
# From repo root.
for f in src/lib/*.ts; do
  base=$(basename "$f" .ts)
  symbols=$(grep -oE "^export (function|const|interface|type|class) [A-Za-z_][A-Za-z0-9_]*" "$f" | awk '{print $NF}')
  for s in $symbols; do
    # Search for the symbol anywhere in src/ outside src/lib/
    hits=$(rg -l "\\b$s\\b" src/ --type ts --type tsx -g '!src/lib/**')
    if [ -z "$hits" ]; then
      echo "DEAD: $f exports $s with zero external imports"
    fi
  done
done
```

If every export in a file is dead, delete the file. If `src/lib/` ends
up empty, delete the directory too.

### Real-world data

| Site | Files generated | Files used |
|------|-----------------|-----------|
| baggagio-tanstack | 11 | 0 (all dead) |
| casaevideo-storefront | 11 | 1 (wrapped manually) |

The files that tend to be dead in every site:

- `vtex-client.ts` — type-only export, sites usually grab it from `@decocms/apps`
- `vtex-fetch.ts` — `fetchSafe` wrapper, supplanted by `@decocms/apps/vtex/utils/fetch`
- `vtex-id.ts` — manual `parseCookie`, usually shadowed by `~/sdk/orderForm`'s real one
- `vtex-segment.ts` — NO-OP stubs returning empty; never useful
- `vtex-intelligent-search.ts` — stubs returning `{}`; supplanted by apps
- `vtex-transform.ts` — re-exports from `@decocms/apps/vtex/utils/transform` directly
- `vtex-send-event.ts` — claims to mirror an unreleased apps export; almost never imported

The files that occasionally stay used:

- `http-utils.ts` — `createHttpClient` proxy bridge for sites with custom
  HTTP clients
- `graphql-utils.ts` — same shape for GraphQL
- `fetch-utils.ts` — single `STALE` cache header constant (very small)
- `filter-navigate.ts` — VTEX filter URL string transformer

If `apps/utils/*` imports never appear in your Fresh source, ALL FOUR of
the latter are also dead.

## 2. Drop inline vite plugins that are now framework-provided

Two plugins that older site templates inline are obsolete on
`@decocms/start >= 2.5.0`:

```ts
// site-manual-chunks — overrides framework default chunking
{ name: "site-manual-chunks", config(_cfg, { command }) { ... ~25 lines ... } }

// deco-stub-meta-gen — stubs admin schema on client
{ name: "deco-stub-meta-gen", enforce: "pre", resolveId(...), load(...) }
```

The framework's `decoVitePlugin()` now handles both:
- `manualChunks` no longer splits `@decocms/start` / `@decocms/apps` (the
  old split caused circular-dep load-order crashes — every site overrode it)
- `meta.gen.{json,ts}` is stubbed on the client by default

Delete both inline plugins from the site's `vite.config.ts`. Since
`@decocms/start >= 2.19.0`, `deco-post-cleanup --fix` does this for
you — it walks the AST with brace-balanced parsing (template literals
and nested `{}` inside `config()`/`load()` bodies don't trip it up),
removes the literal **plus its trailing comma + attached `// ...`
comment block**, and is idempotent (rerunning is a no-op). Block
comments are left alone. Verify the production build still succeeds
(`vite build` in the site repo).

## 3. Drop the `runtime.ts` `invoke` shim

Older migrations create `src/runtime.ts` with a manual `createNestedInvokeProxy`
implementation (~45 lines). The framework's `@decocms/start/sdk` now exports
both `invoke` (default singleton) and `createAppInvoke` (for typed app-scoped
proxies). Replace the file with a re-export, or delete it and update import
sites:

```diff
- import { invoke } from "~/runtime";
+ import { invoke } from "@decocms/start/sdk";
```

If `~/runtime` was only used for `invoke`, delete the file entirely. If
it had additional helpers, keep it but trim it down to those.

## 4. Drop site-local `withSiteGlobals` workaround

If your site's `cmsRouteConfig` has a `cmsRouteWithGlobals` wrapper that
manually merges `site.global` sections into the page sections list,
delete it and use `@decocms/start/routes`'s opt-in helper:

```ts
import { cmsRouteConfig, withSiteGlobals } from "@decocms/start/routes";

export const Route = createFileRoute(...)({
  ...cmsRouteConfig({
    ...withSiteGlobals,
    // your route options
  }),
});
```

The site-side wrapper is typically ~390 LOC; the framework helper is
opt-in and tested.

## 5. Verify `vtex-* shim regression` is not still happening

Older versions of the migration script's `phase-cleanup` had a bug where
it actively rewrote valid `@decocms/apps/vtex/utils/*` and
`@decocms/apps/vtex/client` imports back to the dead `~/lib/vtex-*` shims.

The post-cleanup audit now classifies **per-symbol**: it reads each
`~/lib/vtex-*` shim file, labels every named export as `stub`,
`type-only`, or `functional`, and only flags an import when at least
one imported symbol is a real silent stub (returns `null` / `{}` / `[]`
/ identity-cast / unconditional throw). Functional helpers shipped
alongside stubs (e.g. a `parseCookie` cookie parser, a `fetchSafe`
wrapper) no longer create noise.

The audit's finding names the exact stub symbols **and emits per-symbol
fix guidance**, e.g.

```
[WARNING] src/loaders/search/x.ts — Imports stub-only symbols from
  vtex-transform (toProduct); vtex-segment (getSegmentFromBag) —
  runtime is silently stubbed
    fix: toProduct → @decocms/apps/vtex/utils/transform (1:1 import swap)
         — canonical signature is `toProduct(product, sku, level, options)`;
         1-arg call sites need to expand args first | getSegmentFromBag →
         call-site refactor: read cookies via `request.headers.get('cookie')`
         then call `buildSegmentFromCookies()` from
         '@decocms/apps/vtex/utils/segment'.
```

JSON consumers can read structured guidance from `meta.fixHints`:

```json
{
  "rule": "vtex-shim-regression",
  "meta": {
    "stubsBySim": { "vtex-transform": ["toProduct"], "vtex-segment": ["getSegmentFromBag"] },
    "fixHints": {
      "toProduct": { "kind": "swap", "canonical": "@decocms/apps/vtex/utils/transform", "note": "..." },
      "getSegmentFromBag": { "kind": "refactor", "note": "..." }
    }
  }
}
```

### Canonical replacement table

| Stub symbol | Kind | Canonical / fix |
|---|---|---|
| `toProduct` | swap | `@decocms/apps/vtex/utils/transform.toProduct` — note canonical signature is `(product, sku, level, options)`; 1-arg call sites need to expand args |
| `withSegmentCookie` | swap | `@decocms/apps/vtex/utils/segment.withSegmentCookie` — note canonical signature is `(segment, headers?)` |
| `getSegmentFromBag` | refactor | read cookies via `request.headers.get('cookie')`, then `buildSegmentFromCookies()` from `@decocms/apps/vtex/utils/segment` |
| `getISCookiesFromBag` | refactor | extract IS cookies from `request.headers.get('cookie')` directly — no canonical helper, the bag-based mechanism doesn't exist on TanStack Start |

Symbols not in the table get the generic guidance ("repoint to
`@decocms/apps/vtex/...` or `apps/commerce/utils/...`") — when you find
a new one worth pinning down, add it to `STUB_FIX_HINTS` in
[`scripts/migrate/post-cleanup/rules.ts`](https://github.com/decocms/deco-start/blob/main/scripts/migrate/post-cleanup/rules.ts).

### Recipe: expanding 1-arg `toProduct(p)` call sites

Two real-world patterns surface, requiring different fixes:

**Pattern A — call site already passes 4 args under `as any`** (e.g.
`smartShelfForYou.ts` on casaevideo): the dev wrote the call for
canonical, the import pointed at the stub. Fix is **import-only**:

```diff
-import { toProduct } from "~/lib/vtex-transform";
+import { toProduct } from "@decocms/apps/vtex/utils/transform";

 const normalizedProducts = rawProducts.data.map((p: VTEXProduct) =>
   (toProduct as any)(p, p.items?.[0], 0, {
     baseUrl: baseURL,
     priceCurrency: "BRL",
   }),
 );
```

The `as any` cast may stay if local `~/types/vtex.Product` and
canonical `LegacyProductVTEX | ProductVTEX` differ structurally — that's
a separate refactor.

**Pattern B — call site uses true 1-arg form** (e.g.
`intelligenseSearch.ts` on casaevideo): the dev relied on the stub's
identity-cast behaviour. Fix is to **expand the call** mirroring the
canonical pattern in
[`apps-start/vtex/loaders/autocomplete.ts`](https://github.com/decocms/apps-start/blob/main/vtex/loaders/autocomplete.ts):

```diff
-import { toProduct } from "~/lib/vtex-transform";
+import { pickSku, toProduct } from "@decocms/apps/vtex/utils/transform";

 const baseURL = new URL(req.url).origin;
 return {
   searches,
-  products: (products ?? []).map((p) => toProduct(p)).slice(0, count),
+  products: (products ?? []).slice(0, count).map((p: any) => {
+    const sku = pickSku(p);
+    return toProduct(p, sku, 0, { baseUrl: baseURL, priceCurrency: "BRL" });
+  }),
 };
```

`pickSku` handles the IS-shape SKU selection; without it, downstream
fields like `productID`, `gtin`, `additionalProperty[]` come back
empty.

**Pattern C — keep the stub deliberately**: rare, but valid when the
upstream API already returns canonical `Product[]` shape and the call
is purely a type-narrowing cast. Replace with a typed cast at the
boundary instead of importing a stub:

```diff
-import { toProduct } from "~/lib/vtex-transform";
+import type { Product } from "@decocms/apps/commerce/types";

-products: (products ?? []).map((p) => toProduct(p)).slice(0, count),
+products: ((products ?? []) as Product[]).slice(0, count),
```

This silences the audit (the stub import is gone) without changing
behaviour. Only do this if you've **verified** the upstream payload is
already schema.org-shaped.

Manual sweep (still useful if you don't have the audit handy):

```bash
rg "from ['\"]~/lib/vtex-" src/
# Expected: 0 hits (or only site-specific reasons you can articulate)
```

When you see real findings, update the imports to point at
`@decocms/apps/vtex/...` directly (or the corresponding
`commerce/utils/*` if it's a generic utility). Your runtime behavior
gets MUCH better — segment cookies, IS cookies, VTEX session auth all
start working again instead of being silently stubbed to `{}` / `null`.

**Note on `--fix`** (since `@decocms/start >= 2.16.0`): the rule
auto-fixes the SAFE subset of swaps — when every imported symbol from
a given shim is a `kind: "swap"` hint to the SAME canonical module.
Concretely:

| Pattern | `--fix` behaviour |
|---|---|
| `import { toProduct } from "~/lib/vtex-transform"` | rewritten to `@decocms/apps/vtex/utils/transform` |
| `import { withSegmentCookie } from "~/lib/vtex-segment"` | rewritten to `@decocms/apps/vtex/utils/segment` |
| `import { getSegmentFromBag, withSegmentCookie } from "~/lib/vtex-segment"` | left untouched (mixed swap + refactor) |
| `import { getISCookiesFromBag } from "~/lib/vtex-intelligent-search"` | left untouched (refactor-only — no canonical drop-in) |
| `import { toProduct, isFilterParam } from "~/lib/vtex-transform"` | left untouched (would lose the real impl) |

The auto-fix rewrites only the `from "..."` clause — the imported
names list is preserved verbatim, so `as`-aliased imports (e.g.
`{ toProduct as toP }`) keep working. After the import swap you may
still need to expand 1-arg `toProduct(p)` call sites to the canonical
4-arg signature — see § 5 below.

The refactor-only cases (`getSegmentFromBag`, `getISCookiesFromBag`,
mixed surfaces) intentionally stay manual: the bag-based lookup
mechanism doesn't exist on TanStack Start, so each call site needs a
human reading `request.headers.get('cookie')` and calling
`buildSegmentFromCookies()` from the canonical module.

## 6. Drop `src/types/widgets.ts` — framework owns it

Older migrations scaffold a local `src/types/widgets.ts` containing 8
string-aliased widget types (`ImageWidget`, `HTMLWidget`, …). The
framework now exports the same set (plus `TextArea`) at
`@decocms/start/types/widgets`, and the schema generator detects the
widgets via type-text matching, so the local file is purely
duplicated boilerplate.

```bash
# Quick check
rg -n "from ['\"]~/types/widgets['\"]" src/ | wc -l   # >0 → cleanup applies
```

Replace all imports in one pass:

```bash
# macOS / BSD sed: drop the empty quotes after -i
rg -l "from ['\"]~/types/widgets['\"]" src/ \
  | xargs sed -i '' "s|from ['\"]~/types/widgets['\"]|from \"@decocms/start/types/widgets\"|g"
```

Then delete the now-orphan local file:

```bash
rm src/types/widgets.ts
```

Confirm `tsc --noEmit` is still clean — the framework version is a
strict superset of what the migration script generated.

## 7. Verify no leftover HTMX residue in `src/`

For sites that came from a Fresh codebase using HTMX (`@deco/htmx`,
`hx-*` attributes on JSX elements), the migration to TanStack Start
requires **rewriting** every HTMX interaction to React state +
event handlers + `useNavigate()`/sub-routes. The framework
intentionally ships **no** HTMX runtime — leaving `hx-*` attributes
in the migrated `src/` tree means the corresponding interaction is
silently dead.

The audit's `htmx-residue` rule scans every `*.{ts,tsx}` under `src/`
(excluding `*.test.tsx` / `*.spec.ts` / `__tests__/`) for any
remaining `hx-*` attribute, classifies each occurrence into one of
seven categories (`event-handler`, `form-swap`, `click-swap`,
`auto-fetch`, `oob-swap`, `boost`, `unmatched`), and emits one
warning per file with a category breakdown:

```
[WARNING] src/components/AddToBagButton.tsx:14 — 1 hx-* element(s) — event-handler=1
  fix: Rewrite per .agents/skills/deco-to-tanstack-migration/references/htmx-rewrite.md
       (run `deco-htmx-analyze` for the per-category breakdown)
```

The rule is intentionally **detect-only**:

- The rewrites are non-mechanical — choosing between a local state
  machine, a sub-route, a React form action, or a platform hook
  (e.g. `useCart`) varies per call site and depends on the data
  flow, not just the attribute cluster.
- The companion CLI `deco-htmx-analyze` produces a richer inventory
  (top tags, sample line numbers, JSON output) when you need to
  triage hundreds of occurrences across a large repo.
- The `references/htmx-rewrite.md` skill is the per-pattern
  playbook with before/after code for each of the seven categories.

In `--strict` mode any residue exits 2 — wire that into CI once a
site has finished its HTMX rewrite to prevent regressions sneaking
back in via copy-paste from a Fresh source.

## 8. Drop site-local copies of framework code (`local-framework-duplicate`)

The audit's `local-framework-duplicate` rule encodes a registry of
files we expect sites to NOT carry locally because the canonical
implementation already ships in `@decocms/start`. New entries go in
`scripts/migrate/post-cleanup/rules.ts → FRAMEWORK_DUPLICATES`.

Two kinds of finding:

| Kind | Auto-fix | Example | What you do |
|---|---|---|---|
| **Pure dup** (`safeToAutoFix: true`) | YES | `src/sdk/clx.ts` matches `@decocms/start/sdk/clx` byte-for-byte | `--fix` rewrites every `from "~/sdk/clx"` to `from "@decocms/start/sdk/clx"` and deletes the file. Zero behavior change. |
| **Partial overlap** (`safeToAutoFix: false`) | NO | `src/sdk/useSendEvent.ts` (typed) overlaps `@decocms/start/sdk/analytics → useSendEvent` (permissive) | The rule emits a `warning` with a `reason` explaining the manual judgement: widen the framework export, accept type loss, or fork on purpose. Human picks. |

### How the rule fires

The site file must match every regex in `contentSignature` before
the rule treats it as the framework dup. This is conservative on
purpose — sites that genuinely forked the helper (added platform
logic, wrapped in something else) are skipped automatically.

### Current registry

| Site path | Canonical | Auto-fix? | Reason / status |
|---|---|---|---|
| `src/sdk/clx.ts` | `@decocms/start/sdk/clx` | yes | Identical implementation; baggagio's extra `clsx` alias has zero callers. |
| `src/sdk/useSendEvent.ts` | `@decocms/start/sdk/analytics` | no | Site copy uses `<E extends AnalyticsEvent>` generic; framework export is permissive. Replace 1:1 = type-safety loss. Either widen the framework first or accept the loss. |
| `src/matchers/location.ts` | `@decocms/start/matchers/builtins` | no | Framework's `registerBuiltinMatchers()` ships a richer location matcher (`request.cf` first, geo cookies fallback, headers fallback) plus 10 sibling matchers. Adopting changes behaviour — verify country-name lookup parity, swap `setup.ts`'s `customMatchers` entry. |

### Adding a new entry

When you spot a site carrying its own copy of code that lives in
`@decocms/start`, add an entry to `FRAMEWORK_DUPLICATES`:

```ts
{
  id: "<short-stable-id>",
  sitePath: "src/<path>.ts",
  canonicalImport: "@decocms/start/<path>",
  contentSignature: [/<regex 1>/, /<regex 2>/],
  safeToAutoFix: true | false,
  reason: "<required when not safeToAutoFix>",
  description: "<one-liner used in finding message>",
}
```

Per **D4** in the migration tooling policy, the framework promotion
itself happens at 3+ sites. This registry is the *enforcement* layer
once promoted: every other site picks up the convergence
automatically the next time `deco-post-cleanup --fix` runs.

## 9. Search for orphan `TODO: move into framework` comments

Real sites accumulate `TODO` comments like `// TODO: move into decoVitePlugin
in next @decocms/start release`. These are roadmap items the framework
team should pick up, but they often go stale.

```bash
rg -n "TODO.*deco|TODO.*framework|TODO.*move into" src/ vite.config.ts
```

For each hit, decide:
- Has the framework feature shipped? → migrate to it now and delete the comment
- Is it deferred indefinitely? → file a tracking issue and link from the comment
- Is it obsolete? → delete the comment

## Verification checklist

After completing 1-9:

- [ ] `npm run typecheck` baseline matches pre-cleanup count (no new errors)
- [ ] `npm run dev` starts and `/`, `/some-pdp/p`, `/s?q=foo` all render
- [ ] `npm run build` succeeds with no chunk-load crashes
- [ ] Smoke a logged-in PDP to confirm session cookies and segment auth
      work (this is what the `~/lib/vtex-*` regression silently broke)
- [ ] `git diff --stat` shows only deletions or framework-helper substitutions
      — no new site-local logic added
