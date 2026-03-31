# Vite Configuration

## Final Config (Post-Migration)

After all imports are rewritten, the config should be minimal:

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
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
      },
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "~": srcDir,
    },
  },
});
```

**One alias only**: `~` -> `src/`. Nothing else.

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
