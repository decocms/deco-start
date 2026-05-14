import { existsSync, promises as fs } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { defineConfig } from "tsup";

const ROOT = process.cwd();

// Source files / directories whose module-level state MUST live in exactly one
// published bundle. Without this, tsup's per-entry self-contained bundles each
// inline a copy of the module, producing independent module-private state per
// bundle (writers and readers disagree → "Unknown handler" 404s and similar
// silent state-split bugs). See the invoke registry incident, May 2026.
//
// Rule: any RELATIVE import that resolves to one of these targets gets
// rewritten to the canonical bare subpath and marked `external`, unless the
// importer is itself the owner. Node's module loader dedupes bare specifiers
// at runtime → single shared module instance.

// Directory-based ownership: any source file under `dir` → `subpath`.
// Importers inside the same dir inline (the owning bundle inlines its own
// internals); cross-dir importers externalize.
const DIR_OWNERS: ReadonlyArray<{ dir: string; subpath: string }> = [
  { dir: "src/core/admin/", subpath: "@decocms/start/admin" },
  { dir: "src/core/cms/", subpath: "@decocms/start/cms" },
];

// File-based ownership: any non-self import targeting this file externalizes.
// Used for sdk files that publish their own subpath and own mutable state.
const FILE_OWNERS: Readonly<Record<string, string>> = {
  "src/core/sdk/requestContext.ts": "@decocms/start/sdk/requestContext",
  "src/core/sdk/normalizeUrls.ts": "@decocms/start/sdk/normalizeUrls",
  "src/core/sdk/logger.ts": "@decocms/start/sdk/logger",
  "src/core/sdk/otel.ts": "@decocms/start/sdk/otel",
};

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function resolveRelativeImport(importer: string, importPath: string): string | null {
  const base = resolve(dirname(importer), importPath);
  // Extension-less imports only (TS convention). `base` itself is intentionally
  // not a candidate — `existsSync` returns true for directories, which would
  // mismatch `../../core/cms` (a dir) before falling through to `.../index.ts`.
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    join(base, "index.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function ownerOf(absPath: string): { subpath: string; key: string } | null {
  const rel = toPosix(relative(ROOT, absPath));
  if (FILE_OWNERS[rel]) {
    return { subpath: FILE_OWNERS[rel], key: rel };
  }
  for (const { dir, subpath } of DIR_OWNERS) {
    if (rel.startsWith(dir)) {
      return { subpath, key: dir };
    }
  }
  return null;
}

const externalizeStatefulPlugin = {
  name: "externalize-stateful-subpaths",
  setup(build: {
    onResolve: (
      opts: { filter: RegExp },
      cb: (args: {
        path: string;
        importer: string;
      }) => { path: string; external: boolean } | null | undefined,
    ) => void;
  }) {
    build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
      if (!args.importer) return null;
      const resolved = resolveRelativeImport(args.importer, args.path);
      if (!resolved) return null;
      const target = ownerOf(resolved);
      if (!target) return null;
      const source = ownerOf(args.importer);
      // Same owner (dir-or-file) → inline. The owning bundle has the impl;
      // everyone else gets a runtime require/import of the bare subpath.
      if (source && source.subpath === target.subpath) return null;
      return { path: target.subpath, external: true };
    });
  },
};

const BIN_FILES = [
  "dist/scripts/migrate.cjs",
  "dist/scripts/migrate-post-cleanup.cjs",
  "dist/scripts/htmx-analyze.cjs",
  "dist/scripts/migrate-to-cf-observability.cjs",
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
      "src/node/daemon/index.ts",
      "src/node/daemon/*.ts",
    ],
    format: ["esm", "cjs"],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: true,
    outDir: "dist",
    target: "es2022",
    external: sharedExternal,
    esbuildPlugins: [externalizeStatefulPlugin],
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
