# Migration Gotchas

27 pitfalls discovered during real migrations (espacosmart-storefront, osklen).

## 1. Section Loaders Don't Execute

Deco sections have `export const loader = async (props, req, ctx) => { ... }` that runs server-side. In TanStack Start, these don't execute automatically.

**Fix**: Register them via `registerSectionLoaders()` in `setup.ts`.

## 2. useEffect Doesn't Run on Server

Components relying on `useEffect` to populate state will render empty on SSR.

**Fix**: Use TanStack route loaders or section loaders for server-side data.

## 3. Signal .value in Render Doesn't Re-render

Reading `signal.value` inside React render doesn't create a subscription.

**Fix**: Use `useStore(signal.store)` from `@tanstack/react-store` for reactive reads.

## 4. class vs className

Preact accepts both. React only accepts `className`.

**Fix**: `grep -rn ' class=' src/ --include='*.tsx'` and replace in JSX contexts.

## 5. dangerouslySetInnerHTML Syntax

Some Deco components use `innerHTML` directly.

**Fix**: `dangerouslySetInnerHTML={{ __html: content }}`.

## 6. ComponentChildren → ReactNode

Not just a type rename. Usually fine in practice.

## 7. VTEX API Auth on Cloudflare Workers

Env vars must be set via `wrangler secret put` or `.dev.vars`, not `.env`.

## 8. Cookie Handling

In TanStack Start, manage `checkout.vtex.com__orderFormId` cookies manually via `document.cookie`.

## 9. Build Succeeds but Runtime Fails

After import rewrites, always test: build → dev → visit pages → test interactive features.

## 10. npm link for Local Dev

```bash
cd apps-start && npm link
cd ../deco-start && npm link
cd ../my-store && npm link @decocms/apps @decocms/start
```

## 11. SVG Attributes

React uses camelCase: `strokeWidth`, `fillRule`, `clipPath`, etc.

## 12. No Compat Layers

After migration: no `src/compat/`, only `~/*` alias, zero compat files in packages.

## 13. AsyncLocalStorage in Client Bundles

Use namespace import + runtime conditional (or the `deco-server-only-stubs` Vite plugin).

## 14. TanStack Start Strips Custom Fetch Callbacks

Custom logic in `createServerEntry({ fetch })` gets stripped in production builds.

**Fix**: Handle admin routes in `createDecoWorkerEntry`, not `createServerEntry`.

## 15. DaisyUI Theme in Preview Shell

Preview shell must have `data-theme="light"` on `<html>`. Configure via `setRenderShell()`.

## 16. Admin Route Cache Bypass

`/live/` and `/.decofile` are in `DEFAULT_BYPASS_PATHS`. Admin routes are intercepted before caching.

## 17. SiteTheme is a Stub

`Theme.tsx` returns `null`. Colors come from CSS at build time, not CMS at runtime.

## 18. Loader References in JSON Schema

`Resolvable` definition with `additionalProperties: true` needed for props that accept loader refs.

---

## 19. `import "./setup"` Ordering (CRITICAL)

`import "./setup"` MUST be the first import in both `server.ts` and `worker-entry.ts`. Without it, server functions in Vite split modules execute before `setBlocks()` has been called, causing `resolveDecoPage` to return null → 404 on client-side navigation.

**Symptom**: SSR works fine (F5), but clicking links shows "No CMS page block matches this URL".

## 20. loadDeferredSection Must Use POST

Large section props (images, text, URLs) serialized as URL query params (GET) exceed the 8KB header size limit.

**Symptom**: Deferred sections fail with HTTP 431 (Request Header Fields Too Large).

**Fix**: `loadDeferredSection` uses `method: "POST"` in `@decocms/start ≥ 0.16.3`.

## 21. mergeSections Must Use Index-Based Sorting

When multivariate flags resolve to 0 items, slot-filling logic breaks (totalSlots < actual section count). Footer ends up at position ~4 instead of 21.

**Fix**: `@decocms/start ≥ 0.16.4` uses index-based sorting. Eager sections are stamped with their original CMS position.

## 22. Case-Sensitive Imports on Linux CI

macOS filesystem is case-insensitive: `import from "MyAccount/..."` works even if folder is `myAccount/`. Linux CI is case-sensitive and fails.

**Fix**: Always match exact file/folder casing. Grep for mismatches before pushing.

## 23. fn.toString() Hydration Mismatch in Analytics

`useScriptAsDataURI(fn, ...)` calls `fn.toString()`. React Compiler transforms the function differently on server vs client, causing mismatched `<script src="data:...">`.

**Fix**: Use `useScript(fn, args)` with `dangerouslySetInnerHTML` + `suppressHydrationWarning`:
```tsx
<script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: useScript(fn, args) }} />
```

## 24. Vite deco-server-only-stubs Plugin Required

Client bundles that transitively import `node:async_hooks`, `react-dom/server`, or `node:stream` crash without stub replacements.

**Fix**: Include the `deco-server-only-stubs` plugin in `vite.config.ts`. See `templates/vite-config.md`.

## 25. resolve.dedupe in vite.config.ts

Without deduplicating React and TanStack packages, multiple instances cause "Invalid hook call" errors and router context mismatches.

**Fix**: Add `resolve.dedupe` array with react, react-dom, and all @tanstack/* packages.

## 26. QueryClientProvider in __root.tsx

Required even if you don't use React Query directly. @decocms/apps hooks may use it internally.

**Fix**: Always include `QueryClientProvider` in `__root.tsx`. See `templates/root-route.md`.

## 27. process.env.DECO_SITE_NAME via Vite define

Must be injected at build time via `define` in `vite.config.ts`, not read at runtime. Otherwise SSR and client render different values.

**Fix**: `define: { "process.env.DECO_SITE_NAME": JSON.stringify(process.env.DECO_SITE_NAME || "my-store") }`
