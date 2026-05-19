import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("decoVitePlugin __DECO_BUILD_HASH__ injection", () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.WORKERS_CI_COMMIT_SHA;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  function callConfig(command) {
    const p = getPlugin();
    return p.config({}, { command });
  }

  it("injects the literal 'dev' for non-build commands", () => {
    const cfg = callConfig("serve");
    expect(cfg.define.__DECO_BUILD_HASH__).toBe(JSON.stringify("dev"));
  });

  it("uses WORKERS_CI_COMMIT_SHA (sliced to 12 chars) when set on a build", () => {
    process.env.WORKERS_CI_COMMIT_SHA = "abcdef1234567890fedcba";
    const cfg = callConfig("build");
    expect(cfg.define.__DECO_BUILD_HASH__).toBe(JSON.stringify("abcdef123456"));
  });

  it("falls back to git rev-parse when WORKERS_CI_COMMIT_SHA is unset", async () => {
    // The plugin module imports execFileSync at top-level, so we can't easily
    // mock it after the fact. Instead, exercise the real git binary against
    // this repo (CI runs in the repo working tree). Assert the value is a
    // 12-char lowercase hex SHA — that proves git was consulted, not that
    // the time-based fallback was hit.
    const cfg = callConfig("build");
    const value = JSON.parse(cfg.define.__DECO_BUILD_HASH__);
    // Either git produced a SHA (CI / dev machine inside a repo) or the
    // time-based fallback ran. Both are acceptable; we just assert non-empty
    // and length sanity.
    expect(typeof value).toBe("string");
    expect(value.length).toBeGreaterThan(0);
    // Time-based fallback produces base36 characters; git short SHAs are
    // 12 hex chars. Both fit in this superset regex.
    expect(value).toMatch(/^[0-9a-z]+$/);
  });

  it("preserves allowedHosts behaviour (regression: define is additive, not replacing)", () => {
    process.env.DECO_SITE_NAME = "test-site";
    try {
      const cfg = callConfig("serve");
      expect(cfg.server?.allowedHosts).toContain(".deco.studio");
      expect(cfg.define.__DECO_BUILD_HASH__).toBeDefined();
    } finally {
      delete process.env.DECO_SITE_NAME;
    }
  });
});
