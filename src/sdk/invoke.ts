/**
 * Typed invoke proxies for client-side RPC to deco loaders/actions.
 *
 * Two flavors:
 *
 * 1. `createInvokeProxy<T>()` — flat keys (e.g. `invoke["vtex/loaders/productList.ts"](props)`)
 * 2. `createAppInvoke<T>()` — nested keys (e.g. `invoke.vtex.actions.checkout.addItemsToCart(props)`)
 *
 * Both POST to `/deco/invoke/{key}` under the hood.
 *
 * @example
 * ```ts
 * // Flat proxy (legacy):
 * const invoke = createInvokeProxy<Loaders>();
 * await invoke["vtex/loaders/productList.ts"]({ query: "shoes" });
 *
 * // Nested proxy (recommended):
 * const invoke = createAppInvoke();
 * await invoke.vtex.actions.checkout.addItemsToCart({ orderFormId, orderItems });
 * ```
 */

export type InvokeProxy<TLoaders extends Record<string, (props: any) => Promise<any>>> = {
  [K in keyof TLoaders]: TLoaders[K] extends (props: infer P) => Promise<infer R>
    ? (props: P) => Promise<R>
    : never;
};

/**
 * Creates a proxy that turns loader key access into fetch calls to `/deco/invoke/:key`.
 */
export function createInvokeProxy<TLoaders extends Record<string, (props: any) => Promise<any>>>(
  basePath = "/deco/invoke",
): InvokeProxy<TLoaders> {
  return new Proxy({} as InvokeProxy<TLoaders>, {
    get(_target, prop: string) {
      return async (props: unknown) => {
        const url = `${basePath}/${encodeURIComponent(prop)}`;
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(props ?? {}),
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: response.statusText }));
          throw new Error(
            `Invoke ${prop} failed (${response.status}): ${(error as any).error || response.statusText}`,
          );
        }

        return response.json();
      };
    },
  });
}

/**
 * Batch invoke multiple loaders in a single request.
 *
 * @example
 * ```ts
 * const results = await batchInvoke("/deco/invoke", {
 *   products: { __resolveType: "vtex/loaders/productList.ts", query: "shoes" },
 *   details: { __resolveType: "vtex/loaders/productDetailsPage.ts", slug: "shoe-1" },
 * });
 * ```
 */
export async function batchInvoke<T extends Record<string, unknown>>(
  basePath: string,
  payloads: T,
): Promise<{ [K in keyof T]: unknown }> {
  const response = await fetch(basePath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payloads),
  });

  if (!response.ok) {
    throw new Error(`Batch invoke failed (${response.status})`);
  }

  return response.json();
}

/**
 * Helper to create TanStack Query `queryOptions` for an invoke call.
 * The storefront must have `@tanstack/react-query` installed.
 *
 * @example
 * ```ts
 * import { useQuery } from "@tanstack/react-query";
 * import { invokeQueryOptions } from "@decocms/start/sdk/invoke";
 *
 * const options = invokeQueryOptions(
 *   "vtex/loaders/productList.ts",
 *   { query: "shoes" },
 *   { staleTime: 60_000 }
 * );
 *
 * // In a component:
 * const { data } = useQuery(options);
 *
 * // In a route loader:
 * queryClient.ensureQueryData(options);
 * ```
 */
export function invokeQueryOptions<TResult = unknown>(
  key: string,
  props: unknown,
  options?: { staleTime?: number; gcTime?: number; basePath?: string },
) {
  const basePath = options?.basePath ?? "/deco/invoke";

  return {
    queryKey: ["deco-invoke", key, props] as const,
    queryFn: async (): Promise<TResult> => {
      const url = `${basePath}/${encodeURIComponent(key)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(props ?? {}),
      });

      if (!response.ok) {
        throw new Error(`Invoke ${key} failed (${response.status})`);
      }

      return response.json();
    },
    staleTime: options?.staleTime,
    gcTime: options?.gcTime,
  };
}

// ---------------------------------------------------------------------------
// Nested invoke proxy — createAppInvoke
// ---------------------------------------------------------------------------

/**
 * Converts flat slash-separated keys into a nested object type.
 *
 * @example
 * ```ts
 * type Map = {
 *   "vtex/actions/checkout/addItemsToCart": (props: CartInput) => Promise<OrderForm>;
 *   "vtex/loaders/catalog/getProduct": (props: { slug: string }) => Promise<Product>;
 * };
 * type Nested = NestedFromFlat<Map>;
 * // { vtex: { actions: { checkout: { addItemsToCart: (props: CartInput) => Promise<OrderForm> } } } }
 * ```
 */
type SplitFirst<S extends string> = S extends `${infer Head}/${infer Tail}`
  ? [Head, Tail]
  : [S, never];

type BuildNested<Key extends string, Value> = SplitFirst<Key> extends [
  infer H extends string,
  infer T,
]
  ? T extends string
    ? { [K in H]: BuildNested<T, Value> }
    : { [K in H]: Value }
  : never;

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

type DeepMerge<T> = T extends object
  ? { [K in keyof T]: DeepMerge<T[K]> }
  : T;

export type NestedFromFlat<T extends Record<string, any>> = DeepMerge<
  UnionToIntersection<
    { [K in keyof T & string]: BuildNested<K, T[K]> }[keyof T & string]
  >
>;

/**
 * Creates a typed nested invoke proxy.
 *
 * Each property access accumulates path segments. When called as a function,
 * the segments are joined with "/" and POSTed to `/deco/invoke/{key}`.
 * If the primary key returns 404, a `.ts` suffix variant is tried.
 *
 * @example
 * ```ts
 * import { createAppInvoke } from "@decocms/start/sdk/invoke";
 *
 * // Untyped (any):
 * const invoke = createAppInvoke();
 * await invoke.vtex.actions.checkout.addItemsToCart({ orderFormId, orderItems });
 *
 * // Typed (with handler map):
 * type Handlers = {
 *   "vtex/actions/checkout/addItemsToCart": (props: CartInput) => Promise<OrderForm>;
 * };
 * const invoke = createAppInvoke<Handlers>();
 * await invoke.vtex.actions.checkout.addItemsToCart({ orderFormId, orderItems });
 * ```
 */
export function createAppInvoke(basePath?: string): any;
export function createAppInvoke<T extends Record<string, any>>(basePath?: string): NestedFromFlat<T>;
export function createAppInvoke(
  basePath = "/deco/invoke",
): any {
  function buildProxy(path: string[]): any {
    return new Proxy(
      Object.assign(async (props: any) => {
        const key = path.join("/");
        for (const k of [key, `${key}.ts`]) {
          const response = await fetch(`${basePath}/${k}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(props ?? {}),
          });
          if (response.status === 404) continue;
          if (!response.ok) {
            const error = await response.json().catch(() => ({ error: response.statusText }));
            throw new Error(
              `invoke(${k}) failed (${response.status}): ${(error as any).error || response.statusText}`,
            );
          }
          return response.json();
        }
        throw new Error(`invoke(${key}) failed: handler not found`);
      }, {}),
      {
        get(_target: any, prop: string) {
          if (prop === "then" || prop === "catch" || prop === "finally") {
            return undefined;
          }
          return buildProxy([...path, prop]);
        },
      },
    );
  }

  return buildProxy([]);
}
