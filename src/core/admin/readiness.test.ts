import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBlocks } from "../cms/loader";
import { handleDecoReadiness } from "./readiness";

describe("handleDecoReadiness", () => {
  // Tests share globalThis-backed block state; isolate by resetting.
  beforeEach(() => {
    const g = globalThis as any;
    if (g.__deco) {
      g.__deco.blockData = undefined;
      g.__deco.revision = undefined;
    }
  });
  afterEach(() => {
    const g = globalThis as any;
    if (g.__deco) {
      g.__deco.blockData = undefined;
      g.__deco.revision = undefined;
    }
  });

  it("returns 503 'not ready' before setBlocks() has run", async () => {
    const res = handleDecoReadiness();
    expect(res.status).toBe(503);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(await res.text()).toBe("not ready");
  });

  it("returns 200 'ready' after setBlocks() has populated the registry", async () => {
    setBlocks({ "/": { name: "home" } });
    const res = handleDecoReadiness();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ready");
  });
});
