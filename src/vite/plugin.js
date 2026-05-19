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
 * meta.gen handling:
 *   The admin schema bundle (`server/admin/meta.gen.json`) is server-only;
 *   the client receives pre-resolved blocks via the SSR payload. Stubbing
 *   it on the client cuts a typically-large module out of the browser bundle.
 *   Match is done by substring on the import id, so any path style works.
 *
 * manualChunks:
 *   `@decocms/start` and `@decocms/apps` are intentionally NOT split into
 *   their own chunks. They have circular re-exports that produce a load-order
 *   crash when chunked separately. Rollup's default bundling (group with
 *   importer or vendor catch-all) avoids that.
 *
 * Usage:
 * ```ts
 * import { decoVitePlugin } from "@decocms/start/vite";
 * export default defineConfig({ plugins: [decoVitePlugin(), ...] });
 * ```
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Resolve a per-build identifier for cache-key versioning.
 *
 * The returned string is injected into the worker bundle as the
 * `__DECO_BUILD_HASH__` global via Vite `define`. `createDecoWorkerEntry`
 * appends it (or `env.BUILD_HASH` if explicitly set) as `__v=<hash>` on
 * every Cache API key, so each new deploy gets its own cache namespace
 * — old edge-cached HTML referencing dead asset filenames stops being
 * served the moment the new worker is live.
 *
 * Resolution order:
 *   1. WORKERS_CI_COMMIT_SHA — Cloudflare Workers Builds default env var
 *      (the production deploy path-of-record). Sliced to 12 chars.
 *   2. `git rev-parse --short=12 HEAD` — local `wrangler deploy` from a
 *      developer laptop. Try/catch so missing git or shallow clones don't
 *      fail the build.
 *   3. `Date.now().toString(36)` — last-resort fallback so the cache-bust
 *      invariant never silently regresses to "always the same key".
 *
 * For dev (`command !== "build"`), the value is the literal `"dev"`.
 *
 * @returns {string}
 */
function resolveBuildHash() {
  const ciSha = process.env.WORKERS_CI_COMMIT_SHA;
  if (ciSha?.trim()) return ciSha.trim().slice(0, 12);

  try {
    const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (sha) return sha;
  } catch {
    // git absent, not a repo, or shallow clone w/o history — fall through.
  }

  return Date.now().toString(36);
}

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

// SSR-only stubs. Same mechanism as CLIENT_STUBS but applied to the worker
// SSR build instead of the browser build.
/** @type {Record<string, string>} */
const SSR_STUBS = {
  // `@opentelemetry/resources` (transitively pulled in by sdk-logs /
  // sdk-metrics / exporter-* OTel packages — five copies in node_modules due
  // to OTel monorepo peer-dep version pinning) statically imports bare `fs`
  // inside its node-platform machine-id detectors. We never call those
  // detectors — `instrumentWorker` builds the OTel Resource from explicit
  // attributes only — but Vite's CF Workers SSR resolver still walks the
  // re-export barrel and chokes on the bare `fs` specifier (workerd's
  // `nodejs_compat` only exposes the prefixed `node:fs`, not the legacy
  // bare form). Stub it; the static import resolves and the unreachable
  // detector code is never executed.
  fs: "\0stub:bare-fs",
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

  "\0stub:tanstack-head-scripts": "export const injectedHeadScripts = undefined;",

  // The admin schema bundle is server-only — the client receives pre-resolved
  // blocks via the SSR payload. Stubbing it on the client cuts a large module
  // (typically 0.5-5 MB) out of the browser bundle.
  "\0stub:meta-gen": "export default {};",

  // Bare `fs` shim — see SSR_STUBS comment above for the rationale. Surfaces
  // just enough of `import { promises as fs } from 'fs'` to satisfy static
  // module resolution; method calls would throw, but the OTel detector code
  // path is unreachable from `instrumentWorker`.
  "\0stub:bare-fs": "export const promises = {}; export default { promises };",
};

/** @returns {import("vite").PluginOption} */
export function decoVitePlugin() {
  /** @type {import("vite").Plugin} */
  const plugin = {
    name: "deco-server-only-stubs",
    enforce: "pre",

    resolveId(id, importer, options) {
      // SSR-only stubs — must be checked first since the client guard below
      // returns undefined for everything that hasn't matched yet on SSR.
      if (options?.ssr && SSR_STUBS[id]) return SSR_STUBS[id];
      // Server builds keep the real modules.
      if (options?.ssr) return undefined;
      // Bare-specifier exact-match stubs (react-dom/server, node:stream, etc.).
      if (CLIENT_STUBS[id]) return CLIENT_STUBS[id];
      // meta.gen.{json,ts} — the admin schema bundle. Server-only; client
      // receives pre-resolved blocks. Matches both file extensions so the
      // plugin works whether `setup.ts` imports the .json directly (current)
      // or a future variant routes through a generated .ts wrapper.
      // Requires `importer` so we don't accidentally stub the entry module.
      if (importer && (id.endsWith("meta.gen.json") || id.endsWith("meta.gen.ts"))) {
        return "\0stub:meta-gen";
      }
      return undefined;
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

      // Watch `.deco/blocks/**/*.json` and regenerate `blocks.gen.json` when
      // CMS content changes (manual edit, sync-decofile, daemon PATCH). The
      // existing change listener above then invalidates the SSR module so
      // the next request renders fresh data — no manual `generate:blocks`
      // and no dev-server restart required.
      //
      // Generator is loaded lazily via tsImport (same pattern as the daemon
      // below) so we don't depend on the consumer's TS loader.
      const cwd = process.cwd();
      const blocksDir = path.resolve(cwd, ".deco/blocks");
      const outFile = path.resolve(cwd, "src/server/cms/blocks.gen.ts");
      const jsonFile = outFile.replace(/\.ts$/, ".json");

      let generateBlocksFn;
      const loadGenerator = () => {
        if (generateBlocksFn) return Promise.resolve(generateBlocksFn);
        // Same tsImport pattern as the daemon loader below — keeps `tsx`
        // scoped to this single import instead of registering a global hook.
        return import("tsx/esm/api")
          .then(({ tsImport }) =>
            tsImport("../../scripts/generate-blocks.ts", import.meta.url),
          )
          .then((mod) => {
            generateBlocksFn = mod.generateBlocks;
            return generateBlocksFn;
          });
      };

      let regenTimer = null;
      let regenInFlight = false;
      let regenQueued = false;
      const runRegen = async () => {
        if (regenInFlight) {
          regenQueued = true;
          return;
        }
        regenInFlight = true;
        try {
          const fn = await loadGenerator();
          const start = Date.now();
          const result = await fn({ blocksDir, outFile, silent: true });
          const ms = Date.now() - start;
          if (result.empty) {
            console.warn(`[deco] .deco/blocks not found — emitted empty blocks.gen.json`);
          } else {
            console.log(`[deco] regenerated ${result.count} blocks in ${ms}ms`);
          }
        } catch (err) {
          console.warn("[deco] failed to regenerate blocks:", err?.message ?? err);
        } finally {
          regenInFlight = false;
          if (regenQueued) {
            regenQueued = false;
            scheduleRegen();
          }
        }
      };
      const scheduleRegen = () => {
        if (regenTimer) clearTimeout(regenTimer);
        regenTimer = setTimeout(() => {
          regenTimer = null;
          runRegen();
        }, 150);
      };

      // chokidar (Vite's watcher) needs the directory added explicitly because
      // `.deco/` lives outside the module graph it walks by default.
      if (existsSync(blocksDir)) {
        server.watcher.add(blocksDir);
      }
      const handleBlocksDirEvent = (file) => {
        if (!file.endsWith(".json")) return;
        if (!file.startsWith(blocksDir + path.sep) && file !== blocksDir) return;
        scheduleRegen();
      };
      server.watcher.on("add", handleBlocksDirEvent);
      server.watcher.on("change", handleBlocksDirEvent);
      server.watcher.on("unlink", handleBlocksDirEvent);

      // Cold-start bootstrap: regenerate once if the artifact is missing or
      // older than the newest source file. Skips work on a clean build where
      // `npm run build` already produced a current artifact.
      try {
        const needsBootstrap = (() => {
          if (!existsSync(jsonFile)) return existsSync(blocksDir);
          if (!existsSync(blocksDir)) return false;
          const artifactMtime = statSync(jsonFile).mtimeMs;
          for (const entry of readdirSync(blocksDir)) {
            if (!entry.endsWith(".json")) continue;
            try {
              if (statSync(path.join(blocksDir, entry)).mtimeMs > artifactMtime) {
                return true;
              }
            } catch {
              // skip unreadable entries
            }
          }
          return false;
        })();
        if (needsBootstrap) {
          // Fire and forget — the next request that touches blocks.gen.ts
          // will see the fresh artifact thanks to the change listener above.
          runRegen();
        }
      } catch (err) {
        console.warn("[deco] blocks bootstrap check failed:", err?.message ?? err);
      }

      // Tunnel + daemon: connect local dev to admin.deco.cx
      // Activated only when both DECO_SITE_NAME and DECO_ENV_NAME are set.
      // Omitting DECO_ENV_NAME runs Vite fully local (no tunnel registration),
      // since DECO_SITE_NAME alone is also consumed by site builds via vite's
      // `define` for `process.env.DECO_SITE_NAME` and shouldn't force a tunnel.
      const siteName = process.env.DECO_SITE_NAME;
      const envName = process.env.DECO_ENV_NAME;
      if (siteName && envName) {
        // Daemon files are .ts and live inside node_modules. Node's
        // experimental strip-types refuses to transpile node_modules, so
        // a plain dynamic `import()` blows up under `vite dev`. Use tsx's
        // ad-hoc loader (`tsImport`) — scoped to this import, doesn't
        // register a global hook.
        const loadDaemon = (specifier) =>
          import("tsx/esm/api").then(({ tsImport }) => tsImport(specifier, import.meta.url));

        // Add daemon middleware (x-daemon-api interception + auth + volumes + SSE + admin routes)
        loadDaemon("../daemon/middleware.ts")
          .then(({ createDaemonMiddleware }) => {
            server.middlewares.use(createDaemonMiddleware({ site: siteName, server }));
          })
          .catch((err) => {
            console.warn("[deco] Failed to load daemon middleware:", err.message);
          });

        // Start tunnel after HTTP server is listening (so we know the real port)
        server.httpServer?.once("listening", async () => {
          const addr = server.httpServer?.address();
          const port = typeof addr === "object" && addr ? addr.port : 5173;
          try {
            const { startTunnel } = await loadDaemon("../daemon/tunnel.ts");
            const tunnel = await startTunnel({
              site: siteName,
              env: envName,
              port,
              decoHost: process.env.DECO_HOST === "true",
            });
            server.httpServer?.on("close", () => tunnel.close());
          } catch (err) {
            console.warn("[deco] Failed to start tunnel:", err.message);
          }
        });
      }
    },

    config(_cfg, { command }) {
      /** @type {import("vite").UserConfig} */
      const cfg = {};

      // Allow tunnel domains through Vite's host check.
      // .deco.studio is the new admin frontend; both real-world Deco sites
      // (casaevideo-storefront, baggagio-tanstack) duplicated this list to
      // include it — bundling it here removes that boilerplate.
      if (process.env.DECO_SITE_NAME) {
        cfg.server = {
          allowedHosts: [".deco.host", ".decocdn.com", ".deco.studio"],
        };
      }

      // Inject a per-build identifier as `__DECO_BUILD_HASH__` so
      // createDecoWorkerEntry can fall back to it when env.BUILD_HASH is
      // unset (the default on Cloudflare Workers Builds, where there's
      // no GH-Actions step injecting --var BUILD_HASH).
      //
      // Dev gets the literal "dev" so SSR doesn't crash on an undefined
      // identifier; prod gets WORKERS_CI_COMMIT_SHA → git rev-parse →
      // time-based fallback (see resolveBuildHash above).
      const buildHash = command === "build" ? resolveBuildHash() : "dev";
      cfg.define = {
        ...cfg.define,
        __DECO_BUILD_HASH__: JSON.stringify(buildHash),
      };

      // Only split chunks for production builds — dev uses unbundled ESM.
      if (command !== "build") return cfg;
      return {
        ...cfg,
        build: {
          rollupOptions: {
            output: {
              manualChunks(id) {
                if (id.includes("node_modules/react-dom") || id.includes("node_modules/react/")) {
                  return "vendor-react";
                }

                // TanStack Router — client-side router (always needed)
                if (id.includes("@tanstack/react-router") || id.includes("@tanstack/router-core")) {
                  return "vendor-router";
                }

                // TanStack Start — specific checks before broad catch-all
                // (react-start-client includes "react-start" so must come first)
                if (
                  id.includes("@tanstack/react-start-client") ||
                  id.includes("@tanstack/start-client-core")
                ) {
                  return "vendor-router";
                }
                // Server-only TanStack packages — let Rollup tree-shake
                if (
                  id.includes("@tanstack/react-start-server") ||
                  id.includes("@tanstack/start-server-core")
                ) {
                  return undefined;
                }
                // Remaining @tanstack/start (storage-context, plugin-core, etc.)
                if (id.includes("@tanstack/start")) {
                  return "vendor-router";
                }

                // isbot — server-only (bot detection in resolve.ts)
                if (id.includes("node_modules/isbot")) {
                  return undefined;
                }

                if (id.includes("@tanstack/react-query")) {
                  return "vendor-query";
                }
                // Intentionally NOT splitting @decocms/start or @decocms/apps:
                // they have circular re-exports (e.g. apps imports from
                // start/sdk/cachedLoader, start admin imports from apps).
                // Splitting them into separate chunks produces a Rollup
                // chunk-load order that crashes at runtime ("undefined is not
                // a function") — both real-world sites worked around this by
                // overriding manualChunks. Letting Rollup bundle them together
                // (or with the importing chunk) is correct.
              },
            },
          },
        },
      };
    },

    configEnvironment(name, env) {
      if (name === "ssr" || name === "client") {
        env.optimizeDeps = env.optimizeDeps || {};
        env.optimizeDeps.esbuildOptions = env.optimizeDeps.esbuildOptions || {};
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
