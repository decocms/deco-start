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
