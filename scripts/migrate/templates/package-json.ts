import type { MigrationContext } from "../types.ts";

export function generatePackageJson(ctx: MigrationContext): string {
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
    },
    author: "deco.cx",
    license: "MIT",
    dependencies: {
      "@decocms/apps": "^0.25.2",
      "@decocms/start": "^0.31.1",
      "@tanstack/react-query": "5.90.21",
      "@tanstack/react-router": "1.166.7",
      "@tanstack/react-start": "1.166.8",
      "@tanstack/react-store": "0.9.2",
      "@tanstack/store": "0.9.2",
      "colorjs.io": "^0.6.1",
      react: "^19.2.4",
      "react-dom": "^19.2.4",
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
      tsx: "^4.19.4",
      typescript: "^5.9.3",
      vite: "^7.3.1",
      wrangler: "^4.72.0",
    },
  };

  return JSON.stringify(pkg, null, 2) + "\n";
}
