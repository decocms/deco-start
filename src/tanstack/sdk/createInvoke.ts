/**
 * Generic bridge that turns any async function into a TanStack Start server function.
 *
 * Used by @decocms/apps to expose commerce actions/loaders as typed
 * `invoke.*` calls that execute on the server with full credentials.
 *
 * @example
 * ```ts
 * import { createInvokeFn } from "@decocms/start/sdk/createInvoke";
 * import { addItemsToCart } from "./actions/checkout";
 *
 * export const invoke = {
 *   vtex: {
 *     actions: {
 *       addItemsToCart: createInvokeFn(
 *         (input: { orderFormId: string; orderItems: CartItem[] }) =>
 *           addItemsToCart(input.orderFormId, input.orderItems),
 *         { unwrap: true },
 *       ),
 *     },
 *   },
 * };
 *
 * // Client-side usage:
 * await invoke.vtex.actions.addItemsToCart({ data: { orderFormId, orderItems } });
 * ```
 */
import { createServerFn } from "@tanstack/react-start";

export interface InvokeFnOpts {
  /**
   * When true, extracts `.data` from the result before returning.
   * Use for VTEX checkout functions that return VtexFetchResult<T>
   * (i.e. `{ data: T, setCookies: string[] }`).
   */
  unwrap?: boolean;
}

/**
 * Transforms an async function into a `createServerFn` wrapper.
 *
 * - Client calls: `fn({ data: input })`
 * - Server executes: `action(input)`
 * - If `unwrap: true`, extracts `.data` from VtexFetchResult-shaped results
 */
export function createInvokeFn<TInput, TOutput>(
  action: (input: TInput) => Promise<TOutput>,
  opts?: InvokeFnOpts,
): (ctx: { data: TInput }) => Promise<TOutput> {
  return createServerFn({ method: "POST" }).handler(async (ctx) => {
    const result = await action(ctx.data as TInput);
    if (opts?.unwrap && result && typeof result === "object" && "data" in result) {
      return (result as any).data;
    }
    return result;
  }) as unknown as (ctx: { data: TInput }) => Promise<TOutput>;
}
