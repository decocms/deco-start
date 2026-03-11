# The generate-invoke.ts Script

## Location

`@decocms/start/scripts/generate-invoke.ts`

## What It Does

1. Finds `@decocms/apps/vtex/invoke.ts` (checks `node_modules/@decocms/apps` and `../apps-start`)
2. Parses it with `ts-morph` to extract action definitions
3. For each action, extracts: name, import source, imported function, input type, return type, unwrap flag, call body
4. Generates `src/server/invoke.gen.ts` with:
   - Top-level `createServerFn().handler()` declarations (one per action)
   - An `invoke` object that re-exports them with proper types

## Usage

```bash
# From site root
npx tsx node_modules/@decocms/start/scripts/generate-invoke.ts

# With custom output
npx tsx node_modules/@decocms/start/scripts/generate-invoke.ts --out-file src/invoke.gen.ts

# With custom apps location
npx tsx node_modules/@decocms/start/scripts/generate-invoke.ts --apps-dir ../my-apps
```

## CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `--out-file` | `src/server/invoke.gen.ts` | Output file path |
| `--apps-dir` | Auto-detected | Path to `@decocms/apps` root |

## How It Parses invoke.ts

The script navigates the AST:

```
invoke (VariableDeclaration)
  └── { vtex: { actions: { ... } } } as const  (AsExpression → ObjectLiteral)
        └── vtex (PropertyAssignment)
              └── actions (PropertyAssignment)
                    └── getOrCreateCart: createInvokeFn(...) as (...)
                    └── addItemsToCart: createInvokeFn(...) as (...)
                    └── ...
```

For each property in `actions`:
1. Strips the `as Type` assertion to get the `createInvokeFn(...)` call
2. Extracts the arrow function parameter type → `inputType`
3. Extracts the arrow function body → `callBody`
4. Checks for `{ unwrap: true }` in the second argument
5. Resolves which imported function is called (matches against import map)
6. Extracts the return type from the `as` assertion

## Generated Output Structure

```typescript
// invoke.gen.ts

import { createServerFn } from "@tanstack/react-start";
import { addItemsToCart, ... } from "@decocms/apps/vtex/actions/checkout";
import type { OrderForm } from "@decocms/apps/vtex/types";

function unwrapResult<T>(result: unknown): T { ... }

// Top-level — compiler can transform these
const $addItemsToCart = createServerFn({ method: "POST" })
  .handler(async (ctx: { data: { orderFormId: string; ... } }) => {
    const result = await addItemsToCart(ctx.data.orderFormId, ctx.data.orderItems);
    return unwrapResult(result);  // strips VtexFetchResult wrapper
  });

// Re-export with types
export const invoke = {
  vtex: {
    actions: {
      addItemsToCart: $addItemsToCart as (...) => Promise<OrderForm>,
    },
  },
} as const;
```

## Adding New Actions

1. Add the pure function to `@decocms/apps/vtex/actions/{module}.ts`
2. Add it to `@decocms/apps/vtex/invoke.ts` using `createInvokeFn`
3. Re-run `npm run generate:invoke` in the site
4. The new action is automatically available in `invoke.vtex.actions.*`

## unwrapResult

VTEX checkout functions return `VtexFetchResult<T>` which wraps `{ data: T, setCookies: string[] }`. The `unwrap: true` flag causes the generated handler to extract `.data` before returning to the client:

```typescript
// Without unwrap:
const result = await simulateCart(items, postalCode);
return result;  // returns raw simulation response

// With unwrap:
const result = await getOrCreateCart(orderFormId);
return unwrapResult(result);  // returns OrderForm, not { data: OrderForm, setCookies }
```

## Integration with Build Pipeline

The script fits into the existing build pipeline alongside other generators:

```json
{
  "scripts": {
    "generate:blocks": "tsx .../generate-blocks.ts",
    "generate:invoke": "tsx .../generate-invoke.ts",
    "generate:schema": "tsx .../generate-schema.ts",
    "build": "generate:blocks && generate:invoke && generate:schema && tsr generate && vite build"
  }
}
```

Order matters: `generate:invoke` should run before `generate:schema` (schema needs to see all imports), but after `generate:blocks` (blocks don't depend on invoke).
