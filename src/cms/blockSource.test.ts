import { describe, expect, it } from "vitest";
import {
  BundledBlockSource,
  computeRevision,
  KV_KEYS,
  type KVNamespace,
} from "./blockSource";
import { djb2Hex } from "../sdk/djb2";

describe("computeRevision", () => {
  it("matches loader.ts computeRevision (djb2Hex of JSON.stringify)", () => {
    const blocks = { Site: { name: "x" }, "pages-home": { path: "/" } };
    expect(computeRevision(blocks)).toBe(djb2Hex(JSON.stringify(blocks)));
  });

  it("is stable for the same input and differs on change", () => {
    const a = { a: 1 };
    const b = { a: 2 };
    expect(computeRevision(a)).toBe(computeRevision(a));
    expect(computeRevision(a)).not.toBe(computeRevision(b));
  });

  it("hashes an empty decofile without throwing", () => {
    expect(typeof computeRevision({})).toBe("string");
  });
});

describe("BundledBlockSource", () => {
  it("loadSnapshot resolves null (bundled is applied at startup, not here)", async () => {
    const src = new BundledBlockSource();
    await expect(src.loadSnapshot()).resolves.toBeNull();
  });

  it("getRevision resolves null", async () => {
    const src = new BundledBlockSource();
    await expect(src.getRevision()).resolves.toBeNull();
  });
});

describe("KV_KEYS", () => {
  it("exposes the snapshot and revision key contract", () => {
    expect(KV_KEYS.SNAPSHOT).toBe("decofile:current");
    expect(KV_KEYS.REVISION).toBe("index:revision");
  });
});

describe("KVNamespace structural type", () => {
  it("a plain Map-backed stub satisfies the interface", async () => {
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

    await kv.put(KV_KEYS.REVISION, "abc");
    await expect(kv.get(KV_KEYS.REVISION)).resolves.toBe("abc");
    await kv.delete(KV_KEYS.REVISION);
    await expect(kv.get(KV_KEYS.REVISION)).resolves.toBeNull();
  });
});
