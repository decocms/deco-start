/**
 * Shim for @preact/signals
 * Minimal signal implementation compatible with the original API.
 * For SSR: signals hold their initial value.
 * For client interactivity: components that read signals need useSignalValue().
 */

import { useRef, useEffect } from "react";

export class Signal<T> {
  _value: T;
  _listeners = new Set<() => void>();

  constructor(value: T) {
    this._value = value;
  }

  get value(): T {
    return this._value;
  }

  set value(v: T) {
    if (v !== this._value) {
      this._value = v;
      this._listeners.forEach((fn) => fn());
    }
  }

  peek(): T {
    return this._value;
  }

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  valueOf(): T {
    return this._value;
  }

  toString(): string {
    return String(this._value);
  }
}

export function signal<T>(initialValue: T): Signal<T> {
  return new Signal(initialValue);
}

export function computed<T>(fn: () => T): Signal<T> {
  return new Signal(fn());
}

export function effect(fn: () => void | (() => void)): () => void {
  const cleanup = fn();
  return typeof cleanup === "function" ? cleanup : () => {};
}

export function batch(fn: () => void): void {
  fn();
}

export function useSignal<T>(initialValue: T): Signal<T> {
  const ref = useRef<Signal<T> | null>(null);
  if (ref.current === null) {
    ref.current = new Signal(initialValue);
  }
  return ref.current;
}

export function useComputed<T>(fn: () => T): Signal<T> {
  const ref = useRef<Signal<T> | null>(null);
  if (ref.current === null) {
    ref.current = new Signal(fn());
  }
  return ref.current;
}

export function useSignalEffect(fn: () => void | (() => void)): void {
  useEffect(() => {
    const cleanup = fn();
    return typeof cleanup === "function" ? cleanup : undefined;
  }, []);
}
