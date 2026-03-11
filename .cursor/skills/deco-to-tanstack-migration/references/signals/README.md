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
import { useSyncExternalStore, useMemo } from "react";

export interface Signal<T> {
  readonly store: Store<T>;
  value: T;
  peek(): T;
  subscribe(fn: () => void): () => void;
}

export function signal<T>(initialValue: T): Signal<T> {
  const store = new Store<T>(initialValue);
  return {
    store,
    get value() { return store.state; },
    set value(v: T) { store.setState(() => v); },
    peek() { return store.state; },
    subscribe(fn) {
      // CRITICAL: @tanstack/store@0.9.x returns { unsubscribe: Function },
      // NOT a plain function. React's useSyncExternalStore and useEffect
      // cleanup both expect a bare function. Passing the object causes
      // "TypeError: destroy_ is not a function" at runtime.
      const sub = store.subscribe(() => fn());
      return typeof sub === "function" ? sub : sub.unsubscribe;
    },
  };
}

export function useSignal<T>(initialValue: T): Signal<T> {
  const sig = useMemo(() => signal(initialValue), []);
  useSyncExternalStore(
    (cb) => sig.subscribe(cb),
    () => sig.value,
    () => sig.value,
  );
  return sig;
}

export function useComputed<T>(fn: () => T): Signal<T> {
  const sig = useMemo(() => signal(fn()), []);
  return sig;
}

export function computed<T>(fn: () => T): Signal<T> {
  return signal(fn());
}

export function effect(fn: () => void | (() => void)): () => void {
  const cleanup = fn();
  return typeof cleanup === "function" ? cleanup : () => {};
}

export function batch(fn: () => void): void {
  fn();
}

export function useSignalEffect(fn: () => void | (() => void)): void {
  fn();
}

export type { Signal as ReadonlySignal };
```

> **WARNING**: The `subscribe()` unwrapping is the single most critical line in
> this file. Without it, every component using `useSignal` will crash with
> "TypeError: J is not a function" (minified) or "TypeError: destroy_ is not a
> function" (non-minified), which then cascades into React #419 hydration
> failures and #130 undefined component errors across the entire page.

### Replace Imports

```bash
# Safe for bulk sed
sed -i '' 's|from "@preact/signals"|from "~/sdk/signal"|g'
```

### React Subscriptions

The signal shim's `.value` getter/setter does NOT create automatic React subscriptions. Reading `signal.value` during render won't re-render when the signal changes. This is the #1 source of "it works in Preact but not React" bugs.

Replace manual useEffect+subscribe boilerplate with `useStore`:

```typescript
// OLD (manual subscription -- works but verbose)
const { displayCart } = useUI();
const [open, setOpen] = useState(false);
useEffect(() => {
  setOpen(displayCart.value);
  return displayCart.subscribe(() => setOpen(displayCart.value));
}, []);

// NEW (useStore from @tanstack/react-store -- recommended)
import { useStore } from "@tanstack/react-store";
const { displayCart } = useUI();
const open = useStore(displayCart.store);
```

Write-only consumers (event handlers) don't need `useStore`:
```typescript
// This still works -- .value setter backed by TanStack Store
onClick={() => { displayCart.value = true; }}
```

### DaisyUI Drawer Workaround

DaisyUI drawers use a hidden checkbox to toggle visibility. Since signal changes don't trigger React re-renders, the checkbox `checked` attribute never updates. Pragmatic workaround: directly toggle the DOM checkbox alongside the signal:

```typescript
// After setting the signal, also toggle the drawer checkbox
displayCart.value = true;
const checkbox = document.getElementById("cart-drawer") as HTMLInputElement;
if (checkbox) checkbox.checked = true;
```

This is an interim pattern until all signal consumers use `useStore`. The `useStore` approach is the proper fix because it makes the Drawer component re-render, which updates the checkbox `checked` prop through React.

### Global State Hook Pattern (useCart, useUI)

Hooks that manage global state (cart, UI drawers) need module-level singleton state with a subscription mechanism. The pattern:

```typescript
let _state: CartData | null = null;
const _listeners = new Set<() => void>();

function notify() { _listeners.forEach((fn) => fn()); }

export function useCart() {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const listener = () => forceUpdate((n) => n + 1);
    _listeners.add(listener);
    return () => { _listeners.delete(listener); };
  }, []);

  return {
    cart: {
      get value() { return _state; },
      set value(v) { _state = v; notify(); },
    },
    // ... methods that update _state and call notify()
  };
}
```

Every component calling `useCart()` subscribes to changes, and state updates trigger re-renders across all subscribers. This replaces the Preact signals global reactivity.

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
