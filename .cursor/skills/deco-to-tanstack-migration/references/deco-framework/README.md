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

## Deferred Sections and CLS Prevention

When a CMS page wraps a section in `website/sections/Rendering/Lazy.tsx`, it becomes a `DeferredSection`. The `DeferredSectionWrapper` renders a skeleton via `getSectionOptions(key).loadingFallback`.

**Problem**: `getSectionOptions` returns `undefined` if the section module hasn't loaded yet. The module is loaded async in a `useEffect` (`preloadSectionModule`), so on first paint `skeleton = null` — the space is blank and the footer jumps down as sections load (CLS).

**Fix**: Use `registerSection` with `loadingFallback` pre-populated in `setup.ts` instead of including the section in the bulk `registerSections` call:

```typescript
import { registerSection, registerSections } from "@decocms/start/cms";
import PDPSkeleton from "./components/product/PDPSkeleton";

registerSections({
  // ... all other sections (NOT the lazy-wrapped one)
});

// Pre-populate sectionOptions synchronously so DeferredSectionWrapper
// has loadingFallback on the very first render — no null flash.
registerSection(
  "site/sections/Product/NotFoundChallenge.tsx",
  () => import("./sections/Product/NotFoundChallenge") as any,
  { loadingFallback: PDPSkeleton },
);
```

**Why `as any`**: `registerSection` expects `Promise<SectionModule>` but the actual module export is wider (includes `LoadingFallback`, `loader`, etc.). The cast is safe.

**Composite skeleton**: Create a `PDPSkeleton` that combines all `LoadingFallback` exports from the section's sub-components:

```tsx
// src/components/product/PDPSkeleton.tsx
import { LoadingFallback as MountedPDPSkeleton } from "~/components/product/MountedPDP";
import { LoadingFallback as ProductDescriptionSkeleton } from "~/components/product/MountedPDP/ProductDescription";
import { LoadingFallback as ProductFAQSkeleton } from "~/components/product/MountedPDP/ProductFAQ";

export default function PDPSkeleton() {
  return (
    <div>
      <MountedPDPSkeleton />
      <ProductDescriptionSkeleton />
      <ProductFAQSkeleton />
    </div>
  );
}
```
