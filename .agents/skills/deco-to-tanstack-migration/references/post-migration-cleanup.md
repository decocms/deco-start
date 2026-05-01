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
# Safe rules: dead-lib-shims, dead-runtime-shim, local-widgets-types.
# Other rules stay detect-only — they require human judgment.
npx -p @decocms/start deco-post-cleanup --fix

# Combine for CI: auto-fix safe rules, fail (exit 2) if warnings remain.
npx -p @decocms/start deco-post-cleanup --fix --strict

# Machine-readable JSON for dashboards
npx -p @decocms/start deco-post-cleanup --json
```

The audit covers all 7 rules below and prints the exact file path +
suggested fix for each finding. With `--fix`, the three safe rules
auto-apply (`rm` for dead files, regex-anchored import rewrites for
shadowed shims). The output explicitly tags rules that require manual
work as `(0 fixed, manual)`, so you always know what's left after
auto-fix runs.

Real-world signal: on baggagio, `--fix` produced a byte-identical
diff to the manual cleanup PR a human had just made (45 files,
+45/-53). On casaevideo-storefront (production), the audit caught
six silent VTEX shim regressions that no `tsc --noEmit` run can
detect — those still require manual cleanup until rule 5 gains a
per-shim mapping table.

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

Delete both inline plugins from the site's `vite.config.ts`. Verify the
production build still succeeds (`vite build` in the site repo).

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

## 7. Search for orphan `TODO: move into framework` comments

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

After completing 1-7:

- [ ] `npm run typecheck` baseline matches pre-cleanup count (no new errors)
- [ ] `npm run dev` starts and `/`, `/some-pdp/p`, `/s?q=foo` all render
- [ ] `npm run build` succeeds with no chunk-load crashes
- [ ] Smoke a logged-in PDP to confirm session cookies and segment auth
      work (this is what the `~/lib/vtex-*` regression silently broke)
- [ ] `git diff --stat` shows only deletions or framework-helper substitutions
      — no new site-local logic added
