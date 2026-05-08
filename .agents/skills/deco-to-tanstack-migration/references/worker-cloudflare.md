# Worker / Cloudflare / Build Gotchas

> TanStack worker entry stripping, setup ordering, AsyncLocalStorage, cache, npm.


## 9. Build Succeeds but Runtime Fails

After import rewrites, always test: build → dev → visit pages → test interactive features.


## 10. npm link for Local Dev

```bash
cd apps-start && npm link
cd ../deco-start && npm link
cd ../my-store && npm link @decocms/apps @decocms/start
```


## 12. No Compat Layers

After migration: no `src/compat/`, only `~/*` alias, zero compat files in packages.


## 13. AsyncLocalStorage in Client Bundles

Use namespace import + runtime conditional (or the `deco-server-only-stubs` Vite plugin).


## 14. TanStack Start Ignores Custom Worker Entry Code

**Severity**: CRITICAL -- cache logic, admin routes, and any custom request interception will silently not work in production.

TanStack Start's Cloudflare adapter **completely ignores** the `export default` in `server.ts`. It generates its own Worker entry that calls `createStartHandler(defaultStreamHandler)` directly. Custom logic inside `createServerEntry({ async fetch(request) { ... } })` is also stripped by Vite/Rollup in production builds.

**Symptom**: Admin routes like `/live/_meta` return HTML instead of JSON. Edge caching (Cache API, X-Cache headers) doesn't work despite being implemented. Every request hits the origin at full SSR cost. The `Cache-Control` headers from route-level `headers()` functions appear correctly (because TanStack applies them), but the custom `X-Cache` header and cache storage never execute.

**Diagnosis**: Search the built `dist/server/worker-entry-*.js` bundle for your custom code (e.g., `X-Cache`, `caches.open`, `_cache/purge`). If absent, TanStack stripped it.

**Fix**: Create a **separate** `src/worker-entry.ts` file that wraps TanStack Start's built handler. Wrangler is told to use this file via `main: "./src/worker-entry.ts"` in the site's `wrangler.jsonc`.

```typescript
// src/worker-entry.ts
import "./setup";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
import { handleMeta, handleDecofileRead, handleDecofileReload, handleRender, corsHeaders } from "@decocms/start/admin";

const serverEntry = createServerEntry({
  async fetch(request) {
    return await handler.fetch(request);
  },
});

export default createDecoWorkerEntry(serverEntry, {
  admin: { handleMeta, handleDecofileRead, handleDecofileReload, handleRender, corsHeaders },
});
```

The `main` field is set centrally so a future migration of the entry path
applies to every site at once (single PR to the template). There is no
per-site override file; if a single site truly needs a different
entry path, change the template (and accept that all sites get it) or add a
substitution token like `$WORKER_ENTRY_PATH` and feed it from a per-site env.

This ensures admin route interception AND edge caching survive the build because they're in the Worker's own fetch handler, outside of TanStack's build pipeline.


## 19. `import "./setup"` Ordering (CRITICAL)

`import "./setup"` MUST be the first import in both `server.ts` and `worker-entry.ts`. Without it, server functions in Vite split modules execute before `setBlocks()` has been called, causing `resolveDecoPage` to return null → 404 on client-side navigation.

**Symptom**: SSR works fine (F5), but clicking links shows "No CMS page block matches this URL".


## 20. loadDeferredSection Must Use POST

Without this, the admin shows "Incorrect type. Expected 'array'" for fields that contain loader references in the `.decofile`.


## 24. new URL() with Relative Paths Fails in Workers

`new URL("/product/p")` works in browsers (uses `window.location` as base) but throws `Invalid URL` in Workers/Node because there's no implicit base.

**Fix**: Always provide a base URL:
```typescript
const parsed = new URL(url, "https://localhost");
return parsed.pathname + parsed.search;
```


## 25. Global Variables Throw ReferenceError

Code that references undeclared globals (e.g., `userAddressData` injected by VTEX scripts) will throw `ReferenceError: X is not defined` in Workers where those scripts don't run.

**Fix**: Access via `globalThis`:
```typescript
const data = (globalThis as any).userAddressData;
if (data && Array.isArray(data)) { /* use data */ }
```


## 26. Section-Type Props Use __resolveType Format

In the new `@decocms/start`, section-type props from the CMS arrive as `{ __resolveType: "site/sections/Foo.tsx", ...props }`, NOT the old `{ Component, props }` format. Components that render section props must handle this.

**Fix**: Create a `RenderSection` bridge component that:
1. Checks for `section.Component` (old format) and renders directly
2. Checks for `section.__resolveType` (new format), resolves via `getSection()` from `@decocms/start/cms`, and renders with `React.lazy` + `Suspense`


## 27. jsdom Must Be Replaced in Workers

`jsdom` is a heavy Node.js dependency that cannot run in Cloudflare Workers. Components using it for HTML sanitization must use `dompurify` instead.

**Fix**: Replace `import { JSDOM } from "jsdom"` with:
```typescript
import DOMPurify from "dompurify";
const clean = typeof document !== "undefined" ? DOMPurify.sanitize(html) : html;
```


## 28. Deno npm: Prefix Must Be Removed

Imports like `import Color from "npm:colorjs.io"` use the Deno-specific `npm:` prefix. Vite/Node don't understand it.

**Fix**: Remove the `npm:` prefix and install the package: `npm install colorjs.io`.


## 30. Stale Edge Cache After Deploy Requires Explicit Purge

**Severity**: MEDIUM — causes "Failed to fetch dynamically imported module" errors

After deploying a new build to Cloudflare Workers, the edge cache may still serve old HTML that references previous JS bundle hashes. This causes module import failures.

**Fix**: After every deploy, purge the cache:
1. Set a `PURGE_TOKEN` secret. Add `SECRET_PURGE_TOKEN` to the site repo's
   GitHub Secrets, then trigger the centralized `Sync worker secrets`
   workflow (`workflow_dispatch` → `apply`). This pushes it to the Cloudflare
   worker via `wrangler secret put PURGE_TOKEN`. **Do not** run
   `npx wrangler secret put` manually per-site — the central workflow keeps
   GitHub and Cloudflare in sync.
2. Call the purge endpoint: `POST /_cache/purge` with `Authorization: Bearer <token>` and body `{"paths":["/"]}`
3. Currently this lives in each storefront's per-site `deploy.yml` (D6 centralization was reverted; D6.3 Workers Builds replacement is in flight).


## 44. Runtime Module Import Kills Lazy-Loaded Sections

**Severity**: HIGH — sections silently disappear, data appears in RSC streaming but component renders nothing

Vite tree-shakes unused imports in production builds, so a section file that imports a non-existent module may pass `npm run build` without errors. But at runtime, when the section is dynamically imported via `registerSections`'s lazy `() => import("./sections/X")`, ALL imports in the module execute. A missing file kills the entire section module.

**Symptom**: Product shelves or other sections disappear. HTML size drops significantly. Product data appears in React streaming data (`$R[...]` notation) but zero product cards render as actual HTML. No error in the build log.

**Example**:
```typescript
// sections/Product/ProductShelf.tsx
import LoadingCard from "~/components/product/loadingCard";  // file doesn't exist!
export { default, loader } from "~/components/product/ProductShelf";

export function LoadingFallback() {
  return <LoadingCard />;  // only used here — tree-shaken in build
}
```

Build passes because `LoadingFallback` is a named export that nothing imports. But at runtime, the dynamic `import("./sections/Product/ProductShelf")` executes the module, hits the missing `loadingCard` import, and the entire section fails to load.

**Fix**: Create the missing file, even if it's a minimal stub:
```typescript
// components/product/loadingCard.tsx
export default function LoadingCard() {
  return <div className="animate-pulse bg-base-200 h-[400px] w-[200px] rounded" />;
}
```

**Prevention**: After copying files from the original repo, verify all imports resolve:
```bash
npx tsc --noEmit  # catches missing modules that Vite's tree-shaking hides
```


## 45. GitHub Packages npm Requires Auth Even for Public Packages

**Severity**: MEDIUM — blocks dependency installation for new contributors and CI

GitHub Packages' npm registry (`npm.pkg.github.com`) requires authentication even for public packages. This is a known limitation that GitHub has not resolved. Attempting to `npm install` a public `@decocms/*` package without a token returns `401 Unauthorized`.

**Workaround A (recommended for development)**: Use `github:` Git URL syntax instead of npm registry references. This bypasses the npm registry entirely and uses Git HTTPS (no auth needed for public repos):

```json
{
  "@decocms/apps": "github:decocms/apps-start",
  "@decocms/start": "github:decocms/deco-start#main"
}
```

**Important**: The repo name in the `github:` URL must match the actual GitHub repo name, not the npm package name. `@decocms/start` is published from repo `decocms/deco-start`, NOT `decocms/start`.

**Workaround B (recommended for production)**: Publish to npmjs.com instead. Only npm's public registry supports truly zero-auth public package installation.

**Workaround C (if you must use GitHub Packages)**: Generate a GitHub PAT with `read:packages` scope and configure:
```bash
npm config set //npm.pkg.github.com/:_authToken <YOUR_TOKEN>
```

Or in project `.npmrc` with an env var (for CI):
```
@decocms:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

**Tradeoff with `github:` syntax**: No semver resolution — `npm update` is meaningless. Pin to a tag for stability: `github:decocms/deco-start#v0.14.2`. Without a tag, you get HEAD of the default branch.


## 46. Deploy / Wrangler Config (interim, D6.3 in flight)

**Status (2026-05-07)**: D6.2's centralized App-mediated dispatch was
**reverted** in favour of Cloudflare Workers Builds owning the deploy
pipeline per-worker. The Workers Builds onboarding plan is being
designed in a follow-up PR. Until it lands, this section describes the
**interim state**: each storefront retains its own per-site inline
`deploy.yml` workflow (the original pre-D6 setup), with its own
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets.

Site repos **do** commit a per-site `wrangler.jsonc` during the interim
period. The `deco-wrangler` CLI no longer ships from `@decocms/start`.

### What changes when Workers Builds onboarding ships

When the D6.3 replacement lands, expect:

- Per-storefront CF Builds connection (one dashboard click per worker).
- Per-site `.github/workflows/deploy.yml` removed; CF Builds takes over
  on push.
- `wrangler.jsonc` continues to live in the site repo, but a `deco-build`
  CLI in `@decocms/start` regenerates the bindings (KV, R2, etc.) from a
  central template at build time so customers can't add bindings to
  other tenants' resources.
- `name` field in `wrangler.jsonc` is enforced by CF (verified against
  `baggagio-tanstack` 2026-05-07 — a malicious `name` value is ignored
  and CF auto-opens a PR to fix it).

Until then, do NOT scaffold caller stubs that reference
`decocms/deco-start/.github/workflows/*.yml@vN` — those workflows are
gone.
