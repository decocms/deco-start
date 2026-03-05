/**
 * Typed invoke proxy for client-side RPC to deco loaders/actions.
 *
 * Creates a Proxy object that maps loader keys to `POST /deco/invoke/:key` calls,
 * providing a type-safe, ergonomic API for client-side data fetching.
 *
 * @example
 * ```ts
 * // Define your loader registry type
 * type Loaders = {
 *   "vtex/loaders/intelligentSearch/productList.ts": (props: { query: string }) => Promise<Product[]>;
 *   "vtex/loaders/intelligentSearch/productDetailsPage.ts": (props: { slug: string }) => Promise<ProductDetailsPage>;
 * };
 *
 * const invoke = createInvokeProxy<Loaders>("/deco/invoke");
 *
 * // Type-safe calls:
 * const products = await invoke["vtex/loaders/intelligentSearch/productList.ts"]({ query: "shoes" });
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
export function createInvokeProxy<
  TLoaders extends Record<string, (props: any) => Promise<any>>,
>(basePath = "/deco/invoke"): InvokeProxy<TLoaders> {
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
