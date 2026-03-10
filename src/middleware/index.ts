/**
 * Deco middleware utilities for TanStack Start.
 *
 * These are NOT TanStack `createMiddleware()` instances because
 * `@decocms/start` doesn't depend on `@tanstack/react-start`.
 * Instead, they export composable handler functions that storefronts
 * wire into their own `createMiddleware()` chain.
 *
 * @example
 * ```ts
 * // In your storefront's middleware.ts
 * import { createMiddleware } from "@tanstack/react-start";
 * import { buildDecoState, handleLiveness, applyServerTiming, applyCorsHeaders } from "@decocms/start/middleware";
 *
 * export const decoMiddleware = createMiddleware().server(async ({ request, next }) => {
 *   const liveness = handleLiveness(request);
 *   if (liveness) return { result: undefined, response: liveness };
 *
 *   const state = buildDecoState(request, "my-site");
 *   const endTotal = state.timings.start("total");
 *
 *   const result = await next();
 *
 *   endTotal();
 *   applyServerTiming(result.response, state);
 *   if (state.isAdmin) applyCorsHeaders(result.response, request);
 *
 *   return result;
 * });
 * ```
 */

export { buildDecoState, type DecoState } from "./decoState";
export { handleLiveness } from "./liveness";
export {
  configureTracer,
  getTracer,
  logRequest,
  type TracerAdapter,
  withTracing,
} from "./observability";

/**
 * Appends Server-Timing header to a response from the accumulated timings.
 */
export function applyServerTiming(response: Response, state: { timings: { toHeader(): string } }) {
  const header = state.timings.toHeader();
  if (header) {
    response.headers.append("Server-Timing", header);
  }
}

/**
 * Applies CORS headers for deco admin origins to a response.
 */
export function applyCorsHeaders(response: Response, request: Request) {
  const origin = request.headers.get("origin") || "*";
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, If-None-Match",
  );
  response.headers.set("Access-Control-Allow-Credentials", "true");
}
