# Troubleshooting

Common issues developers hit while running deco storefronts on `@decocms/start`, with concrete diagnostics and mitigations.

---

## Dev-mode only: intermittent HTTP 500 on parallel `_serverFn` POSTs

**Symptom.** In `bun run dev` / `npm run dev` (vite + `@cloudflare/vite-plugin` worker emulator), POST `/_serverFn/<base64-id>` calls fail intermittently — roughly half of parallel calls return HTTP 500 with:

```
TypeError: Cannot read properties of undefined (reading 'method')
  at handleServerAction (@tanstack/start-server-core/.../server-functions-handler.ts:48:14)
```

When the home page has many `Rendering/Lazy.tsx` sections, IntersectionObserver fires several `loadDeferredSection` POSTs in parallel — random ~half of the resulting shelves stay empty in the rendered page.

**Affected versions.** Reproduced against `@cloudflare/vite-plugin@1.34.0` + `@tanstack/react-start@1.166.8`. The dev runner is `workers/runner-worker/index.js` from the plugin (`runInRunnerObject` / `maybeCaptureError` frames in the stack).

**Production is fine.** Real Cloudflare Workers (Workers Builds / `wrangler deploy`) execute the bundled `dist/` directly, bypassing the runner. Verified all-200 across hundreds of consecutive requests on the same commit.

**Workarounds.**

- For demos / parity checks against prod source-of-truth: deploy to a preview Worker rather than relying on `bun run dev`. The bug is dev-runner only.
- During local development: trigger sections one at a time by scrolling slowly, or refresh after the initial flaky loads to re-trigger the IntersectionObserver. Subsequent requests for the same key are usually faster (the failure pattern doesn't repeat deterministically per section).
- If you can reproduce on a minimal repro (TanStack Start + `@cloudflare/vite-plugin`, no `@decocms/start`), upstream the bug to `cloudflare/workers-sdk` with the concurrent-fetch test case — that's the load-bearing path to a real fix.

**What we ruled out** (issue #198):

- `instrumentWorker(decoWorker)` — toggled off, identical 3× 500 + 4× 200 pattern. Wrapper is innocent.
- Framework's `_serverFn` cache layer — failing calls return in <20 ms, before the cache key is built. They fail at handler entry.
- Specific server-fn IDs / sections — happens equally on Newsletter, Image, ProductShelf, PromotionLinks. The same base64 ID alternates 200 and 500 across reloads.

If you hit this and need a deeper look, attach a `network` HAR + the dev console error and ping the framework team. Tracking issue: #198.
