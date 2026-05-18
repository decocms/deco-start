import { promises as fs } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsup";

const BIN_FILES = [
  "dist/scripts/migrate.cjs",
  "dist/scripts/migrate-post-cleanup.cjs",
  "dist/scripts/htmx-analyze.cjs",
  "dist/scripts/migrate-to-cf-observability.cjs",
  "dist/scripts/audit-observability-config.cjs",
];

async function addShebangs() {
  const SHEBANG = "#!/usr/bin/env node\n";
  for (const file of BIN_FILES) {
    const path = join(process.cwd(), file);
    try {
      const content = await fs.readFile(path, "utf8");
      // Replace any existing shebang (e.g. from source `#!/usr/bin/env tsx`)
      // with the node shebang for the compiled bin.
      const body = content.startsWith("#!")
        ? content.slice(content.indexOf("\n") + 1)
        : content;
      if (!content.startsWith(SHEBANG)) {
        await fs.writeFile(path, SHEBANG + body, "utf8");
      }
      await fs.chmod(path, 0o755);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

const sharedExternal = [
  "@tanstack/react-query",
  "@tanstack/react-start",
  "@tanstack/react-start/server",
  "@tanstack/react-start/api",
  "@tanstack/react-start/server-entry",
  "@tanstack/react-router",
  "@tanstack/store",
  "react",
  "react-dom",
  "react-dom/server",
  "next",
  "next/server",
  "vite",
  "node:async_hooks",
  "node:stream",
  "node:fs",
  "node:crypto",
  "node:path",
  "node:url",
  "node:util",
  // Unprefixed Node built-ins pulled in by bundled deps (ts-morph, fdir, etc.).
  // Required because platform: "neutral" does not auto-externalize Node built-ins.
  "fs",
  "path",
  "os",
  "url",
  "util",
  "stream",
  "crypto",
  "events",
  "buffer",
  "assert",
  "tty",
  "child_process",
  "inspector",
  "perf_hooks",
  "module",
  "fs/promises",
  "async_hooks",
];

export default defineConfig([
  {
    name: "src",
    entry: [
      "src/index.ts",
      "src/tanstack/index.ts",
      "src/tanstack/hooks/index.ts",
      "src/tanstack/middleware/index.ts",
      "src/tanstack/middleware/healthMetrics.ts",
      "src/tanstack/middleware/hydrationContext.ts",
      "src/tanstack/middleware/validateSection.ts",
      "src/tanstack/routes/index.ts",
      "src/tanstack/sdk/*.ts",
      "src/tanstack/apps/index.ts",
      "src/tanstack/apps/autoconfig.ts",
      "src/tanstack/daemon/index.ts",
      "src/tanstack/daemon/*.ts",
      "src/tanstack/vite/plugin.js",
      "src/core/index.ts",
      "src/core/cms/index.ts",
      "src/core/sdk/index.ts",
      "src/core/sdk/*.ts",
      "src/core/sdk/otelAdapters/*.ts",
      "src/core/admin/index.ts",
      "src/core/matchers/builtins.ts",
      "src/core/matchers/posthog.ts",
      "src/core/types/index.ts",
      "src/core/types/widgets.ts",
      "src/core/runtime/index.ts",
      "src/core/runtime/*.ts",
      "src/tanstack/runtime/index.ts",
      "src/tanstack/runtime/*.ts",
      "src/tanstack/setup.ts",
      "src/next/index.ts",
      "src/next/client.ts",
      "src/next/*.ts",
      "src/next/*.tsx",
      "src/node/index.ts",
      "src/node/*.ts",
    ],
    format: ["esm", "cjs"],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: true,
    outDir: "dist",
    target: "es2022",
    external: sharedExternal,
    esbuildOptions(opts) {
      opts.jsx = "automatic";
      opts.platform = "neutral";
      opts.outbase = "src";
    },
    ignoreWatch: ["**/*.test.ts", "**/*.test.tsx"],
  },
  {
    name: "scripts",
    entry: [
      "scripts/generate-blocks.ts",
      "scripts/generate-schema.ts",
      "scripts/generate-invoke.ts",
      "scripts/generate-sections.ts",
      "scripts/generate-loaders.ts",
      "scripts/migrate.ts",
      "scripts/migrate-post-cleanup.ts",
      "scripts/migrate-to-cf-observability.ts",
      "scripts/audit-observability-config.ts",
      "scripts/htmx-analyze.ts",
      "scripts/tailwind-lint.ts",
    ],
    // Scripts are CLI tools invoked via `node …/foo.cjs` — CJS only. ESM bundles
    // of ts-morph (which inlines TypeScript) leave `require("fs")` callsites
    // intact; in an ESM context those go through a __require shim that throws
    // "Dynamic require of fs is not supported". package.json `"type": "module"`
    // means a bare .js file would be loaded as ESM, so we don't ship one.
    format: ["cjs"],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: false,
    outDir: "dist/scripts",
    target: "es2022",
    // platform: "node" auto-externalizes Node built-ins and emits proper
    // require() for bundled CJS deps. Avoids the dynamic-require shim that
    // platform: "neutral" produces.
    external: sharedExternal,
    esbuildOptions(opts) {
      opts.jsx = "automatic";
      opts.platform = "node";
      opts.outbase = "scripts";
    },
    ignoreWatch: ["**/*.test.ts", "**/*.test.tsx"],
    async onSuccess() {
      await addShebangs();
    },
  },
]);
