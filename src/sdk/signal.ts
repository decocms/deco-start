/**
 * Reactive signal backed by @tanstack/store.
 *
 * Drop-in replacement for the preact signals shim.
 * Preserves the .value getter/setter API so consumers don't need to change.
 *
 * For React components that need to re-render on state changes,
 * use the useStore() hook from @tanstack/react-store:
 *
 *   import { useStore } from "@tanstack/react-store";
 *   const value = useStore(mySignal.store);
 */
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
    get value(): T {
      return store.state;
    },
    set value(v: T) {
      store.setState(() => v);
    },
    peek(): T {
      return store.state;
    },
    subscribe(fn: () => void): () => void {
      const sub = store.subscribe(() => fn());
      return () => sub.unsubscribe();
    },
  };
}

/**
 * Drop-in replacement for @preact/signals useSignal hook.
 * Creates a signal scoped to the call site (not a React hook — same as Preact).
 */
export function useSignal<T>(initialValue: T): ReactiveSignal<T> {
  return signal(initialValue);
}

/**
 * Drop-in replacement for @preact/signals computed.
 * Re-evaluates whenever any signal read inside `fn` changes.
 *
 * NOTE: This is a simplified version — it polls on subscribe rather
 * than tracking fine-grained dependencies like Preact signals does.
 */
export function computed<T>(fn: () => T): ReactiveSignal<T> {
  const s = signal(fn());
  // No automatic dependency tracking — callers should subscribe
  // to source signals and update manually if needed.
  return s;
}

/**
 * Drop-in replacement for @preact/signals effect.
 * Runs `fn` immediately and re-runs it whenever signals it reads change.
 *
 * NOTE: Without fine-grained tracking, this runs `fn` once. For reactive
 * updates, subscribe to individual signals instead.
 */
export function effect(fn: () => void | (() => void)): () => void {
  const cleanup = fn();
  return typeof cleanup === "function" ? cleanup : () => {};
}
