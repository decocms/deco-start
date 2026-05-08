import { describe, expect, it } from "vitest";
import { decoVitePlugin } from "./plugin.js";

/**
 * The Vite plugin's `resolveId` / `load` hooks are pure functions over their
 * inputs, so we can exercise them without spinning up a Vite environment.
 */

function getPlugin() {
  const result = decoVitePlugin();
  // decoVitePlugin returns a single plugin object today, but the type is
  // `PluginOption` which permits arrays — handle both.
  return Array.isArray(result) ? result[0] : result;
}

describe("decoVitePlugin SSR stubs", () => {
  it("rewrites bare `fs` to a virtual module on SSR", () => {
    const p = getPlugin();
    const id = p.resolveId.call({}, "fs", undefined, { ssr: true });
    expect(id).toBe("\0stub:bare-fs");
  });

  it("does NOT rewrite bare `fs` on client (browser builds don't import fs)", () => {
    const p = getPlugin();
    const id = p.resolveId.call({}, "fs", undefined, { ssr: false });
    expect(id).toBeUndefined();
  });

  it("loads an empty surface for the bare-fs virtual module", () => {
    const p = getPlugin();
    const src = p.load.call({}, "\0stub:bare-fs", { ssr: true });
    expect(src).toContain("export const promises = {}");
    expect(src).toContain("export default");
  });

  it("does not interfere with real SSR modules", () => {
    const p = getPlugin();
    expect(p.resolveId.call({}, "@decocms/start/cms", undefined, { ssr: true })).toBeUndefined();
  });
});

describe("decoVitePlugin client stubs (regression guard)", () => {
  it("still rewrites node:async_hooks on the client build", () => {
    const p = getPlugin();
    const id = p.resolveId.call({}, "node:async_hooks", undefined, { ssr: false });
    expect(id).toBe("\0stub:node-async-hooks");
  });

  it("does not rewrite client stubs on SSR", () => {
    const p = getPlugin();
    const id = p.resolveId.call({}, "react-dom/server", undefined, { ssr: true });
    expect(id).toBeUndefined();
  });
});
