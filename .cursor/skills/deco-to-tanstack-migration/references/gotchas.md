# Migration Gotchas

Common pitfalls encountered during the Deco -> TanStack Start migration.

## 1. Section Loaders Don't Execute

Deco sections have `export const loader = async (props, req, ctx) => { ... }` that runs server-side before the component renders. In TanStack Start, these don't execute automatically.

**Fix**: Either:
- Move loader logic to a TanStack route loader
- Call it from a `createServerFn`
- Pass defaults and handle missing data gracefully in the component

## 2. useEffect Doesn't Run on Server

Components relying on `useEffect` to populate state will render empty on SSR, causing hydration mismatches.

**Fix**: Use TanStack route loaders or `createServerFn` to fetch data before rendering.

## 3. Signal .value in Render Doesn't Re-render

Reading `signal.value` inside a React render function doesn't create a subscription. The component won't re-render when the signal changes.

**Fix**: Use `useStore(signal.store)` from `@tanstack/react-store` for reactive reads in render. Write-only access (in event handlers) can still use `.value` setter.

## 4. class vs className

Preact accepts both `class` and `className`. React only accepts `className`. Most JSX files already use `className`, but some (especially `Drawer.tsx`, `Aside` components) use `class`.

**Fix**: Grep for `class=` (without `Name`) in JSX and replace.

## 5. dangerouslySetInnerHTML Syntax

Preact and React use the same syntax, but some Deco components use `innerHTML` directly.

**Fix**: Replace with `dangerouslySetInnerHTML={{ __html: content }}`.

## 6. ComponentChildren -> ReactNode

Not just a type rename -- `ComponentChildren` in Preact accepts `null | undefined | boolean | number | string | VNode`, while `ReactNode` in React is similar but has subtle differences. Usually fine in practice.

## 7. VTEX API Auth on Cloudflare Workers

`createServerFn` handlers run on Workers. Environment variables must be set via `wrangler secret put` or `.dev.vars`, not `.env`.

## 8. Cookie Handling

Deco's VTEX integration handles `checkout.vtex.com__orderFormId` cookies automatically. In TanStack Start, you manage them manually via `document.cookie` on the client.

## 9. Build Succeeds but Runtime Fails

After import rewrites, always test:
1. `npm run build` (catches type/import errors)
2. `npm run dev` + visit pages (catches runtime errors)
3. Test interactive features: cart add, drawer open/close, search

## 10. npm link for Local Dev

When developing across `deco-start`, `apps-start`, and the storefront simultaneously:

```bash
cd apps-start && npm link
cd ../deco-start && npm link
cd ../my-store && npm link @decocms/apps @decocms/start
```

Verify linked versions: `grep version node_modules/@decocms/*/package.json`

## 11. SVG Attributes

React uses camelCase for SVG attributes (`strokeWidth`, `fillRule`). Preact accepts either. The React compiler will warn about `stroke-width` etc.

**Fix**: `sed -i '' 's/stroke-width/strokeWidth/g'`

## 12. No Compat Layers

After migration is complete:
- `src/compat/` directory must not exist
- `tsconfig.json` paths should only have `~/*`
- `vite.config.ts` aliases should only have `~`
- `@decocms/start` should have zero files in `src/compat/`
- `@decocms/apps` should have zero files in `compat/`

## 13. AsyncLocalStorage in Client Bundles

`@decocms/start/cms/loader.ts` uses `AsyncLocalStorage` from `node:async_hooks` for per-request decofile overrides. Vite's client build replaces `node:async_hooks` with an empty shim. A direct named import breaks:

```typescript
// BROKEN in client build:
import { AsyncLocalStorage } from "node:async_hooks";
// -> Error: "AsyncLocalStorage" is not exported by "__vite-browser-external"
```

**Fix**: Use namespace import + runtime conditional:

```typescript
import * as asyncHooks from "node:async_hooks";

const ALS = (asyncHooks as any).AsyncLocalStorage;
const blocksOverrideStorage = ALS
  ? new ALS()
  : { getStore: () => undefined, run: (_s: any, fn: any) => fn() };
```

This happens when client-side routes import from `@decocms/start/cms` (barrel export), pulling in `loader.ts` transitively. The namespace import avoids Rollup's named-export validation, and the runtime check prevents construction errors in the browser.

## 14. TanStack Start Strips Custom Fetch Callbacks

Custom logic inside `createServerEntry({ async fetch(request) { ... } })` may be stripped by Vite/Rollup in production builds. TanStack Start's build process transforms the server entry, and custom request interception code gets lost.

**Symptom**: Admin routes like `/live/_meta` return HTML (the page) instead of JSON in production, even though they work in `dev`.

**Fix**: Handle admin routes in `createDecoWorkerEntry` (the outermost Cloudflare Worker wrapper), NOT inside `createServerEntry`. Pass admin handlers as options:

```typescript
export default createDecoWorkerEntry(serverEntry, {
  admin: { handleMeta, handleDecofileRead, handleDecofileReload, handleRender, corsHeaders },
});
```

This ensures admin route interception survives the build because it's in the Worker's own fetch handler, outside of TanStack's build pipeline.

## 15. DaisyUI v4 Theme in Preview Shell

DaisyUI v4 with Tailwind v4's `@plugin "daisyui/theme"` scopes all color variables to `[data-theme="light"]`. The admin preview HTML shell (`/live/previews/*`) must include this attribute, or colors will be wrong.

**Symptom**: Preview in admin shows default/missing colors while production looks correct.

**Fix**: Configure the preview shell in `setup.ts`:

```typescript
setRenderShell({
  css: appCss,
  fonts: [...],
  theme: "light",     // adds data-theme="light" to <html>
  bodyClass: "bg-base-100 text-base-content",
  lang: "pt-BR",
});
```

The production HTML has `<html lang="pt-BR" data-theme="light">` set by the TanStack root layout. The preview shell must replicate this.

## 16. Admin Route Cache Bypass

Admin endpoints (`/live/_meta`, `/.decofile`, `/live/previews/*`) must NEVER be cached by Cloudflare's edge cache. They serve dynamic JSON/HTML and have CORS headers that vary by request origin.

**Fix**: `/live/` and `/.decofile` are included in `DEFAULT_BYPASS_PATHS` in `createDecoWorkerEntry`. Admin routes are intercepted BEFORE any caching logic runs.

If you see stale or incorrect responses from admin endpoints, check:
1. The admin route handler runs before `caches.open()` in the Worker fetch
2. Cache-busting: append `?t=${Date.now()}` to verify
3. The response has correct `Content-Type: application/json` (not text/html)

## 17. SiteTheme Component is a Stub

In migrated storefronts, `components/ui/Theme.tsx` returns `null`. The CMS Theme section colors are NOT applied at runtime -- all colors come from the compiled CSS via `@plugin "daisyui/theme"` in `app.css`.

If the CMS has a Theme section with color values that differ from `app.css`, those CMS values are silently ignored. This is intentional: the source of truth for colors moves from CMS to CSS at build time.

**If you need dynamic themes**: Implement `SiteTheme` to render a `<style>` tag with CSS custom properties, converting the Theme section's color props to DaisyUI variables. But this adds complexity and is rarely needed.

## 18. Loader References in JSON Schema (`Resolvable`)

When sections have properties that can be either literal data OR a loader reference (e.g., `products: Product[]` which can also be `{ __resolveType: "vtex/loaders/..." }`), the schema must define a `Resolvable` definition.

Key requirements:
- The definition key must be the literal string `"Resolvable"` (the admin's `deRefUntil` function looks for it by name)
- It must have `additionalProperties: true` (to allow `__resolveType` + `props`)
- Properties that accept loader references must be wrapped in `anyOf: [originalSchema, { $ref: "#/definitions/Resolvable" }]`
- The `composeMeta()` function in `schema.ts` handles this via `wrapResolvableProperties()`

Without this, the admin shows "Incorrect type. Expected 'array'" for fields that contain loader references in the `.decofile`.
