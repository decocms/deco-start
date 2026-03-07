# Deco Framework Import Elimination

Replace all `@deco/deco/*` and `$fresh/*` imports with inline equivalents. No shim files needed.

## $fresh/runtime.ts

### asset(url)

The `asset()` function in Fresh prepends the build hash path. In Vite, static assets are handled automatically. Just remove the wrapper:

```typescript
// OLD
import { asset } from "$fresh/runtime.ts";
<img src={asset("/sprites.svg")} />

// NEW
<img src="/sprites.svg" />
```

### IS_BROWSER

```typescript
// OLD
import { IS_BROWSER } from "$fresh/runtime.ts";

// NEW (inline)
const IS_BROWSER = typeof document !== "undefined";
```

## @deco/deco (bare import)

### SectionProps

```typescript
// OLD
import type { SectionProps } from "@deco/deco";
type Props = SectionProps<typeof loader>;

// NEW (inline type)
type SectionProps<T extends (...args: any[]) => any> = ReturnType<T>;
```

### Resolved

```typescript
// OLD
import type { Resolved } from "@deco/deco";

// NEW
type Resolved<T = any> = T;
```

### context

```typescript
// OLD
import { context } from "@deco/deco";
if (context.isDeploy) { ... }

// NEW
const context = { isDeploy: false, platform: "tanstack-start", site: "my-store", siteId: 0 };
```

## @deco/deco/blocks

### Section, Block

```typescript
// OLD
import type { Section } from "@deco/deco/blocks";

// NEW
type Section = any;
type Block = any;
```

These were used for Deco CMS section composition. In TanStack Start, sections are just React components.

## @deco/deco/hooks

### useScript / useScriptAsDataURI

These serialize a function into an inline `<script>` string. Create `~/sdk/useScript.ts`:

```typescript
export function useScript(fn: (...args: any[]) => void, ...args: any[]): string {
  const serializedArgs = args.map((a) => JSON.stringify(a)).join(",");
  return `(${fn.toString()})(${serializedArgs})`;
}

export function useScriptAsDataURI(fn: (...args: any[]) => void, ...args: any[]): string {
  const code = useScript(fn, ...args);
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
}
```

### usePartialSection

Deco partial sections don't apply in TanStack Start. Stub:

```typescript
export function usePartialSection(props?: Record<string, unknown>) {
  return props || {};
}
```

## @deco/deco/o11y

```typescript
// OLD
import { logger } from "@deco/deco/o11y";
logger.error("failed", err);

// NEW
console.error("failed", err);
```

## Automation

All of these are safe for bulk sed (each import pattern maps to exactly one replacement).

## Verification

```bash
grep -r '@deco/deco' src/ --include='*.ts' --include='*.tsx'
grep -r '\$fresh/' src/ --include='*.ts' --include='*.tsx'
# Both should return ZERO matches
```
