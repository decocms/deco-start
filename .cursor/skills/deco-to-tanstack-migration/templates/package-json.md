# package.json Template

Current as of `@decocms/start@1.6.2` and `@decocms/apps@1.4.1+`.

```json
{
  "name": "my-tanstack-store",
  "version": "0.1.0",
  "type": "module",
  "description": "storefront powered by TanStack Start",
  "scripts": {
    "dev": "vite dev",
    "dev:clean": "rm -rf node_modules/.vite .wrangler/state .tanstack && vite dev",
    "generate:blocks":   "tsx node_modules/@decocms/start/scripts/generate-blocks.ts",
    "generate:routes":   "tsr generate",
    "generate:schema":   "tsx node_modules/@decocms/start/scripts/generate-schema.ts --site <SITE>",
    "generate:invoke":   "tsx node_modules/@decocms/start/scripts/generate-invoke.ts",
    "generate:sections": "tsx node_modules/@decocms/start/scripts/generate-sections.ts",
    "generate:loaders":  "tsx node_modules/@decocms/start/scripts/generate-loaders.ts --exclude shopify/loaders,shopify/actions",
    "build": "npm run generate:blocks && npm run generate:schema && npm run generate:sections && npm run generate:loaders && tsr generate && vite build",
    "preview": "vite preview",
    "deploy": "npm run build && wrangler deploy",
    "types": "wrangler types",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write \"src/**/*.{ts,tsx}\"",
    "format:check": "prettier --check \"src/**/*.{ts,tsx}\"",
    "knip": "knip",
    "tailwind:lint": "tsx scripts/tailwind-lint.ts",
    "tailwind:fix": "tsx scripts/tailwind-lint.ts --fix"
  },
  "dependencies": {
    "@decocms/apps": "^1.4.1",
    "@decocms/start": "^1.6.2",
    "@tanstack/react-query": "5.90.21",
    "@tanstack/react-router": "1.166.7",
    "@tanstack/react-start": "1.166.8",
    "@tanstack/react-store": "0.9.2",
    "@tanstack/store": "0.9.2",
    "react": "^19.2.4",
    "react-dom": "^19.2.4"
  },
  "devDependencies": {
    "@cloudflare/vite-plugin": "^1.27.0",
    "@tailwindcss/vite": "^4.2.1",
    "@tanstack/router-cli": "1.166.7",
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^5.1.4",
    "babel-plugin-react-compiler": "^1.0.0",
    "daisyui": "^5.5.19",
    "knip": "^5.61.2",
    "prettier": "^3.5.3",
    "tailwindcss": "^4.2.1",
    "ts-morph": "^27.0.2",
    "tsx": "^4.19.4",
    "typescript": "^5.9.3",
    "vite": "^7.3.1",
    "wrangler": "^4.72.0"
  }
}
```

## Notes

- **Minimum `@decocms/start` version is `1.6.2`** — earlier versions have a bug where deferred sections (`Lazy`-wrapped) lose `routeParams`, causing PDP loaders with `:slug` to return null. See gotcha #47.
- **`generate` scripts** run as part of `build`. In dev, Vite HMR picks up changes without re-running them — you only need to re-run `generate:blocks` / `generate:sections` after editing `.deco/blocks/` or a section's metadata exports.
- **`generate:loaders --exclude shopify/loaders,shopify/actions`** — the Shopify app ships its own loaders/actions, registered by `autoconfigApps`. Exclude to avoid double-registering site-local invoke entries for them.
- **`tsr generate`** produces `src/routeTree.gen.ts` from file-based routes.
- **GitHub Packages**: add an `.npmrc` in the repo root (git-ignore is optional):
  ```
  @decocms:registry=https://npm.pkg.github.com
  //npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
  ```
  Then set `NODE_AUTH_TOKEN` in `.env` for local installs and as a CI secret. Alternatively, pin by Git tag via `github:` URL syntax — see gotcha #45.
- **React Compiler** is enabled via `babel-plugin-react-compiler` in `vite.config.ts`. Most sections benefit without annotation.
