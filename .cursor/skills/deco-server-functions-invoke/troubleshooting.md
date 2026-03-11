# Troubleshooting

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
