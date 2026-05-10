import { describe, expect, it } from "vitest";
import { createAlsRequestStore } from "./alsRequestStore";

describe("alsRequestStore", () => {
  it("isolates values across run() scopes", () => {
    const store = createAlsRequestStore<{ x: number }>();
    let outer: { x: number } | undefined;
    let inner: { x: number } | undefined;
    store.run({ x: 1 }, () => {
      outer = store.get();
      store.run({ x: 2 }, () => {
        inner = store.get();
      });
    });
    expect(outer).toEqual({ x: 1 });
    expect(inner).toEqual({ x: 2 });
  });

  it("get() returns undefined outside run()", () => {
    const store = createAlsRequestStore<string>();
    expect(store.get()).toBeUndefined();
  });
});
