# React Signals & State (TanStack Store)

> Signal .value subscriptions, @tanstack/react-store, subscribe() API.


## 3. Signal .value in Render Doesn't Re-render

Reading `signal.value` inside React render doesn't create a subscription.

**Fix**: Use `useStore(signal.store)` from `@tanstack/react-store` for reactive reads.


## 19. @tanstack/store subscribe() Returns Object, Not Function

**Severity: CRITICAL** -- This causes cascading failures across the entire page.

`@tanstack/store@0.9.x`'s `Store.subscribe()` returns `{ unsubscribe: Function }`, NOT a plain function. React's `useSyncExternalStore` (and `useEffect` cleanup) expect the subscribe callback to return a bare unsubscribe function. Passing the object through causes:

1. "TypeError: destroy_ is not a function" (non-minified) / "TypeError: J is not a function" (minified)
2. Which cascades into React #419 (hydration failure)
3. Which cascades into React #130 (undefined component after hydration bailout)
4. Which makes the entire page non-interactive (0 interactive elements)

**Symptom**: Page SSR renders fine, but client shows "J is not a function" repeating hundreds of times. All interactive elements stop working.

**Fix**: Unwrap the return value in your `Signal.subscribe()` implementation:

```typescript
subscribe(fn) {
  const sub = store.subscribe(() => fn());
  return typeof sub === "function" ? sub : sub.unsubscribe;
},
```


## 38. Signal Shim Doesn't Auto-Trigger React Re-renders

**Severity**: HIGH — drawers don't open, cart badge doesn't update, any signal-driven UI appears frozen

The Preact-to-React signal compat shim has a pub/sub pattern (`_listeners`), but reading `signal.value` in a React render function creates NO subscription. React components don't re-render when the signal changes.

**Symptom**: Setting `displayCart.value = true` doesn't open the cart drawer. Cart item count badge stays at 0 after adding items. Menu drawer toggle does nothing.

**Root cause**: In Preact, `@preact/signals` automatically tracks signal reads in render and re-renders. The shim just has get/set on `.value` with manual `_listeners` — React has no awareness of it.

**Fix (recommended)**: Use `useStore` from `@tanstack/react-store` for components that need reactive reads:

```typescript
import { useStore } from "@tanstack/react-store";
const { displayCart } = useUI();
const open = useStore(displayCart.store);  // auto re-renders on change
```

**Fix (interim)**: For components not yet migrated to `useStore`, bridge with `useState` + `useEffect`:

```typescript
const { displayCart } = useUI();
const [open, setOpen] = useState(displayCart.value);
useEffect(() => {
  const unsub = displayCart.subscribe(() => setOpen(displayCart.value));
  return unsub;
}, []);
```

**Fix (DaisyUI drawers)**: Since DaisyUI drawers are checkbox-driven, directly toggle the DOM checkbox as a pragmatic workaround:

```typescript
const toggleDrawer = (id: string, open: boolean) => {
  const checkbox = document.getElementById(id) as HTMLInputElement;
  if (checkbox) checkbox.checked = open;
};
```
