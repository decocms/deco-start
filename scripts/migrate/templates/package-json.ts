import type { MigrationContext } from "../types.ts";

/**
 * Extract npm dependencies from deno.json import map.
 * Entries like `"fuse.js": "npm:fuse.js@7.0.0"` become `"fuse.js": "^7.0.0"`.
 */
function extractNpmDeps(importMap: Record<string, string>): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const [key, value] of Object.entries(importMap)) {
    if (!value.startsWith("npm:")) continue;
    // Skip preact, deco, and other framework deps we handle ourselves
    if (key.startsWith("preact") || key.startsWith("@preact/")) continue;
    if (key.startsWith("@deco/")) continue;
    if (key === "daisyui") continue; // we pin our own version

    const raw = value.slice(4); // remove "npm:"
    const atIdx = raw.lastIndexOf("@");
    if (atIdx <= 0) {
      deps[raw] = "*";
    } else {
      const name = raw.slice(0, atIdx);
      const version = raw.slice(atIdx + 1);
      deps[name] = `^${version}`;
    }
  }
  return deps;
}

export function generatePackageJson(ctx: MigrationContext): string {
  const siteDeps = {
    ...extractNpmDeps(ctx.importMap),
    ...ctx.discoveredNpmDeps,
  };

  const pkg = {
    name: ctx.siteName,
    version: "0.1.0",
    type: "module",
    description: `${ctx.siteName} storefront powered by TanStack Start`,
    scripts: {
      dev: "vite dev",
      "generate:blocks":
        "tsx node_modules/@decocms/start/scripts/generate-blocks.ts",
      "generate:routes": "tsr generate",
      "generate:schema": `tsx node_modules/@decocms/start/scripts/generate-schema.ts --site ${ctx.siteName}`,
      build:
        "npm run generate:blocks && npm run generate:schema && tsr generate && vite build",
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
        "tsx node_modules/@decocms/start/scripts/tailwind-lint.ts",
      "tailwind:fix":
        "tsx node_modules/@decocms/start/scripts/tailwind-lint.ts --fix",
    },
    author: "deco.cx",
    license: "MIT",
    dependencies: {
      "@decocms/apps": "^0.25.2",
      "@decocms/start": "^0.32.0",
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
