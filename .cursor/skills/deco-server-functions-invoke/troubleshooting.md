# Troubleshooting

## Cart "forgets" items between requests / /checkout opens empty after addItemToCart

**Symptom**: `invoke.vtex.actions.addItemsToCart(...)` succeeds (returns an `OrderForm` with items), but the next page load — or clicking the cart icon — shows an empty cart, and `/checkout` lands on a fresh empty order. Sometimes the orderFormId is different from the one just returned.

**Root cause**: The VTEX cart cookies (`checkout.vtex.com__orderFormId`, `segment`, `sc`, `vtex_session`) never reach the browser because somewhere in the chain, multiple `Set-Cookie` headers got collapsed into a single comma-joined string. Browsers silently discard malformed `Set-Cookie` values, so every subsequent request hits VTEX without authentication and gets a new empty orderForm.

**Two places this can break**:

1. **`src/server/invoke.gen.ts` missing or stale**. This is the TanStack RPC path. Each action must call `forwardResponseCookies()` after awaiting the underlying VTEX call. The helper uses `Headers.getSetCookie()` (not `entries()`!) to read the un-collapsed list and writes each value to TanStack's response via `setResponseHeader("set-cookie", [...])`. If the file doesn't exist, the site falls back to the `/deco/invoke/...` proxy.

2. **`/deco/invoke/...` HTTP proxy** (`~/runtime.ts` pattern). The framework's admin handler (`@decocms/start/src/admin/invoke.ts`) used to iterate `RequestContext.responseHeaders.entries()` which collapses Set-Cookie. Fixed in @decocms/start ≥ 5.0.0 by switching to `getSetCookie()` + a `forwardCtxHeadersTo()` helper applied on both single and batch paths.

**Diagnosis**: Open DevTools → Network → response to the cart action. You should see **multiple distinct** `Set-Cookie:` rows. If you see a single `Set-Cookie: foo=1, bar=2; Path=/, baz=3` line, that's the collapse bug.

**Fix**:
1. Upgrade `@decocms/start` to the version with `forwardCtxHeadersTo` in `src/admin/invoke.ts` (search the file — both single and batch handlers should call it).
2. Run `bunx tsx node_modules/@decocms/start/scripts/generate-invoke.ts` to regenerate `src/server/invoke.gen.ts`. Verify it has `function forwardResponseCookies()` and that every emitted handler calls it.
3. Make sure `useCart` (and other VTEX hooks) imports `invoke` from `~/server/invoke.gen` (or a barrel re-export of it), not from `~/runtime`.
4. The migration script (`scripts/migrate.ts` bootstrap) runs `generate-invoke.ts` automatically on freshly-migrated sites — if a site was migrated before that, run the generator manually.

**Client-side workaround** (defense-in-depth, removable): some sites manually `document.cookie = "checkout.vtex.com__orderFormId=..."` inside `useCart`. That only patches one cookie of many. With the server-side fix in place, the workaround is harmless but no longer load-bearing — see `~/conductor/workspaces/miess-01-tanstack/newport-beach/src/hooks/useCart.ts` for an example.

## CORS Error on Add to Cart / Checkout

**Symptom**: Browser console shows CORS error when calling VTEX API directly.

**Check**: Open browser DevTools → Network tab. If you see requests going to `vtexcommercestable.com.br` instead of `/_server`, the server functions aren't transformed.

**Fix**: 
1. Verify `invoke.gen.ts` exists in `src/server/`
2. Verify imports point to `~/server/invoke.gen`, not `@decocms/apps/vtex/invoke`
3. Re-run `npm run generate:invoke`
4. Restart the dev server (Vite caches transforms)

## Verify Transformation

Fetch the generated file from Vite to see if the compiler transformed it:

```bash
# Replace port with your dev server port
curl "http://localhost:5173/src/server/invoke.gen.ts" | head -20
```

**Good** — you should see `createClientRpc`:
```js
const $addItemsToCart = createServerFn({ method: "POST" })
  .handler(createClientRpc("eyJmaWxlIjoi..."));
```

**Bad** — you see the raw handler code:
```js
const $addItemsToCart = createServerFn({ method: "POST" })
  .handler(async (ctx) => {
    const result = await addItemsToCart(ctx.data.orderFormId, ...);
```

If you see the raw code, the compiler didn't transform it. Possible causes:
- The file is not in `src/` (must be inside the site's source directory)
- The Vite plugin is not loaded (check `vite.config.ts` has `tanstackStart()`)
- The `createServerFn` is not at top-level (check the generated code)

## Server Logs Don't Show VTEX Calls

**Symptom**: When clicking add to cart, no `[vtex] POST ...` lines appear in the terminal.

**Cause**: The calls are going directly from the browser, not through the server.

**Fix**: Same as CORS fix above — ensure `invoke.gen.ts` is being used.

## "invoke.vtex.actions.X is not a function"

**Cause**: The generated file doesn't include that action.

**Fix**:
1. Check `@decocms/apps/vtex/invoke.ts` — is the action declared there?
2. Re-run `npm run generate:invoke`
3. Check the generated `invoke.gen.ts` — is the action present?

## Generator Fails: "Could not find @decocms/apps"

**Cause**: The script can't locate the apps package.

**Fix**: Use `--apps-dir`:
```bash
npx tsx .../generate-invoke.ts --apps-dir ../apps-start
# or
npx tsx .../generate-invoke.ts --apps-dir node_modules/@decocms/apps
```

## Generator Fails: "Could not find 'export const invoke'"

**Cause**: The `invoke.ts` in `@decocms/apps` changed structure.

**Fix**: The generator expects:
```typescript
export const invoke = {
  vtex: {
    actions: {
      actionName: createInvokeFn(...) as ...,
    },
  },
} as const;
```

If the structure changed, update `generate-invoke.ts` to match.

## New Action Not Available After Re-generating

**Checklist**:
1. Added to `@decocms/apps/vtex/invoke.ts`? 
2. Ran `npm run generate:invoke`?
3. Check `src/server/invoke.gen.ts` — is the new action in the file?
4. Restarted dev server? (HMR may not pick up `.gen.ts` changes)

## TypeScript Errors in invoke.gen.ts

The generated file uses `as unknown as` casts for typing. If you see TS errors:
- They're usually harmless in the generated file
- The consumer types (what components see) are correct
- If a type is wrong, fix it in `@decocms/apps/vtex/invoke.ts` and re-generate

## Performance: Are Server Functions Slow?

Each `invoke.*` call from the client makes one HTTP request to `/_server`. In dev mode, this goes to the local Vite server. In production (Cloudflare Workers), it's handled within the same worker — effectively zero network latency since it's an in-process function call during SSR, and a single HTTP round-trip during client-side navigation.

The overhead vs. direct VTEX calls: one extra hop through the worker, but this is necessary for:
- Hiding VTEX credentials from the browser
- Avoiding CORS
- Allowing server-side cookie propagation
- Enabling future features like response caching
