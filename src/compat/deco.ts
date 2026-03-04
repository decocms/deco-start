/**
 * Shim for @deco/deco
 * Provides type stubs for deco framework types used in components.
 */

export type SectionProps<T extends (...args: any[]) => any> = ReturnType<T>;

export type Resolved<T = any> = T;

export interface LoaderContext {
  request?: Request;
  params?: Record<string, string>;
}

export interface Flag {
  name: string;
  value: boolean;
}

export const context = {
  isDeploy: false,
  platform: "tanstack-start" as string,
  site: "",
  siteId: 0,
};
