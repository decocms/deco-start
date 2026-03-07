# @preact/signals -> TanStack Store Migration

Two distinct patterns need different handling.

## Pattern A: Component Hooks (useSignal, useComputed)

These are component-local state. Replace with React hooks directly.

### useSignal -> useState

```typescript
// OLD
import { useSignal } from "@preact/signals";
const loading = useSignal(false);
loading.value = true;          // write
if (loading.value) { ... }     // read

// NEW
import { useState } from "react";
const [loading, setLoading] = useState(false);
setLoading(true);              // write
if (loading) { ... }           // read
```

Setter naming convention: `set` + capitalized variable name.

### useComputed -> useMemo

```typescript
// OLD
import { useComputed } from "@preact/signals";
const isValid = useComputed(() => name.value.length > 0);
return <div>{isValid.value}</div>;

// NEW
import { useMemo } from "react";
const isValid = useMemo(() => name.length > 0, [name]);
return <div>{isValid}</div>;
```

### Automation Tips

- `useSignal`/`useComputed` changes are NOT safe for bulk sed (variable names, setter names, `.value` removal all differ per file)
- Process each file individually: read, identify variable names, transform
- Watch for: toggle patterns (`x.value = !x.value` -> `setX(prev => !prev)`), object state, conditional assignments

## Pattern B: Module-Level Signals (Global State)

These create shared state across components. Use `@tanstack/store`.

### Create ~/sdk/signal.ts

```typescript
import { Store } from "@tanstack/store";

export interface ReactiveSignal<T> {
  readonly store: Store<T>;
  value: T;
  peek(): T;
  subscribe(fn: () => void): () => void;
}

export function signal<T>(initialValue: T): ReactiveSignal<T> {
  const store = new Store<T>(initialValue);
  return {
    store,
    get value() { return store.state; },
    set value(v: T) { store.setState(() => v); },
    peek() { return store.state; },
    subscribe(fn) { return store.subscribe(() => fn()); },
  };
}
```

### Replace Imports

```bash
# Safe for bulk sed
sed -i '' 's|from "@preact/signals"|from "~/sdk/signal"|g'
```

### React Subscriptions

Replace manual useEffect+subscribe boilerplate with `useStore`:

```typescript
// OLD (manual subscription)
const { displayCart } = useUI();
const [open, setOpen] = useState(false);
useEffect(() => {
  setOpen(displayCart.value);
  return displayCart.subscribe(() => setOpen(displayCart.value));
}, []);

// NEW (useStore from @tanstack/react-store)
import { useStore } from "@tanstack/react-store";
const { displayCart } = useUI();
const open = useStore(displayCart.store);
```

Write-only consumers (event handlers) don't need `useStore`:
```typescript
// This still works -- .value setter backed by TanStack Store
onClick={() => { displayCart.value = true; }}
```

## Signal Type References

If components use `Signal<T>` as a prop type:

```typescript
// OLD
import { Signal } from "@preact/signals";
interface Props { quantity: Signal<number>; }

// NEW
import type { ReactiveSignal } from "~/sdk/signal";
interface Props { quantity: ReactiveSignal<number>; }
```

## Verification

```bash
grep -r '@preact/signals' src/ --include='*.ts' --include='*.tsx'
# Should return ZERO matches
```
