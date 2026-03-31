
# Deco Islands Migration — From Fresh Islands to React Components

## Why Islands Don't Make Sense in TanStack Start

In **Fresh/Preact**, islands were a core architecture concept: the server rendered static HTML and only specific `islands/` components shipped JavaScript to the browser for hydration. Everything outside `islands/` was server-only.

In **TanStack Start/React**, there is no islands boundary. React performs **full hydration** of the entire component tree. Every component — whether it lives in `src/components/` or `src/islands/` — is sent to the client and hydrated. The `src/islands/` directory is a **dead artifact** that:

1. **Adds a useless indirection layer** — each island is typically a 3-line wrapper that re-exports a component
2. **Confuses the mental model** — developers think islands have special client-side powers
3. **Doubles the module graph** — Vite must resolve and bundle both the island wrapper AND the real component
4. **Hides the real component path** — makes searching, refactoring, and debugging harder
5. **Breaks tree-shaking assumptions** — bundler can't optimize through the extra re-export layer

## What an Island Wrapper Looks Like

```typescript
// src/islands/AddToCartButton/vtex.tsx  (TYPICAL WRAPPER — DELETE THIS)
import Component from "~/components/product/AddToCartButton/vtex.tsx";
import type { Props } from "~/components/product/AddToCartButton/vtex.tsx";

function Island(props: Props) {
  return <Component {...props} />;
}
export default Island;
```

This does literally nothing. The `<Component {...props} />` call is a pass-through.

## What a Standalone Island Looks Like

Some islands are NOT wrappers — they contain real logic and have no equivalent in `src/components/`:

```typescript
// src/islands/ForgeViewer/ForgeViewer.tsx  (STANDALONE — MUST BE MOVED)
import { useEffect } from "react";

export default function ForgeViewerIsland({ urn }) {
  useEffect(() => {
    // Real Autodesk Forge 3D viewer initialization
    getAccessToken().then(({ token }) => {
      Autodesk.Viewing.Initializer(options, () => { /* ... */ });
    });
  }, []);
  return <div id="forgeViewer" />;
}
```

These must be **moved** to `src/components/`, not just repointed.

## Migration Strategy

### Phase 1 — Discover and Classify

```bash
# List all island files
find src/islands -name '*.tsx' -o -name '*.ts' | sort

# Find all imports referencing islands/
rg 'from ["'"'"'].*islands/' src/ --glob '*.{tsx,ts}' -l

# Classify each island:
# For each file in src/islands/X.tsx, check if it's a wrapper or standalone:
rg 'import.*from.*components' src/islands/X.tsx
# If it imports from components/ and re-exports → WRAPPER (repoint)
# If it has real logic → STANDALONE (move to components/)
```

### Phase 2 — Repoint Wrappers

For each wrapper island, find every file that imports it and change the import to point directly at the real component.

**Pattern:**
```
~/islands/SliderJS.tsx           → ~/components/ui/SliderJS.tsx
~/islands/AddToCartButton/vtex   → ~/components/product/AddToCartButton/vtex.tsx
~/islands/WishlistButton/vtex    → ~/components/wishlist/WishlistButton/vtex.tsx
~/islands/Header/CartDrawer      → ~/components/header/Drawers.tsx (named export)
~/islands/Newsletter             → ~/components/footer/Newsletter.tsx
```

**How to find the target:**
1. Read the island file
2. Look at its `import Component from "~/components/..."` line
3. That's your target path

**How to find consumers:**
```bash
rg 'from ["'"'"'].*islands/SliderJS' src/ --glob '*.{tsx,ts}'
```

**Apply with StrReplace** on each consumer file.

### Phase 3 — Move Standalone Islands

For islands with real logic:

1. Create the target directory: `mkdir -p src/components/ForgeViewer/`
2. Copy the file: `cp src/islands/ForgeViewer/ForgeViewer.tsx src/components/ForgeViewer/ForgeViewer.tsx`
3. Update all imports that referenced the old path
4. Verify no references remain

### Phase 4 — Delete src/islands/

```bash
# Final verification — MUST return zero results
rg 'from ["'"'"'].*islands/' src/ --glob '*.{tsx,ts}'

# Delete
rm -rf src/islands/
```

## Common Problems Islands Cause (and Fixes)

### 1. Vanilla JS DOM Manipulation Conflicts with React

Many island components were written for Fresh where they needed vanilla JS to add interactivity. In React, this creates **hydration mismatches** and **broken event handlers**.

**Problem: `document.querySelector` to control UI state**
```typescript
// BAD — bypasses React's state management
const cartCheckbox = document.querySelector('.drawer-end .drawer-toggle') as HTMLInputElement;
if (cartCheckbox) cartCheckbox.checked = true;
```

**Fix: Use React state/signals**
```typescript
// GOOD — let React manage the DOM
const { displayCart } = useUI();
displayCart.value = true;
```

### 2. `addEventListener` Without `window.` Prefix

In Fresh/Deno, bare `addEventListener` works at module scope. In React components rendered via SSR, it can fail or attach to the wrong scope.

**Problem:**
```typescript
addEventListener("keydown", handler);    // ambiguous scope
removeEventListener("keydown", handler); // might not match
```

**Fix:**
```typescript
window.addEventListener("keydown", handler);
// cleanup in useEffect return:
return () => window.removeEventListener("keydown", handler);
```

### 3. `removeEventListener` With New Function References

**Problem: Memory leak — listener never removed**
```typescript
// BAD — anonymous function creates new reference each time
dots?.item(i).addEventListener("click", () => goToItem(i));
// Later...
dots?.item(i).removeEventListener("click", () => goToItem(i)); // DIFFERENT function!
```

**Fix: Store handler references**
```typescript
const dotHandlers: Array<() => void> = [];
for (let i = 0; i < (dots?.length ?? 0); i++) {
  const handler = () => goToItem(i);
  dotHandlers.push(handler);
  dots?.item(i).addEventListener("click", handler);
}

// Cleanup
return () => {
  for (let i = 0; i < dotHandlers.length; i++) {
    dots?.item(i).removeEventListener("click", dotHandlers[i]);
  }
};
```

### 4. Inline Scripts Without Cleanup

Components using `useScriptAsDataURI` or `dangerouslySetInnerHTML` to inject scripts won't have React lifecycle cleanup. For analytics/tracking this is acceptable (fire-and-forget). For interactive UI, convert to React hooks:

**Before (inline script):**
```typescript
<script dangerouslySetInnerHTML={{
  __html: `document.getElementById('${id}').addEventListener('click', ...)`
}} />
```

**After (React hook):**
```typescript
useEffect(() => {
  const el = document.getElementById(id);
  const handler = () => { /* ... */ };
  el?.addEventListener('click', handler);
  return () => el?.removeEventListener('click', handler);
}, [id]);
```

### 5. SVG Attributes Not Camel-Cased

Fresh/Preact accepted HTML-style SVG attributes. React requires camelCase:

| Fresh/Preact | React |
|-------------|-------|
| `stroke-linecap` | `strokeLinecap` |
| `stroke-linejoin` | `strokeLinejoin` |
| `stroke-width` | `strokeWidth` |
| `fill-rule` | `fillRule` |
| `clip-path` | `clipPath` |

### 6. `class` vs `className`

Preact accepts both `class` and `className`. React only accepts `className`. Some components accept a `class` prop — rename to `className` or support both:

```typescript
interface Props {
  class?: string;
  className?: string;
}
function Drawer({ class: classProp = "", className = "" }: Props) {
  const cls = classProp || className;
  return <div className={cls}>...</div>;
}
```

## Checklist for Complete Removal

- [ ] Zero results from `rg 'from.*islands/' src/ --glob '*.{tsx,ts}'`
- [ ] `src/islands/` directory deleted
- [ ] All `addEventListener` calls use explicit `window.` prefix
- [ ] All `removeEventListener` calls use stored function references
- [ ] No `document.querySelector` for state that React should manage
- [ ] SVG attributes are camelCased
- [ ] No `class` prop on native DOM elements (use `className`)
- [ ] Build succeeds (`npm run build` / `bun run build`)
- [ ] Dev server starts without errors
- [ ] Interactive elements work: add to cart, sliders, drawers, modals
