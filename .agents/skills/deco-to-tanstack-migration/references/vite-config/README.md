# Vite Configuration

For the canonical battle-tested template (with VTEX dev proxy, CSP headers,
React Compiler, dedupe, framework plugin, and rollup chunk strategy) see
[`../../templates/vite-config.md`](../../templates/vite-config.md).

This page covers the post-migration **minimum viable config** if you've
stripped everything optional. Real sites should use the full template.

## Minimum Viable Config

```typescript
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { decoVitePlugin } from "@decocms/start/vite";
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
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
      },
    }),
    tailwindcss(),
    // Required — server-only stubs, blocks.gen.ts fast-path, meta.gen
    // client stub, daemon/tunnel for dev mode. Without this, client
    // bundle crashes on node:async_hooks / react-dom/server transitively
    // imported by @decocms/start.
    decoVitePlugin(),
  ],
  resolve: {
    // Required — dedupe React/TanStack/Deco packages so there's only one
    // instance of each. Without this you get "Invalid hook call" errors.
    dedupe: [
      "@decocms/start",
      "@decocms/apps",
      "@tanstack/react-start",
      "@tanstack/react-router",
      "react",
      "react-dom",
    ],
    alias: {
      "~": srcDir,
    },
  },
});
```

**One alias only**: `~` -> `src/`. Nothing else.

The `decoVitePlugin()` call is **mandatory** — the older skill examples
that omitted it (or inlined the stub logic) reflect the pre-2.x state of
`@decocms/start` and will produce build/runtime failures on current versions.

## tsconfig.json

Must mirror the Vite alias:

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

No `$store/*`, `site/*`, `apps/*`, `preact`, `@preact/signals`, `@deco/deco` paths. Those are all dead.

## React Compiler

The `babel-plugin-react-compiler` with `target: "19"` enables automatic memoization. Requires `@vitejs/plugin-react` instead of the default SWC plugin.

Install: `npm install -D @vitejs/plugin-react babel-plugin-react-compiler`

## Environment Variables

For VTEX API keys, use Cloudflare Workers secrets or `.dev.vars`:

```
VTEX_ACCOUNT=mystore
VTEX_APP_KEY=...
VTEX_APP_TOKEN=...
```

Accessed via `process.env.*` in `createServerFn` handlers.
