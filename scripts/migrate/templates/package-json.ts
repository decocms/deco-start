import { execSync } from "node:child_process";
import type { MigrationContext } from "../types.ts";

/**
 * Get the latest published version of an npm package.
 * Falls back to the provided default if the lookup fails.
 */
function getLatestVersion(pkg: string, fallback: string): string {
  try {
    const version = execSync(`npm view ${pkg} version`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return version || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Extract npm dependencies from deno.json import map.
 * Entries like `"fuse.js": "npm:fuse.js@7.0.0"` become `"fuse.js": "^7.0.0"`.
 */
function extractNpmDeps(importMap: Record<string, string>): Record<string, string> {
  const deps: Record<string, string> = {};
  const SKIP_KEYS = new Set([
    "daisyui", "preact-render-to-string", "simple-git", "fast-json-patch",
    "postcss", "cssnano", "partytown",
  ]);
  for (const [key, value] of Object.entries(importMap)) {
    // Skip framework deps we handle ourselves
    if (key.startsWith("preact") || key.startsWith("@preact/")) continue;
    if (key.startsWith("@deco/")) continue;
    if (key.startsWith("@biomejs/")) continue;
    if (key.startsWith("firebase/")) continue;
    if (SKIP_KEYS.has(key)) continue;

    // npm: protocol — direct npm import
    if (value.startsWith("npm:")) {
      const raw = value.slice(4);
      const atIdx = raw.lastIndexOf("@");
      if (atIdx <= 0) {
        deps[raw] = "*";
      } else {
        const name = raw.slice(0, atIdx);
        let version = raw.slice(atIdx + 1);
        if (/^[~^>=<]/.test(version)) {
          deps[name] = version;
        } else {
          deps[name] = `^${version}`;
        }
      }
      continue;
    }

    // esm.sh URLs — extract package name and version
    const esmMatch = value.match(/esm\.sh\/(@?[^@?]+)@([^?/]+)/);
    if (esmMatch) {
      const [, name, version] = esmMatch;
      if (name.startsWith("preact") || name.startsWith("@preact/")) continue;
      deps[name] = `^${version}`;
      continue;
    }
  }
  return deps;
}

export function generatePackageJson(ctx: MigrationContext): string {
  const extractedDeps = {
    ...extractNpmDeps(ctx.importMap),
    ...ctx.discoveredNpmDeps,
  };

  // Consolidate firebase/* split imports into single package
  const hasFirebase = Object.keys(ctx.importMap).some((k) => k.startsWith("firebase"));
  if (hasFirebase && !extractedDeps["firebase"]) {
    extractedDeps["firebase"] = "^12.10.0";
  }
  // Remove wildcard versions
  for (const [k, v] of Object.entries(extractedDeps)) {
    if (v === "^*" || v === "*") extractedDeps[k] = "latest";
  }

  const siteDeps = extractedDeps;

  // Fetch latest versions from npm registry
  const startVersion = getLatestVersion("@decocms/start", "0.34.0");
  const appsVersion = getLatestVersion("@decocms/apps", "0.27.0");

  const pkg = {
    name: ctx.siteName,
    version: "0.1.0",
    type: "module",
    description: `${ctx.siteName} storefront powered by TanStack Start`,
    scripts: {
      dev: "vite dev",
      "dev:clean":
        "rm -rf node_modules/.vite .wrangler/state .tanstack && vite dev",
      "generate:blocks":
        "tsx node_modules/@decocms/start/scripts/generate-blocks.ts",
      "generate:routes": "tsr generate",
      "generate:schema": `tsx node_modules/@decocms/start/scripts/generate-schema.ts --site ${ctx.siteName}`,
      "generate:invoke":
        "tsx node_modules/@decocms/start/scripts/generate-invoke.ts",
      "generate:sections":
        "tsx node_modules/@decocms/start/scripts/generate-sections.ts",
      "generate:loaders": `tsx node_modules/@decocms/start/scripts/generate-loaders.ts --exclude vtex/loaders,vtex/actions,loaders/vtex-auth-loader,loaders/reviews/productReviews,loaders/product/buyTogether,loaders/search/productListPageCollection,loaders/search/intelligenseSearch,loaders/Layouts/ProductCard`,
      build:
        "npm run generate:blocks && npm run generate:sections && npm run generate:loaders && npm run generate:schema && npm run generate:invoke && tsr generate && vite build",
      preview: "vite preview",
      deploy: "npm run build && wrangler deploy",
      types: "wrangler types",
      typecheck: "tsc --noEmit",
      format: 'prettier --write "src/**/*.{ts,tsx}"',
      "format:check": 'prettier --check "src/**/*.{ts,tsx}"',
      knip: "knip",
      clean:
        "rm -rf node_modules .cache dist .wrangler/state node_modules/.vite && npm install",
      "tailwind:lint":
        "tsx scripts/tailwind-lint.ts",
      "tailwind:fix":
        "tsx scripts/tailwind-lint.ts --fix",
    },
    author: "deco.cx",
    license: "MIT",
    dependencies: {
      "@decocms/apps": `^${appsVersion}`,
      "@decocms/start": `^${startVersion}`,
      "@tanstack/react-query": "5.90.21",
      "@tanstack/react-router": "1.166.7",
      "@tanstack/react-start": "1.166.8",
      "@tanstack/react-store": "0.9.2",
      "@tanstack/store": "0.9.2",
      "colorjs.io": "^0.6.1",
      react: "^19.2.4",
      "react-dom": "^19.2.4",
      ...siteDeps,
    },
    devDependencies: {
      "@cloudflare/vite-plugin": "^1.27.0",
      "@tailwindcss/vite": "^4.2.1",
      "@tanstack/router-cli": "1.166.7",
      "@types/react": "^19.2.14",
      "@types/react-dom": "^19.2.3",
      "@vitejs/plugin-react": "^5.1.4",
      "babel-plugin-react-compiler": "^1.0.0",
      "daisyui": "^5.5.19",
      knip: "^5.61.2",
      prettier: "^3.5.3",
      tailwindcss: "^4.2.1",
      "ts-morph": "^27.0.2",
      tsx: "^4.19.4",
      typescript: "^5.9.3",
      vite: "^7.3.1",
      wrangler: "^4.72.0",
    },
  };

  return JSON.stringify(pkg, null, 2) + "\n";
}
