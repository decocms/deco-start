import { describe, expect, it } from "vitest";
import { computeRevision, KV_KEYS, type KVNamespace } from "./blockSource";
import { KVBlockSource } from "./kvBlockSource";

function makeKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
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
}

describe("KVBlockSource.loadSnapshot", () => {
  it("returns null when the snapshot key is missing", async () => {
    const src = new KVBlockSource(makeKV());
    await expect(src.loadSnapshot()).resolves.toBeNull();
  });

  it("returns blocks with the stored revision", async () => {
    const blocks = { Site: { name: "x" } };
    const src = new KVBlockSource(
      makeKV({
        [KV_KEYS.SNAPSHOT]: JSON.stringify(blocks),
        [KV_KEYS.REVISION]: "stored-rev",
      }),
    );
    await expect(src.loadSnapshot()).resolves.toEqual({ blocks, revision: "stored-rev" });
  });

  it("recomputes the revision when only the snapshot is stored", async () => {
    const blocks = { Site: { name: "x" } };
    const src = new KVBlockSource(makeKV({ [KV_KEYS.SNAPSHOT]: JSON.stringify(blocks) }));
    await expect(src.loadSnapshot()).resolves.toEqual({
      blocks,
      revision: computeRevision(blocks),
    });
  });

  it("throws on a non-object snapshot (treated as KV-unavailable by callers)", async () => {
    const src = new KVBlockSource(makeKV({ [KV_KEYS.SNAPSHOT]: "[1,2,3]" }));
    await expect(src.loadSnapshot()).rejects.toThrow();
  });

  it("throws on malformed JSON", async () => {
    const src = new KVBlockSource(makeKV({ [KV_KEYS.SNAPSHOT]: "{not json" }));
    await expect(src.loadSnapshot()).rejects.toThrow();
  });
});

describe("KVBlockSource.getRevision", () => {
  it("returns the stored revision", async () => {
    const src = new KVBlockSource(makeKV({ [KV_KEYS.REVISION]: "r1" }));
    await expect(src.getRevision()).resolves.toBe("r1");
  });

  it("returns null when absent", async () => {
    const src = new KVBlockSource(makeKV());
    await expect(src.getRevision()).resolves.toBeNull();
  });
});
