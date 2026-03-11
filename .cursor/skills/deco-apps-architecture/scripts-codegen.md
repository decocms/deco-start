# Scripts & Codegen Reference

## `scripts/start.ts`

Main codegen script, runs via `deno task start`. Performs three steps in sequence:

### 1. OpenAPI Type Generation

Walks the entire repo looking for `*.openapi.json` files, then:

1. Parses the OpenAPI 3.x spec
2. Extracts every endpoint: `VERB /path` → typed interface with `response`, `body`, `searchParams`
3. Converts URL path params: `/{userId}` → `/:userId`
4. Handles nullable types (OpenAPI `nullable: true` → TypeScript union with `null`)
5. Compiles via `json-schema-to-typescript`
6. Outputs `*.openapi.gen.ts` next to the JSON spec
7. Formats with `deno fmt` and lints with `deno lint`

**Location pattern:** `{app}/utils/openapi/{name}.openapi.json` → `{app}/utils/openapi/{name}.openapi.gen.ts`

**Usage:** The generated types are consumed by `createHttpClient<GeneratedType>()`.

### 2. GraphQL Type Generation

Walks the repo for `*.graphql.json` files (GraphQL SDL schemas), then:

1. Uses `@graphql-codegen/cli` with plugins:
   - `typescript` — base types from schema
   - `typescript-operations` — types from query documents (`.ts` files with `gql` tags)
2. Outputs `*.graphql.gen.ts` in the same directory
3. Scans all `**/*.ts` files for query/mutation documents

**Location pattern:** `{app}/utils/storefront/{name}.graphql.json` → `{app}/utils/storefront/{name}.graphql.gen.ts`

### 3. Deco Bundle

Calls `@deco/deco/scripts/bundle` which:
- Scans all apps listed in `deco.ts`
- Generates `manifest.gen.ts` for each app
- Registers actions, loaders, handlers, sections, workflows

## `scripts/new.ts`

Interactive project scaffolder, runs via `deno task new`:

1. Prompts for type: `APP` or `MCP`
2. Lists available templates per type
3. Prompts for project name (validated as kebab-case)
4. Clones the template repository:
   - APP → `https://github.com/deco-cx/app-template`
   - MCP → `https://github.com/deco-cx/mcp-oauth-template`
5. Updates `deco.ts` to register the new app: `app("{name}")`
6. Removes template `.git` directory
7. Removes template `deno.json` (uses root config)
8. Runs `deno task start` to generate manifests

## `deno.json` Tasks

```json
{
  "tasks": {
    "check": "deno fmt --check && deno lint && deno check **/mod.ts",
    "start": "deno run -A ./scripts/start.ts",
    "bundle": "deno run -A jsr:@deco/deco/scripts/bundle",
    "new": "deno run -A ./scripts/new.ts",
    "release": "deno eval 'import \"deco/scripts/release.ts\"'",
    "link": "deno eval 'import \"deco/scripts/apps/link.ts\"'",
    "unlink": "deno eval 'import \"deco/scripts/apps/unlink.ts\"'",
    "serve": "deno eval 'import \"deco/scripts/apps/serve.ts\"'",
    "watcher": "deno eval 'import \"deco/scripts/apps/watcher.ts\"'",
    "update": "deno eval 'import \"deco/scripts/update.ts\"'",
    "reload": "deno cache -r https://deco.cx/run"
  }
}
```

| Task | Purpose |
|------|---------|
| `start` | Full codegen (OpenAPI + GraphQL + manifest) |
| `check` | CI quality gate (format + lint + type-check) |
| `bundle` | Only manifest generation (skip OpenAPI/GraphQL) |
| `new` | Scaffold new app from template |
| `release` | Publish new version |
| `link`/`unlink` | Link local apps for development |
| `serve` | Start local development server |
| `watcher` | File watcher for auto-rebuild |
| `update` | Update Deco dependencies |
| `reload` | Cache bust |

## CI/CD (`.github/workflows/`)

### `ci.yaml` (Push/PR)
1. `deno task start` — full build
2. `deno task check` — format + lint + type-check
3. `deno test` (continue-on-error)
4. `deno bench` (continue-on-error)

### `release.yaml` (Tag push)
Publishes release on tag creation.

### `releaser.yaml` (PR/Comments)
- On PR: adds comment with version bump options (patch/minor/major)
- On comment reaction: updates version in `deno.json`, creates git tag

## `deco.ts` — App Registry

Central configuration listing all apps:

```typescript
const app = (name: string) => ({ dir: name, name });

const compatibilityApps = [
  { dir: "./compat/$live", name: "$live" },
  { dir: "./compat/std", name: "deco-sites/std" },
];

const config = {
  apps: [
    app("vtex"),
    app("shopify"),
    app("website"),
    app("commerce"),
    // ... ~90 apps total
    ...compatibilityApps,
  ],
};

export default config;
```

The `name` must match the directory name. Order matters for dependency resolution.

## Adding OpenAPI Types to an App

1. Place your OpenAPI 3.x spec at `{app}/utils/openapi/{name}.openapi.json`
2. Run `deno task start`
3. Import the generated types:
   ```typescript
   import { OpenAPI } from "./utils/openapi/{name}.openapi.gen.ts";
   const client = createHttpClient<OpenAPI>({ base: "https://api.example.com" });
   ```

## Adding GraphQL Types to an App

1. Place your GraphQL SDL at `{app}/utils/{name}.graphql.json`
2. Write queries in `.ts` files using the `gql` tag
3. Run `deno task start`
4. Import generated types from `{name}.graphql.gen.ts`
