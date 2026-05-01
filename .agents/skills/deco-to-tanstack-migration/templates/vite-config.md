# vite.config.ts Template

Battle-tested configuration. Uses the framework's `decoVitePlugin()` for the
server-only stub layer (rather than re-implementing it inline like older
sites did).

```typescript
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { decoVitePlugin } from "@decocms/start/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import path from "path";

const srcDir = path.resolve(__dirname, "src");

// VTEX dev proxy — adjust to your account / commerce backend.
const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT || "mystore";
const VTEX_ORIGIN = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br`;

export default defineConfig({
  server: {
    port: parseInt(process.env.PORT ?? "5173", 10),
    // When the deco daemon injects PORT, bind to all interfaces so Deno's
    // TCP connect (127.0.0.1) can reach Vite regardless of IPv4/IPv6.
    host: process.env.PORT ? "0.0.0.0" : undefined,
    headers: {
      // Allow embedding in iframes from trusted admin origins.
      "Content-Security-Policy":
        "frame-ancestors 'self' https://*.deco.studio http://localhost:* https://localhost:* https://admin.deco.cx https://studio.decocms.com",
    },
    proxy: {
      "/api/": {
        target: VTEX_ORIGIN,
        changeOrigin: true,
        cookieDomainRewrite: { "*": "" },
      },
      "/checkout": {
        target: VTEX_ORIGIN,
        changeOrigin: true,
        cookieDomainRewrite: { "*": "" },
      },
    },
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({ server: { entry: "server" } }),
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
      },
    }),
    tailwindcss(),
    // Framework plugin — provides server-only stubs (react-dom/server,
    // node:async_hooks, etc.), blocks.gen.ts JSON-fast-path, meta.gen
    // client stub, daemon/tunnel for dev mode, and correct manualChunks
    // (NOT splitting @decocms/start / @decocms/apps which have circular
    // re-exports). Replaces ~80 lines of boilerplate that older sites
    // had inline.
    decoVitePlugin(),
  ],
  build: {
    sourcemap: "hidden",
    rollupOptions: {
      onLog(level, log, handler) {
        // Silence harmless "dynamic import will not move module" warning
        // emitted when a module is imported both statically and dynamically.
        if (
          log.code === "PLUGIN_WARNING" &&
          log.plugin === "vite:reporter" &&
          log.message?.includes("dynamic import will not move module")
        ) {
          return;
        }
        handler(level, log);
      },
    },
  },
  define: {
    // Inject site name at build time, not read at runtime.
    "process.env.DECO_SITE_NAME": JSON.stringify(
      process.env.DECO_SITE_NAME || "my-store",
    ),
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
    // Strip console.log in production; keep .warn / .error for debugging.
    pure: ["console.log"],
  },
  resolve: {
    // CRITICAL: without dedupe, multiple React/TanStack instances cause
    // "Invalid hook call" errors at runtime.
    dedupe: [
      "@decocms/start",
      "@decocms/apps",
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

1. **`decoVitePlugin()`** — Required. Replaces ~80 lines of inline boilerplate
   that older sites had to copy. Provides:
   - Client stubs for server-only modules (`react-dom/server`,
     `node:async_hooks`, `node:stream`, etc.)
   - `blocks.gen.ts` JSON fast-path (10-100x parse speedup for large registries)
   - `meta.gen.{json,ts}` client stub (cuts admin schema 0.5-5MB out of
     browser bundle)
   - Daemon/tunnel for dev mode (when `DECO_SITE_NAME` env is set)
   - Production `manualChunks` that does NOT split `@decocms/start` or
     `@decocms/apps` (those have circular re-exports and crash when chunked
     separately)
   - `allowedHosts` for tunnel domains (`.deco.host`, `.decocdn.com`,
     `.deco.studio`)
   - JSX automatic / react import-source defaults

2. **`resolve.dedupe`** — Required. Without it, multiple React instances
   cause "Invalid hook call" errors. The list MUST include both
   `@decocms/start` and `@decocms/apps` because they re-export TanStack
   types and registry singletons.

3. **`process.env.DECO_SITE_NAME` via `define`** — Must be injected at
   build time, not read at runtime. Workers don't have a Node-style
   `process.env` at runtime.

4. **React Compiler** — `babel-plugin-react-compiler` with `target: "19"`
   for automatic memoization. Requires `@vitejs/plugin-react`, not the
   default SWC plugin.

5. **`esbuild.jsx: "automatic"` with `jsxImportSource: "react"`** — Without
   it, JSX falls back to `React.createElement` references that may not
   resolve.

6. **CSP `frame-ancestors`** — Required for the admin (`*.deco.studio`,
   `admin.deco.cx`, `studio.decocms.com`) to embed previews in iframes.

7. **VTEX dev proxy** — Local `/api/`, `/checkout` requests proxied to
   the upstream commerce backend so cookie-based session works in dev
   without CORS gymnastics.

## What older site templates inline (and why this template doesn't)

Some older guides show two extra inline plugins:

```ts
// site-manual-chunks — overrides framework default chunking
{ name: "site-manual-chunks", config(_cfg, { command }) { ... } }

// deco-stub-meta-gen — stubs admin schema on client
{ name: "deco-stub-meta-gen", enforce: "pre", resolveId(...), load(...) }
```

Both are obsolete after `@decocms/start` >= 2.5.0:
- The framework's `manualChunks` no longer splits `@decocms/start` /
  `@decocms/apps` (the old split caused circular-dep load-order crashes —
  every site overrode it).
- The framework now stubs `meta.gen.{json,ts}` on the client by default.

If you're on an older version, keep the inline plugins until you can bump.

## tsconfig.json (matches the Vite alias)

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "moduleResolution": "bundler",
    "module": "ESNext",
    "target": "ES2022",
    "skipLibCheck": true,
    "strictNullChecks": true,
    "baseUrl": ".",
    "paths": {
      "~/*": ["./src/*"]
    }
  },
  "include": ["src/**/*", "vite.config.ts"]
}
```

No `$store/*`, `site/*`, `apps/*`, `preact`, `@preact/signals`,
`@deco/deco` paths. Those are all dead.
