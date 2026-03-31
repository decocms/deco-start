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

**Fix**: Create a **separate** `src/worker-entry.ts` file that wraps TanStack Start's built handler. Point `wrangler.jsonc` to this file instead of `@tanstack/react-start/server-entry`.

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

```jsonc
// wrangler.jsonc -- MUST point to custom entry, NOT the default
{
  "main": "./src/worker-entry.ts",
  // NOT: "main": "@tanstack/react-start/server-entry"
}
```

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
1. Set a `PURGE_TOKEN` secret: `npx wrangler secret put PURGE_TOKEN`
2. Call the purge endpoint: `POST /_cache/purge` with `Authorization: Bearer <token>` and body `{"paths":["/"]}`
3. Automate this in CI/CD (see the deploy.yml workflow)


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
