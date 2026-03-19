/**
 * Deco Vite plugin — server-only stubs for TanStack Start storefronts.
 *
 * Replaces server-only modules with lightweight client stubs so they
 * are eliminated from the browser bundle. This consolidates stubs that
 * every Deco site previously had to copy into its own vite.config.ts.
 *
 * Usage:
 * ```ts
 * import { decoVitePlugin } from "@decocms/start/vite";
 * export default defineConfig({ plugins: [decoVitePlugin(), ...] });
 * ```
 */

import type { Plugin, PluginOption } from "vite";

// Bare-specifier stubs resolved by ID before Vite touches them.
const CLIENT_STUBS: Record<string, string> = {
  "react-dom/server": "\0stub:react-dom-server",
  "react-dom/server.browser": "\0stub:react-dom-server",
  "node:stream": "\0stub:node-stream",
  "node:stream/web": "\0stub:node-stream-web",
  "node:async_hooks": "\0stub:node-async-hooks",
  "tanstack-start-injected-head-scripts:v": "\0stub:tanstack-head-scripts",
};

// Minimal stub source for each virtual module.
const STUB_SOURCE: Record<string, string> = {
  "\0stub:react-dom-server": [
    "const noop = () => '';",
    "export const renderToString = noop;",
    "export const renderToStaticMarkup = noop;",
    "export const renderToReadableStream = noop;",
    "export const resume = noop;",
    "export const version = '19.0.0';",
    "export default { renderToString: noop, renderToStaticMarkup: noop, renderToReadableStream: noop, resume: noop, version: '19.0.0' };",
  ].join("\n"),

  "\0stub:node-stream":
    "export class PassThrough {}; export class Readable {}; export class Writable {}; export default { PassThrough, Readable, Writable };",

  "\0stub:node-stream-web":
    "export const ReadableStream = globalThis.ReadableStream; export const WritableStream = globalThis.WritableStream; export const TransformStream = globalThis.TransformStream; export default { ReadableStream, WritableStream, TransformStream };",

  "\0stub:node-async-hooks": [
    "class _ALS { getStore() { return undefined; } run(_store, fn, ...args) { return fn(...args); } enterWith() {} disable() {} }",
    "export const AsyncLocalStorage = _ALS;",
    "export const AsyncResource = class {};",
    "export function executionAsyncId() { return 0; }",
    "export function createHook() { return { enable() {}, disable() {} }; }",
    "export default { AsyncLocalStorage: _ALS, AsyncResource, executionAsyncId, createHook };",
  ].join("\n"),

  "\0stub:tanstack-head-scripts":
    "export const injectedHeadScripts = undefined;",
};

export function decoVitePlugin(): PluginOption {
  const plugin: Plugin = {
    name: "deco-server-only-stubs",
    enforce: "pre",

    resolveId(id, _importer, options) {
      // Server builds keep the real modules.
      if (options?.ssr) return undefined;
      return CLIENT_STUBS[id];
    },

    load(id, options) {
      // ------------------------------------------------------------------
      // blocks.gen.ts — the CMS block registry (often 500KB+ compiled).
      // Only the server needs it; the client receives pre-resolved sections.
      // Match on resolved file path (relative imports resolve to absolute).
      // ------------------------------------------------------------------
      if (!options?.ssr && id.endsWith("blocks.gen.ts")) {
        return "export const blocks = {};";
      }

      // Virtual module stubs.
      return STUB_SOURCE[id];
    },

    configEnvironment(name: string, env: any) {
      if (name === "ssr" || name === "client") {
        env.optimizeDeps = env.optimizeDeps || {};
        env.optimizeDeps.esbuildOptions =
          env.optimizeDeps.esbuildOptions || {};
        env.optimizeDeps.esbuildOptions.jsx = "automatic";
        env.optimizeDeps.esbuildOptions.jsxImportSource = "react";
      }
    },
  };

  return plugin;
}
