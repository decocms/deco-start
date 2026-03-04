/**
 * Shim for preact/compat
 * Re-exports React with explicit named exports for SSR compatibility.
 * (Vite SSR cannot interop `export * from "react"` reliably.)
 */
export {
  forwardRef,
  lazy,
  Suspense,
  memo,
  createContext,
  createElement,
  createRef,
  Fragment,
  isValidElement,
  Component,
  PureComponent,
  Children,
  cloneElement,
  useEffect,
  useState,
  useRef,
  useMemo,
  useCallback,
  useContext,
  useReducer,
  useId,
  useLayoutEffect,
  useSyncExternalStore,
  useImperativeHandle,
  useDebugValue,
  useDeferredValue,
  useTransition,
  startTransition,
  use,
} from "react";
export { default } from "react";
export type { ReactNode, JSX, RefObject, ComponentType, FunctionComponent } from "react";
