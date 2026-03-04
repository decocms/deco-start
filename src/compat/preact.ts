/**
 * Shim for preact
 * Re-exports React types using Preact naming conventions.
 */
export type { ReactNode as ComponentChildren, JSX } from "react";
export {
  createElement,
  Fragment,
  createContext,
  createRef,
  isValidElement,
  Component,
} from "react";
export type { RefObject, FunctionComponent, ComponentType } from "react";
