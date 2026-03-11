# package.json Template

```json
{
  "name": "my-tanstack-store",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "npm run generate && vite dev",
    "build": "npm run generate && vite build",
    "generate": "npm run generate:blocks && npm run generate:invoke && npm run generate:schema",
    "generate:blocks": "tsx node_modules/@decocms/start/scripts/generate-blocks.ts",
    "generate:invoke": "tsx node_modules/@decocms/start/scripts/generate-invoke.ts",
    "generate:schema": "tsx node_modules/@decocms/start/scripts/generate-schema.ts --site storefront",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@decocms/apps": "^0.20.1",
    "@decocms/start": "^0.16.4",
    "@tanstack/react-query": "^5.90.21",
    "@tanstack/react-router": "^1.166.2",
    "@tanstack/react-router-devtools": "^1.166.2",
    "@tanstack/react-start": "^1.166.2",
    "@tanstack/react-store": "^0.9.1",
    "react": "^19.2.4",
    "react-dom": "^19.2.4"
  },
  "devDependencies": {
    "@cloudflare/vite-plugin": "^1.26.1",
    "@tailwindcss/vite": "^4.2.1",
    "@tanstack/router-generator": "^1.166.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "babel-plugin-react-compiler": "^1.0.0",
    "daisyui": "^5.5.19",
    "tailwindcss": "^4.2.1",
    "tsx": "^4.19.2",
    "typescript": "^5.9.3",
    "vite": "^7.3.1",
    "wrangler": "^4.14.1",
    "@vitejs/plugin-react": "^4.5.2"
  }
}
```

## Notes

- `@decocms/start` and `@decocms/apps` come from GitHub Packages — needs `.npmrc`:
  ```
  @decocms:registry=https://npm.pkg.github.com
  //npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
  ```
- Set `NODE_AUTH_TOKEN` in `.env` (add `.env` to `.gitignore`)
- `generate` scripts run before dev and build to produce `blocks.gen.ts`, `invoke.gen.ts`, `meta.gen.json`
- `tsx` is needed for the generate scripts (TypeScript execution)
