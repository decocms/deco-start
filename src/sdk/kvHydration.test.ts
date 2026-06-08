import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeRevision, KV_KEYS, type KVNamespace } from "../cms/blockSource";
import { getRevision, loadBlocks, setBlocks } from "../cms/loader";
import {
  __resetKvHydrationStateForTests,
  ensureBlocksHydrated,
  isFastDeployEnabled,
  maybePollRevision,
} from "./kvHydration";

const BUNDLED = { Site: { name: "bundled" } };

/** KV stub that counts get() calls so we can assert throttling / single-load. */
function makeKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  let getCalls = 0;
  const kv: KVNamespace = {
    get: (k) => {
      getCalls++;
      return Promise.resolve(store.get(k) ?? null);
    },
    put: (k, v) => {
      store.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => {
      store.delete(k);
      return Promise.resolve();
    },
  };
  return { kv, store, getCalls: () => getCalls };
}

function snapshotEnv(blocks: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const { kv, ...rest } = makeKV({
    [KV_KEYS.SNAPSHOT]: JSON.stringify(blocks),
    [KV_KEYS.REVISION]: computeRevision(blocks),
  });
  // DECO_FAST_DEPLOY="1" is the explicit opt-in required alongside the binding.
  return { env: { DECO_KV: kv, DECO_FAST_DEPLOY: "1", ...extra }, kv, ...rest };
}

/** Collects ctx.waitUntil promises so tests can await background polls. */
function makeCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => promises.push(p) },
    settle: () => Promise.allSettled(promises),
  };
}

beforeEach(() => {
  __resetKvHydrationStateForTests();
  setBlocks({ ...BUNDLED }); // reset in-memory decofile to a known bundled state
  vi.restoreAllMocks();
});

describe("isFastDeployEnabled", () => {
  it("is false without a KV binding even when the flag is set", () => {
    expect(isFastDeployEnabled({ DECO_FAST_DEPLOY: "1" })).toBe(false);
  });

  it("is false when a non-KV value is named DECO_KV", () => {
    expect(isFastDeployEnabled({ DECO_KV: "some-secret-string", DECO_FAST_DEPLOY: "1" })).toBe(false);
  });

  it("is false when bound but DECO_FAST_DEPLOY is not set (explicit opt-in required)", () => {
    const { kv } = makeKV();
    expect(isFastDeployEnabled({ DECO_KV: kv })).toBe(false);
  });

  it("is true when bound AND DECO_FAST_DEPLOY=1", () => {
    const { kv } = makeKV();
    expect(isFastDeployEnabled({ DECO_KV: kv, DECO_FAST_DEPLOY: "1" })).toBe(true);
  });

  it("accepts DECO_FAST_DEPLOY=true as well", () => {
    const { kv } = makeKV();
    expect(isFastDeployEnabled({ DECO_KV: kv, DECO_FAST_DEPLOY: "true" })).toBe(true);
  });

  it("is false when DECO_FAST_DEPLOY=0 even if bound", () => {
    const { kv } = makeKV();
    expect(isFastDeployEnabled({ DECO_KV: kv, DECO_FAST_DEPLOY: "0" })).toBe(false);
  });
});

describe("ensureBlocksHydrated", () => {
  it("is a no-op when fast-deploy is disabled (keeps bundled blocks)", async () => {
    await ensureBlocksHydrated({});
    expect(loadBlocks()).toEqual(BUNDLED);
  });

  it("swaps the in-memory decofile with the KV snapshot", async () => {
    const kvBlocks = { Site: { name: "from-kv" }, "pages-home": { path: "/" } };
    const { env } = snapshotEnv(kvBlocks);
    await ensureBlocksHydrated(env);
    expect(loadBlocks()).toEqual(kvBlocks);
    expect(getRevision()).toBe(computeRevision(kvBlocks));
  });

  it("loads only once even across concurrent first requests", async () => {
    const kvBlocks = { Site: { name: "from-kv" } };
    const { env, getCalls } = snapshotEnv(kvBlocks);
    await Promise.all([
      ensureBlocksHydrated(env),
      ensureBlocksHydrated(env),
      ensureBlocksHydrated(env),
    ]);
    // SNAPSHOT + REVISION = 2 gets for a single load (not 6).
    expect(getCalls()).toBe(2);
  });

  it("keeps the bundled snapshot when the snapshot key is absent", async () => {
    const { kv } = makeKV({ [KV_KEYS.REVISION]: "r" }); // no SNAPSHOT
    await ensureBlocksHydrated({ DECO_KV: kv });
    expect(loadBlocks()).toEqual(BUNDLED);
  });

  it("falls back to bundled (and does not throw) when KV errors", async () => {
    const kv: KVNamespace = {
      get: () => Promise.reject(new Error("KV down")),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(ensureBlocksHydrated({ DECO_KV: kv })).resolves.toBeUndefined();
    expect(loadBlocks()).toEqual(BUNDLED);
  });
});

describe("maybePollRevision", () => {
  it("is a no-op before cold-start hydration has run", async () => {
    const { env, getCalls } = snapshotEnv({ Site: { name: "x" } });
    const { ctx, settle } = makeCtx();
    maybePollRevision(env, ctx); // kvHydrated is false
    await settle();
    expect(getCalls()).toBe(0);
  });

  it("reloads the decofile when the KV revision changed", async () => {
    const initial = { Site: { name: "v1" } };
    const { env, store } = snapshotEnv(initial);
    await ensureBlocksHydrated(env);
    expect(loadBlocks()).toEqual(initial);

    // Simulate a publish from another isolate: KV now holds v2.
    const updated = { Site: { name: "v2" }, "pages-x": { path: "/x" } };
    store.set(KV_KEYS.SNAPSHOT, JSON.stringify(updated));
    store.set(KV_KEYS.REVISION, computeRevision(updated));

    const { ctx, settle } = makeCtx();
    maybePollRevision(env, ctx);
    await settle();
    expect(loadBlocks()).toEqual(updated);
  });

  it("throttles to one probe per interval", async () => {
    const { env, getCalls } = snapshotEnv({ Site: { name: "x" } });
    await ensureBlocksHydrated(env);
    const callsAfterHydrate = getCalls();

    const { ctx, settle } = makeCtx();
    maybePollRevision(env, ctx); // fires (revision unchanged → 1 get)
    maybePollRevision(env, ctx); // throttled → no get
    maybePollRevision(env, ctx); // throttled → no get
    await settle();

    // Exactly one extra getRevision() beyond the hydrate calls.
    expect(getCalls()).toBe(callsAfterHydrate + 1);
  });
});
