# Code Quality

Current state and recommendations for code quality tooling in `@decocms/start`.

## Current State

| Tool | Status |
|------|--------|
| TypeScript | Present (`tsc --noEmit` via `typecheck`) |
| `strictNullChecks` | Enabled |
| `strict` mode | NOT enabled (only `strictNullChecks`) |
| ESLint | ABSENT |
| Prettier | ABSENT |
| Knip | ABSENT |
| Vitest/Jest | ABSENT |
| Husky/lint-staged | ABSENT |
| Biome | ABSENT |

## Current Scripts

```json
{
  "build": "tsc",
  "typecheck": "tsc --noEmit"
}
```

## CI/CD

Only `release.yml` exists - runs `npm install` then `npx semantic-release`. No build, typecheck, lint, or test step before release.

## Recommendations

### 1. TypeScript Strict Mode

Enable full strict mode in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "strict": true
  }
}
```

This enables: `strictNullChecks` (already on), `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitAny`, `noImplicitThis`, `alwaysStrict`, `useUnknownInCatchVariables`.

### 2. Knip (Dead Code Detection)

```json
// knip.json
{
  "entry": ["src/index.ts", "scripts/*.ts"],
  "project": ["src/**/*.{ts,tsx}", "scripts/**/*.ts"],
  "ignoreBinaries": ["semantic-release"]
}
```

Script: `"lint:unused": "knip"`

### 3. Biome (Lint + Format)

Biome is faster than ESLint + Prettier combined and works well for pure TypeScript projects:

```json
// biome.json
{
  "$schema": "https://biomejs.dev/schemas/2.0/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noUnusedVariables": "warn",
        "noUnusedImports": "warn"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2
  },
  "files": {
    "include": ["src/**", "scripts/**"]
  }
}
```

Scripts:
```json
{
  "lint": "biome check src/ scripts/",
  "lint:fix": "biome check --write src/ scripts/",
  "format": "biome format src/ scripts/",
  "format:fix": "biome format --write src/ scripts/"
}
```

### 4. CI Pipeline

Add build + quality checks before release:

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run lint:unused
```

Update `release.yml` to run checks before release:

```yaml
- run: npm install
- run: npm run typecheck
- run: npm run lint
- run: npm run lint:unused
- name: Release
  run: npx semantic-release
```

### 5. Recommended package.json Scripts

```json
{
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/ scripts/",
    "lint:fix": "biome check --write src/ scripts/",
    "lint:unused": "knip",
    "format": "biome format --check src/ scripts/",
    "format:fix": "biome format --write src/ scripts/",
    "check": "npm run typecheck && npm run lint && npm run lint:unused && npm run format"
  }
}
```

### 6. Priority Order

1. **Knip** (immediate) - find and remove dead code
2. **Biome** (immediate) - consistent lint + format
3. **CI pipeline** (immediate) - prevent regressions
4. **TypeScript strict** (next) - may require fixes
5. **Vitest** (later) - when test coverage becomes a priority
