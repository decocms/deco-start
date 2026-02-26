/**
 * Types that match @deco/deco's type exports.
 * These allow storefront sites to use the same type interfaces
 * without depending on the Deno-specific @deco/deco package.
 */

export interface FnContext<TState = any> {
  state: TState;
}

export type App<TManifest = any, TState = any, TDeps extends any[] = any[]> = {
  state: TState;
  manifest: TManifest;
  dependencies?: TDeps;
};

export type AppContext<TApp extends App = App> = FnContext<TApp["state"]>;

export type Section<TProps = any> = {
  Component: React.ComponentType<TProps>;
  props: TProps;
};

export type SectionProps<TLoader = any, TAction = TLoader> = TLoader extends (
  ...args: any[]
) => Promise<infer R>
  ? R
  : TLoader;

export type Resolved<T> = T;

export interface LoadingFallbackProps<TProps = any> {
  [key: string]: any;
}

export type Flag = {
  name: string;
  value: boolean;
};
