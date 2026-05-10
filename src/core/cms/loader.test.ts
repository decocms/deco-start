import { describe, expect, it, beforeEach } from "vitest";
import {
  setBlocksOverrideStore,
  withBlocksOverride,
  getActiveBlocksOverride,
} from "./loader";
import type { RequestStore } from "../runtime/requestStore";

class TestStore<T> implements RequestStore<T> {
  private current: T | undefined;
  get() { return this.current; }
  run<R>(value: T, fn: () => R): R {
    const prev = this.current;
    this.current = value;
    try { return fn(); } finally { this.current = prev; }
  }
}

describe("blocks override store", () => {
  beforeEach(() => {
    setBlocksOverrideStore(undefined);
  });

  it("withBlocksOverride exposes the override inside the callback", () => {
    const store = new TestStore<Record<string, unknown>>();
    setBlocksOverrideStore(store);
    const override = { foo: "bar" } as Record<string, unknown>;
    let observed: Record<string, unknown> | undefined;
    withBlocksOverride(override, () => {
      observed = getActiveBlocksOverride();
    });
    expect(observed).toEqual(override);
  });

  it("getActiveBlocksOverride returns undefined outside withBlocksOverride", () => {
    const store = new TestStore<Record<string, unknown>>();
    setBlocksOverrideStore(store);
    expect(getActiveBlocksOverride()).toBeUndefined();
  });

  it("default store (noop) makes withBlocksOverride still execute fn", () => {
    setBlocksOverrideStore(undefined);
    let executed = false;
    withBlocksOverride({ a: 1 } as Record<string, unknown>, () => { executed = true; });
    expect(executed).toBe(true);
  });
});
