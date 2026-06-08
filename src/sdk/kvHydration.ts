/**
 * Fast-deploy KV hydration — the runtime read path.
 *
 * Bridges a Cloudflare KV namespace to the in-memory decofile so CMS content
 * edits propagate WITHOUT a `wrangler deploy`. Two entry points, both called
 * from `workerEntry.ts`:
 *
 * - `ensureBlocksHydrated(env, ctx)` — on the FIRST request per isolate, load
 *   the whole snapshot from KV and swap it in via `setBlocks()`. Awaited, so it
 *   adds one ~10-30ms cold-start hit per isolate but guarantees fresh content
 *   (the bundled `blocks.gen` snapshot is frozen at the last code deploy).
 *
 * - `maybePollRevision(env, ctx)` — on EVERY request, opportunistically (gated
 *   to once per `POLL_INTERVAL_MS`) probe `index:revision` via `ctx.waitUntil`
 *   so it never blocks the response; reload + swap when it changed.
 *
 * Everything is a no-op unless fast-deploy is enabled (`isFastDeployEnabled`),
 * so non-migrated sites behave exactly as before.
 *
 * Why whole-snapshot swap (not per-block async): the resolver reads
 * `loadBlocks()` synchronously in dozens of places. Loading the entire decofile
 * once and swapping the map keeps that hot path synchronous — KV is touched
 * only on cold start and during the throttled poll. Mirrors the
 * `DecofileProvider` pattern from the deco-cx/deco Fresh runtime.
 */

import { getRevision, setBlocks } from "../cms/loader";
import { KVBlockSource } from "../cms/kvBlockSource";
import type { KVNamespace } from "../cms/blockSource";
import { setSpanAttribute } from "./observability";

/** How often (ms) an isolate re-probes `index:revision`. */
export const POLL_INTERVAL_MS = 10_000;

/** KV binding name expected on the Worker `env`. */
export const KV_BINDING = "DECO_KV";

/** Opt-in env var — set to "1" (or "true") to enable fast-deploy. The DECO_KV
 * binding must also be present. */
export const FAST_DEPLOY_ENV = "DECO_FAST_DEPLOY";

// globalThis-backed state so all Vite server-function split-module copies share
// the same hydration flags (same pattern as `loader.ts`).
const G = globalThis as unknown as {
  __deco?: {
    kvHydrated?: boolean;
    kvHydration?: Promise<void> | null;
    kvLastPolledAt?: number;
  };
};
if (!G.__deco) G.__deco = {};

/** Minimal Cloudflare ExecutionContext shape (matches workerEntry.ts). */
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

type Env = Record<string, unknown>;

function getKV(env: Env): KVNamespace | null {
  const binding = env[KV_BINDING];
  // Duck-type the binding: a real KVNamespace has get/put. Guards against a
  // string/secret accidentally named DECO_KV.
  if (binding && typeof (binding as KVNamespace).get === "function") {
    return binding as KVNamespace;
  }
  return null;
}

/**
 * Fast-deploy is active only when BOTH hold: `DECO_FAST_DEPLOY` is set to "1"
 * (or "true") — an explicit, per-site opt-in — AND the `DECO_KV` binding is
 * present. Either missing ⇒ bundled-snapshot behavior, identical to
 * pre-fast-deploy. Requiring the explicit flag means simply binding a KV
 * namespace can't silently flip a site onto the KV read/write path.
 */
export function isFastDeployEnabled(env: Env): boolean {
  const flag = env[FAST_DEPLOY_ENV];
  if (flag !== "1" && flag !== "true") return false;
  return getKV(env) !== null;
}

/**
 * Resolve the KV namespace for the write-through path, or `null` when
 * fast-deploy is disabled. Shared by `decofile.ts` so the enablement rule
 * lives in exactly one place.
 */
export function getFastDeployKV(env: Env): KVNamespace | null {
  if (!isFastDeployEnabled(env)) return null;
  return getKV(env);
}

/**
 * Cold-start hydration. Awaits the KV snapshot once per isolate and swaps it
 * into the in-memory block map. Concurrent first requests share a single
 * in-flight load. On any error (KV outage, bad JSON) we keep the bundled
 * snapshot and mark hydration done — recovery happens via `maybePollRevision`
 * once KV is reachable again (its revision will differ from the bundled one).
 */
export function ensureBlocksHydrated(env: Env, _ctx?: ExecutionContextLike): Promise<void> {
  if (!isFastDeployEnabled(env)) return Promise.resolve();
  if (G.__deco!.kvHydrated) return Promise.resolve();
  if (G.__deco!.kvHydration) return G.__deco!.kvHydration;

  const kv = getKV(env);
  if (!kv) return Promise.resolve();

  const load = (async () => {
    try {
      const snapshot = await new KVBlockSource(kv).loadSnapshot();
      if (snapshot) {
        setBlocks(snapshot.blocks);
        setSpanAttribute("deco.block.source", "kv");
      } else {
        setSpanAttribute("deco.block.source", "bundled");
      }
    } catch (e) {
      // Non-fatal: serve the bundled snapshot. The poll loop recovers later.
      console.warn("[CMS/KV] cold-start hydration failed, using bundled snapshot:", e);
      setSpanAttribute("deco.block.source", "bundled");
    } finally {
      G.__deco!.kvHydrated = true;
      G.__deco!.kvHydration = null;
    }
  })();

  G.__deco!.kvHydration = load;
  return load;
}

/**
 * Opportunistic revision poll. Throttled to once per `POLL_INTERVAL_MS` and run
 * through `ctx.waitUntil` so it never adds latency to the response. Reloads the
 * snapshot and swaps it in when KV's revision differs from the in-memory one.
 */
export function maybePollRevision(env: Env, ctx?: ExecutionContextLike): void {
  if (!isFastDeployEnabled(env)) return;
  if (!G.__deco!.kvHydrated) return; // wait until cold-start hydration finished

  const now = Date.now();
  if (now - (G.__deco!.kvLastPolledAt ?? 0) < POLL_INTERVAL_MS) return;
  G.__deco!.kvLastPolledAt = now;

  const kv = getKV(env);
  if (!kv) return;

  const poll = pollRevisionOnce(kv);
  // Prefer waitUntil so the work outlives the response; fall back to a
  // fire-and-forget promise (dev / tests) with its rejection swallowed.
  if (ctx?.waitUntil) ctx.waitUntil(poll);
  else void poll.catch(() => {});
}

async function pollRevisionOnce(kv: KVNamespace): Promise<void> {
  try {
    const source = new KVBlockSource(kv);
    const remoteRevision = await source.getRevision();
    if (!remoteRevision || remoteRevision === getRevision()) return;

    const snapshot = await source.loadSnapshot();
    if (snapshot) {
      setBlocks(snapshot.blocks);
      console.info(`[CMS/KV] decofile refreshed → revision ${snapshot.revision}`);
    }
  } catch (e) {
    // Swallow — a failed poll must never affect the request. Next tick retries.
    console.warn("[CMS/KV] revision poll failed:", e);
  }
}

/** Test-only: reset the isolate-level hydration flags. */
export function __resetKvHydrationStateForTests(): void {
  G.__deco!.kvHydrated = false;
  G.__deco!.kvHydration = null;
  G.__deco!.kvLastPolledAt = 0;
}
