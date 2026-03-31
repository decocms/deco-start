# vite.config.ts Template

Battle-tested configuration from espacosmart-storefront.

```typescript
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import path from "path";

const srcDir = path.resolve(__dirname, "src");

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({ server: { entry: "server" } }),
    react({
      babel: {
        plugins: [
          ["babel-plugin-react-compiler", { target: "19" }],
        ],
      },
    }),
    tailwindcss(),
    // CRITICAL: Stubs for client bundles that transitively import server modules.
    // Without this, client build crashes on node:async_hooks, react-dom/server, etc.
    {
      name: "deco-server-only-stubs",
      enforce: "pre" as const,
      resolveId(id, _importer, options) {
        if (options?.ssr) return undefined;
        const CLIENT_STUBS: Record<string, string> = {
          "react-dom/server": "\0stub:react-dom-server",
          "react-dom/server.browser": "\0stub:react-dom-server",
          "node:stream": "\0stub:node-stream",
          "node:stream/web": "\0stub:node-stream-web",
          "node:async_hooks": "\0stub:node-async-hooks",
          "tanstack-start-injected-head-scripts:v": "\0stub:tanstack-head-scripts",
        };
        return CLIENT_STUBS[id];
      },
      configEnvironment(name: string, env: any) {
        if (name === "ssr" || name === "client") {
          env.optimizeDeps = env.optimizeDeps || {};
          env.optimizeDeps.esbuildOptions = env.optimizeDeps.esbuildOptions || {};
          env.optimizeDeps.esbuildOptions.jsx = "automatic";
          env.optimizeDeps.esbuildOptions.jsxImportSource = "react";
        }
      },
      load(id) {
        if (id === "\0stub:react-dom-server") {
          return [
            "const noop = () => '';",
            "export const renderToString = noop;",
            "export const renderToStaticMarkup = noop;",
            "export const renderToReadableStream = noop;",
            "export const resume = noop;",
            "export const version = '19.0.0';",
            "export default { renderToString: noop, renderToStaticMarkup: noop, renderToReadableStream: noop, resume: noop, version: '19.0.0' };",
          ].join("\n");
        }
        if (id === "\0stub:node-stream") {
          return "export class PassThrough {}; export class Readable {}; export class Writable {}; export default { PassThrough, Readable, Writable };";
        }
        if (id === "\0stub:node-stream-web") {
          return "export const ReadableStream = globalThis.ReadableStream; export const WritableStream = globalThis.WritableStream; export const TransformStream = globalThis.TransformStream; export default { ReadableStream, WritableStream, TransformStream };";
        }
        if (id === "\0stub:node-async-hooks") {
          return [
            "class _ALS { getStore() { return undefined; } run(_store, fn, ...args) { return fn(...args); } enterWith() {} disable() {} }",
            "export const AsyncLocalStorage = _ALS;",
            "export const AsyncResource = class {};",
            "export function executionAsyncId() { return 0; }",
            "export function createHook() { return { enable() {}, disable() {} }; }",
            "export default { AsyncLocalStorage: _ALS, AsyncResource, executionAsyncId, createHook };",
          ].join("\n");
        }
        if (id === "\0stub:tanstack-head-scripts") {
          return "export const injectedHeadScripts = undefined;";
        }
      },
    },
  ],
  // Inject site name at build time (not runtime)
  define: {
    "process.env.DECO_SITE_NAME": JSON.stringify(
      process.env.DECO_SITE_NAME || "my-store"
    ),
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  resolve: {
    // CRITICAL: Without dedupe, multiple React/TanStack instances cause hook errors
    dedupe: [
      "@tanstack/react-start",
      "@tanstack/react-router",
      "@tanstack/react-start-server",
      "@tanstack/start-server-core",
      "@tanstack/start-client-core",
      "@tanstack/start-plugin-core",
      "@tanstack/start-storage-context",
      "react",
      "react-dom",
    ],
    alias: {
      "~": srcDir,
    },
  },
});
```

## Key Points

1. **deco-server-only-stubs plugin** — Required. Client bundles transitively import `node:async_hooks`, `react-dom/server`, etc. Without stubs, build crashes.
2. **resolve.dedupe** — Required. Without it, multiple React instances cause "Invalid hook call" errors.
3. **process.env.DECO_SITE_NAME via define** — Must be injected at build time, not read at runtime.
4. **React Compiler** — `babel-plugin-react-compiler` with target 19 for automatic memoization.
5. **esbuild.jsx** — Must be `"automatic"` with `jsxImportSource: "react"` for proper JSX transform.
