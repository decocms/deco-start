/**
 * Deco Vite plugin — server-only stubs for TanStack Start storefronts.
 *
 * Replaces server-only modules with lightweight client stubs so they
 * are eliminated from the browser bundle. This consolidates stubs that
 * every Deco site previously had to copy into its own vite.config.ts.
 *
 * blocks.gen.ts handling:
 *   The CMS block registry can be 10MB+. Inlining it as a JS object literal
 *   causes Vite's SSR module runner to hang on dynamic imports (transport
 *   serialization bottleneck) and is slow to parse even with static imports
 *   (V8 full JS parser). Instead, generate-blocks.ts writes a .json data
 *   file, and this plugin intercepts the .ts import to return JSON.parse(...)
 *   — V8's JSON parser is 2-10x faster than the JS parser for large data.
 *
 * Usage:
 * ```ts
 * import { decoVitePlugin } from "@decocms/start/vite";
 * export default defineConfig({ plugins: [decoVitePlugin(), ...] });
 * ```
 */
import { readFileSync, existsSync } from "node:fs";

// Bare-specifier stubs resolved by ID before Vite touches them.
/** @type {Record<string, string>} */
const CLIENT_STUBS = {
  "react-dom/server": "\0stub:react-dom-server",
  "react-dom/server.browser": "\0stub:react-dom-server",
  "node:stream": "\0stub:node-stream",
  "node:stream/web": "\0stub:node-stream-web",
  "node:async_hooks": "\0stub:node-async-hooks",
  "tanstack-start-injected-head-scripts:v": "\0stub:tanstack-head-scripts",
};

// Minimal stub source for each virtual module.
/** @type {Record<string, string>} */
const STUB_SOURCE = {
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

/** @returns {import("vite").PluginOption} */
export function decoVitePlugin() {
  /** @type {import("vite").Plugin} */
  const plugin = {
    name: "deco-server-only-stubs",
    enforce: "pre",

    resolveId(id, _importer, options) {
      // Server builds keep the real modules.
      if (options?.ssr) return undefined;
      return CLIENT_STUBS[id];
    },

    load(id, options) {
      // blocks.gen.ts — the CMS block registry (can be 10MB+).
      if (id.endsWith("blocks.gen.ts")) {
        // Client: stub — the browser receives pre-resolved sections.
        if (!options?.ssr) {
          return "export const blocks = {};";
        }

        // SSR: read .json sibling and emit JSON.parse(...) wrapper.
        // This avoids the Vite SSR module runner hanging on large dynamic
        // imports and lets V8 use its fast JSON parser (~2-10x vs object literal).
        const jsonPath = id.replace(/\.ts$/, ".json");
        if (existsSync(jsonPath)) {
          const raw = readFileSync(jsonPath, "utf-8");
          return `export const blocks = JSON.parse(${JSON.stringify(raw)});`;
        }

        // Fallback: if .json doesn't exist yet (pre-generate-blocks), let
        // Vite load the .ts file normally (may contain inline data for
        // backward-compatible sites that haven't regenerated).
      }

      // Virtual module stubs.
      return STUB_SOURCE[id];
    },

    configureServer(server) {
      // When blocks.gen.json changes on disk, invalidate the .ts module
      // so Vite re-runs our load() hook with the fresh data.
      server.watcher.on("change", (file) => {
        if (file.endsWith("blocks.gen.json")) {
          const tsId = file.replace(/\.json$/, ".ts");
          const mod = server.environments?.ssr?.moduleGraph?.getModuleById(tsId);
          if (mod) {
            server.environments.ssr.moduleGraph.invalidateModule(mod);
          }
        }
      });
    },

    config(_cfg, { command }) {
      // Only split chunks for production builds — dev uses unbundled ESM.
      if (command !== "build") return;
      return {
        build: {
          rollupOptions: {
            output: {
              manualChunks(id) {
                if (
                  id.includes("node_modules/react-dom") ||
                  id.includes("node_modules/react/")
                ) {
                  return "vendor-react";
                }
                if (
                  id.includes("@tanstack/react-router") ||
                  id.includes("@tanstack/start")
                ) {
                  return "vendor-router";
                }
                if (id.includes("@tanstack/react-query")) {
                  return "vendor-query";
                }
                if (id.includes("@decocms/start")) {
                  return "vendor-deco";
                }
                if (id.includes("@decocms/apps")) {
                  return "vendor-commerce";
                }
              },
            },
          },
        },
      };
    },

    configEnvironment(name, env) {
      if (name === "ssr" || name === "client") {
        env.optimizeDeps = env.optimizeDeps || {};
        env.optimizeDeps.esbuildOptions =
          env.optimizeDeps.esbuildOptions || {};
        env.optimizeDeps.esbuildOptions.jsx = "automatic";
        env.optimizeDeps.esbuildOptions.jsxImportSource = "react";
      }
    },

    generateBundle(_, bundle) {
      // Build a mapping from section key to chunk filename.
      // Sites use this to emit <link rel="modulepreload"> for eager sections.
      const map = {};
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type === "chunk" && chunk.facadeModuleId) {
          const match = chunk.facadeModuleId.match(/\/(sections\/.+\.tsx)$/);
          if (match) {
            map["site/" + match[1]] = fileName;
          }
        }
      }
      if (Object.keys(map).length > 0) {
        this.emitFile({
          type: "asset",
          fileName: "section-chunks.json",
          source: JSON.stringify(map),
        });
      }
    },
  };

  return plugin;
}
