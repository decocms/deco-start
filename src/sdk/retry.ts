export const CONNECTION_CLOSED_MESSAGE = "connection closed before message completed";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simple retry utility — replaces cockatiel to avoid module-level AbortController
 * (cockatiel's abort.js creates new AbortController() at module scope, which is
 * forbidden in Cloudflare Workers global scope).
 *
 * Retries up to maxAttempts when the error matches the predicate.
 * Uses exponential backoff: delay = min(initialDelay * exponent^attempt, maxDelay).
 */
export function retryExceptionOr500() {
  return {
    execute: async <T>(fn: () => Promise<T>): Promise<T> => {
      const maxAttempts = 3;
      const initialDelay = 100;
      const maxDelay = 5000;
      const exponent = 2;

      let lastErr: unknown;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          return await fn();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!message.includes(CONNECTION_CLOSED_MESSAGE)) {
            throw err;
          }
          lastErr = err;
          try {
            console.error("retrying...", err);
          } catch (_) {}
          if (attempt < maxAttempts - 1) {
            const delay = Math.min(initialDelay * Math.pow(exponent, attempt), maxDelay);
            await sleep(delay);
          }
        }
      }
      throw lastErr;
    },
  };
}
