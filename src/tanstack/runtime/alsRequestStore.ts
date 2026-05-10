import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestStore } from "../../core/runtime/requestStore";

class AlsRequestStore<T> implements RequestStore<T> {
  private als = new AsyncLocalStorage<T>();
  get(): T | undefined {
    return this.als.getStore();
  }
  run<R>(value: T, fn: () => R): R {
    return this.als.run(value, fn);
  }
}

export function createAlsRequestStore<T>(): RequestStore<T> {
  return new AlsRequestStore<T>();
}
