---
name: invoke-registry-parity
description: Explains the Fresh-vs-TanStack mismatch in how `runtime.site.loaders.X` and `runtime.site.actions.X` are resolved. In Fresh (@deco/deco) the manifest auto-walks every loader/action file on disk, so any path is reachable. In TanStack (@decocms/start) the build script `generate-loaders.ts` prunes anything not referenced in `.deco/blocks/*.json` when called with `--decofile-dir`, so code-only invocations (header components, hooks) silently 404. Use when a migrated site reports `runtime.site.loaders.X` returning `undefined`, when investigating empty drawers / popups / pickup-point lists, or when planning a generator change in `@decocms/start`.
---

# Invoke registry: Fresh vs TanStack

## Symptom

A storefront migrated from `deco-cx/deco` (Fresh/Deno) to `@decocms/start` (TanStack/Node) calls a loader from React code:

```ts
import { invoke as runtime } from "@decocms/start/sdk";

const data = await runtime.site.loaders.deliveryPromise({ postalCode });
// Fresh: data populated. TanStack: data is undefined.
```

Network tab shows `POST /deco/invoke/site/loaders/deliveryPromise` → **404 `Unknown handler`**. The client invoke proxy swallows the error and returns `undefined`. Drawers stay empty, popups never populate, hooks "just don't fetch".

## Root cause

The two frameworks take **opposite approaches** to invoke registration.

### Fresh (`@deco/deco`) — file-system auto-discovery

`engine/manifest/manifestGen.ts:69-120` walks **every** `.ts`/`.tsx` file under `src/loaders/`, `src/actions/`, `src/sections/`, etc. and adds each one to the `manifest.gen.ts`:

```ts
export const decoManifestBuilder = async (dir, namespace, walker = defaultWalker) => {
  for (const blk of blocks()) {                    // ["loader", "action", "section", ...]
    const blockDir = join(dir, blk.type);
    for await (const entry of walker(blockDir)) {  // walks every file
      paths.push(entry.path);
    }
    for (const path of paths.sort()) {
      initialManifest = withDefinition(...);       // ← adds ALL files to manifest
    }
  }
};
```

At runtime, `state.resolve()` looks the key up in `resolvables` (composed of `release.state()` + manifest). The key resolves whether or not it's referenced by a CMS block. Side-effect: **any loader on disk is callable via `runtime.site.loaders.X`**.

### TanStack (`@decocms/start`) — explicit registry, pruned by decofile

`scripts/generate-loaders.ts:91-141`:

```ts
function collectResolveTypes(dir: string): Set<string> {
  const RESOLVE_RE = /"__resolveType"\s*:\s*"([^"]+)"/g;
  // ... reads every .deco/blocks/*.json and collects __resolveType values
}

const cmsReferences = decofileDir ? collectResolveTypes(decofileDir) : null;

function isReferenced(key: string): boolean {
  if (!cmsReferences) return true;
  return cmsReferences.has(key) || cmsReferences.has(`${key}.ts`);
}

for (const filePath of walkDir(loadersDir)) {
  const key = fileToKey(filePath, loadersDir, "site/loaders");
  if (!isReferenced(key)) {
    prunedCount++;
    continue;                            // ← PRUNED when not in any CMS block
  }
  entries.push({ key, importPath: ... });
}
```

The handler in `src/admin/invoke.ts:133-148` only checks the registry — there is no filesystem fallback:

```ts
function findHandler(key) {
  const registered = handlerRegistry.get(key);          // from registerInvokeHandlers
  if (registered) return { handler: registered, ... };
  const loaders = getRegisteredLoaders();               // from setInvokeLoaders
  if (loaders[key]) return { handler: loaders[key], ... };
  const actions = getRegisteredActions();
  if (actions[key]) return { handler: actions[key], ... };
  return null;                                          // → 404
}
```

So a loader file that exists on disk but is not in `loaders.gen.ts` because of the prune step is **unreachable** from `runtime.site.loaders.X`.

## Why the prune exists

Comment from a site that hit this (Bagaggio, `src/setup/commerce-loaders.ts`):

> The auto-generated `siteLoaders` map which the build step prunes to only the `site/loaders/*` and `site/actions/*` keys actually referenced by the CMS decofile — avoiding the "200 dead passthroughs" pattern that bloated this file before the architectural cleanup.

Intent is good (don't bundle dynamic imports for loaders the CMS never uses), but **breaks code-driven invocation** — a common pattern in Fresh-era storefronts where header components, hooks, and effects call loaders directly without ever putting them in a CMS block.

## How to detect

```bash
# 1. Loaders/actions defined on disk
ls src/loaders/ src/actions/

# 2. Loaders/actions in the registry
grep -E "site/(loaders|actions)/" src/server/cms/loaders.gen.ts

# 3. Compare: anything in (1) but not in (2) is unreachable via runtime.site.*
```

If a `package.json` script reads:

```json
"generate:loaders": "tsx ... generate-loaders.ts ... --decofile-dir .deco/blocks"
```

The `--decofile-dir` flag is the prune trigger. Without it the script registers every file.

## How to fix on a site

### Option A — Drop `--decofile-dir` (recommended for Fresh-migrated sites)

In `package.json`:

```diff
- "generate:loaders": "tsx node_modules/@decocms/start/scripts/generate-loaders.ts --exclude vtex/loaders,vtex/actions --decofile-dir .deco/blocks",
+ "generate:loaders": "tsx node_modules/@decocms/start/scripts/generate-loaders.ts --exclude vtex/loaders,vtex/actions",
```

Then:

```bash
npm run generate:loaders   # regenerates src/server/cms/loaders.gen.ts with all entries
npm run build              # verify
```

Bagaggio went from 8 → 24 entries in `loaders.gen.ts`, +0 dev/runtime errors, ~+5KB to the `invoke.gen` chunk (dynamic imports are lazy, so initial bundle isn't affected).

### Option B — Manual registration in `setup/commerce-loaders.ts`

If you want to keep the prune for everything else and only expose a handful of code-driven loaders:

```ts
// src/setup/commerce-loaders.ts
import siteDeliveryPromise from "../loaders/deliveryPromise";
import siteGetLocationUser from "../loaders/getLocationUser";
import siteAddShippingAddress from "../actions/add_shipping_address";

export const COMMERCE_LOADERS = {
  ...vtexLoaders,
  ...siteLoaders,
  // ...
  "site/loaders/deliveryPromise":    (props, req) => siteDeliveryPromise(props, req),
  "site/loaders/getLocationUser":    (props, req) => siteGetLocationUser(props, req),
  "site/actions/add_shipping_address": (props, req) => siteAddShippingAddress(props, req),
};
```

### Option C (workaround, not idiomatic) — direct `fetch()`

If both options above are blocked, the worker proxy already forwards `/api/checkout/pub/*` to VTEX with cookies. Client code can `fetch()` those endpoints directly, bypassing the invoke registry entirely. Loses server-side retry, logging, and centralization. Acceptable as a temporary fix; not a long-term answer.

## How to fix in the framework

See the open issues:

- **[decocms/deco-start#189](https://github.com/decocms/deco-start/issues/189) — `generate-loaders.ts`: prune-by-decofile should be opt-in**: flip the default so the script registers every file by default; add an explicit `--prune-by-decofile <path>` flag for sites that want the dead-code filter.
- **[decocms/deco-start#190](https://github.com/decocms/deco-start/issues/190) — invoke handler: dev-mode filesystem fallback / actionable 404**: in dev, when a key is unknown, dynamic-import `src/loaders/<key>.ts` and emit a clear warning instead of a silent 404. In prod, at least make the 404 message actionable and stop swallowing it in the client invoke proxy.

Until those land, Option A is the cleanest fix on the site side.

## Verification checklist

After applying a fix:

```bash
# Registry has the expected keys
grep -E "deliveryPromise|getLocationUser|add_shipping" src/server/cms/loaders.gen.ts

# Runtime call succeeds (in dev or against deploy)
curl -X POST http://localhost:5174/deco/invoke/site/loaders/deliveryPromise \
  -H "Content-Type: application/json" \
  -d '{"postalCode":"22765010"}'
# Expected: 200 with VTEX pickup-points payload
# Wrong:    404 "Unknown handler"

# DevTools Network on the actual UI flow
# - Drawer opens / popup auto-fetches → POST /deco/invoke/site/loaders/X → 200
# - Result list populates instead of "Não foi possível obter informações..."
```

## Adjacent context

- The `@decocms/start` invoke route is `/deco/invoke/...`. Fresh's was `/live/invoke/...`. Both shapes are still accepted on the handler.
- `setupApps()` in `@decocms/apps` uses `registerInvokeHandlers()` (additive registry) for VTEX/Shopify keys — independent of `setInvokeLoaders()`. The site-side `generate-loaders.ts` only governs `site/*` keys.
- The same pruning logic also drops loaders that aren't referenced by `__resolveType` even if they're imported in code via `runtime.site.loaders.X`. The static analyzer doesn't see those runtime-string keys.
- This is closely related to (but distinct from) `[[deco-htmx-cache-contamination]]` — that one is about SSR-cached HTML leaking cookies, this is about invoke routing.

## Bagaggio incident — exact reproduction (2026-05)

After migrating Bagaggio from Fresh to TanStack, the delivery-promise drawer showed "Não foi possível obter informações sobre o ponto de coleta" for every CEP. Trace:

1. `Header.tsx` rendered `<ButtonDeliveryPromise>` which `useEffect`-called `runtime.site.loaders.deliveryPromise({ postalCode })`.
2. Network tab: `POST /deco/invoke/site/loaders/deliveryPromise` → **404 Unknown handler**.
3. `loaders.gen.ts` only had `deliveryPromiseProductDetailsPage`, `deliveryPromiseProductList`, `deliveryPromiseProductListingPage` — the simple `deliveryPromise.ts` was pruned.
4. The decofile (`.deco/blocks/*.json`) only referenced the PDP/PLP variants (which were CMS sections) — the simple loader was used only from header code.
5. Fix: dropped `--decofile-dir` from `package.json` `generate:loaders`, regenerated → 24 entries including `site/loaders/deliveryPromise`, `site/loaders/getLocationUser`, `site/actions/deliveryPromise`, `site/actions/add_shipping_address`.

Commit on Bagaggio: `aef24cfb fix(bagaggio): register all site loaders/actions for runtime.site.* invoke`.
