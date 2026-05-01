# Post-Migration Cleanup

After the migration script runs and the site builds + boots, there's a
recurring set of dead-code and boilerplate cleanup that every migrated
site benefits from. Run this checklist before the first PR review, not
after the site has been shipping for weeks.

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
Confirm your loaders import direct from `@decocms/apps`:

```bash
rg "from ['\"]~/lib/vtex-" src/
# Expected: 0 hits (or only site-specific reasons you can articulate)
```

If you see hits, update the imports to point at `@decocms/apps/vtex/...`
directly (or the corresponding `commerce/utils/*` if it's a generic
utility). Your runtime behavior gets MUCH better — segment cookies, IS
cookies, VTEX session auth all start working again instead of being
silently stubbed to `{}` / `null`.

## 6. Search for orphan `TODO: move into framework` comments

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

After completing 1-6:

- [ ] `npm run typecheck` baseline matches pre-cleanup count (no new errors)
- [ ] `npm run dev` starts and `/`, `/some-pdp/p`, `/s?q=foo` all render
- [ ] `npm run build` succeeds with no chunk-load crashes
- [ ] Smoke a logged-in PDP to confirm session cookies and segment auth
      work (this is what the `~/lib/vtex-*` regression silently broke)
- [ ] `git diff --stat` shows only deletions or framework-helper substitutions
      — no new site-local logic added
