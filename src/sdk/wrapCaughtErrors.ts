/**
 * Error wrapping utility for loader/action results.
 *
 * Wraps a loader function so that thrown errors are caught and
 * returned as a deferred error proxy object instead of crashing
 * the entire page render.
 *
 * The proxy looks like the expected return type but throws the
 * original error if any property is accessed -- this lets the
 * section that uses the data decide whether to render a fallback
 * or propagate the error to an ErrorBoundary.
 *
 * @example
 * ```ts
 * import { wrapCaughtErrors } from "@decocms/start/sdk/wrapCaughtErrors";
 *
 * const safeProductList = wrapCaughtErrors(vtexProductList);
 * const products = await safeProductList({ query: "shoes" });
 * // If vtexProductList threw, `products` is a proxy that throws on access
 * ```
 */

const ERROR_MARKER = Symbol("__decoWrappedError");

export interface WrappedError {
  [ERROR_MARKER]: true;
  error: unknown;
  message: string;
}

/**
 * Check if a value is a wrapped error proxy.
 */
export function isWrappedError(value: unknown): value is WrappedError {
  try {
    return value != null && typeof value === "object" && (value as any)[ERROR_MARKER] === true;
  } catch {
    return true;
  }
}

/**
 * Extract the original error from a wrapped error.
 */
export function unwrapError(value: unknown): unknown {
  if (isWrappedError(value)) {
    return value.error;
  }
  return value;
}

function createErrorProxy(error: unknown): any {
  const message = error instanceof Error ? error.message : String(error);

  const target = {
    [ERROR_MARKER]: true,
    error,
    message,
  };

  return new Proxy(target, {
    get(_target, prop) {
      if (prop === ERROR_MARKER) return true;
      if (prop === "error") return error;
      if (prop === "message") return message;
      if (prop === Symbol.toPrimitive) return () => `[WrappedError: ${message}]`;
      if (prop === "toString") return () => `[WrappedError: ${message}]`;
      if (prop === "toJSON") return () => ({ __error: true, message });

      throw error;
    },
    has(_target, prop) {
      return prop === ERROR_MARKER || prop === "error" || prop === "message";
    },
  });
}

/**
 * Wrap a loader/action function to catch errors and return a proxy.
 *
 * @param fn - The loader or action function to wrap
 * @param onError - Optional error handler (for logging, metrics, etc.)
 */
export function wrapCaughtErrors<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  onError?: (error: unknown, args: TArgs) => void,
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    try {
      return await fn(...args);
    } catch (error) {
      onError?.(error, args);

      const isDev =
        typeof globalThis.process !== "undefined" &&
        globalThis.process.env?.NODE_ENV === "development";
      if (isDev) {
        console.error(
          `[wrapCaughtErrors] Loader failed:`,
          error instanceof Error ? error.message : error,
        );
      }

      return createErrorProxy(error) as TReturn;
    }
  };
}
