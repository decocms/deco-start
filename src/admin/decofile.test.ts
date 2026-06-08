import { beforeEach, describe, expect, it } from "vitest";
import { KV_KEYS, type KVNamespace } from "../cms/blockSource";
import { getRevision, loadBlocks, setBlocks } from "../cms/loader";
import { handleDecofileReload } from "./decofile";

// In vitest, import.meta.env.DEV is true, so handleDecofileReload skips the
// auth check (same branch the dev Vite plugin uses) — no token needed here.

function reload(payload: unknown, env?: Record<string, unknown>) {
  const req = new Request("http://x/.decofile", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });
  return handleDecofileReload(req, env);
}

function makeKV() {
  const store = new Map<string, string>();
  const kv: KVNamespace = {
    get: (k) => Promise.resolve(store.get(k) ?? null),
    put: (k, v) => {
      store.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => {
      store.delete(k);
      return Promise.resolve();
    },
  };
  return { kv, store };
}

beforeEach(() => {
  setBlocks({ Site: { name: "base" }, "pages-home": { path: "/" } });
});

describe("handleDecofileReload — full replacement (back-compat)", () => {
  it("replaces the whole decofile when body is a raw block map", async () => {
    const full = { Site: { name: "new" }, "pages-x": { path: "/x" } };
    const res = await reload(full);
    const json = (await res.json()) as { mode: string; ok: boolean };
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.mode).toBe("full");
    expect(loadBlocks()).toEqual(full);
  });
});

describe("handleDecofileReload — delta payloads", () => {
  it("adds/updates blocks, leaving others intact", async () => {
    const res = await reload({ blocks: { "pages-x": { path: "/x" } } });
    const json = (await res.json()) as { mode: string };
    expect(json.mode).toBe("delta");
    expect(loadBlocks()).toEqual({
      Site: { name: "base" },
      "pages-home": { path: "/" },
      "pages-x": { path: "/x" },
    });
  });

  it("deletes a block when its delta value is null", async () => {
    await reload({ blocks: { "pages-home": null } });
    expect(loadBlocks()).toEqual({ Site: { name: "base" } });
  });

  it("does NOT treat a full decofile that has many keys as a delta", async () => {
    const res = await reload({ Site: { name: "a" }, blocks: { name: "a block named blocks" } });
    const json = (await res.json()) as { mode: string };
    // Two top-level keys → full replacement, not a delta envelope.
    expect(json.mode).toBe("full");
  });
});

describe("handleDecofileReload — KV write-through", () => {
  it("writes the snapshot + revision to KV when DECO_KV is bound", async () => {
    const { kv, store } = makeKV();
    const res = await reload(
      { blocks: { "pages-x": { path: "/x" } } },
      { DECO_KV: kv, DECO_FAST_DEPLOY: "1" },
    );
    const json = (await res.json()) as { kvWritten: boolean; revision: string };

    expect(json.kvWritten).toBe(true);
    expect(store.get(KV_KEYS.SNAPSHOT)).toBe(JSON.stringify(loadBlocks()));
    expect(store.get(KV_KEYS.REVISION)).toBe(getRevision());
    expect(store.get(KV_KEYS.REVISION)).toBe(json.revision);
  });

  it("reports kvWritten=false when no KV binding is present", async () => {
    const res = await reload({ blocks: { "pages-x": { path: "/x" } } }, {});
    const json = (await res.json()) as { kvWritten: boolean };
    expect(json.kvWritten).toBe(false);
  });

  it("reports kvWritten=false when bound but DECO_FAST_DEPLOY is not set", async () => {
    const { kv, store } = makeKV();
    const res = await reload({ blocks: { "pages-x": { path: "/x" } } }, { DECO_KV: kv });
    const json = (await res.json()) as { kvWritten: boolean };
    expect(json.kvWritten).toBe(false);
    expect(store.size).toBe(0); // nothing written to KV
  });

  it("does not fail the request when the KV write throws", async () => {
    const env = {
      DECO_FAST_DEPLOY: "1",
      DECO_KV: {
        get: () => Promise.resolve(null),
        put: () => Promise.reject(new Error("KV down")),
        delete: () => Promise.resolve(),
      } as KVNamespace,
    };
    const res = await reload({ blocks: { "pages-x": { path: "/x" } } }, env);
    const json = (await res.json()) as { ok: boolean; kvWritten: boolean };
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.kvWritten).toBe(false);
    // Local state still updated despite KV failure.
    expect(loadBlocks()["pages-x"]).toEqual({ path: "/x" });
  });
});

describe("handleDecofileReload — validation", () => {
  it("returns 400 on invalid JSON", async () => {
    const req = new Request("http://x/.decofile", { method: "POST", body: "{not json" });
    const res = await handleDecofileReload(req, {});
    expect(res.status).toBe(400);
  });

  it("returns 400 when the body is not an object", async () => {
    const res = await reload([1, 2, 3], {});
    expect(res.status).toBe(400);
  });
});
