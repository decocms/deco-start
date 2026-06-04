/**
 * Inflight-Promise timeout guard for module-level dedup caches.
 *
 * Background: across `@decocms/start` (and `@decocms/apps`) we keep
 * `Map<string, Promise<...>>` caches at module scope to dedup concurrent
 * resolutions of the same loader / section / layout block. Entries are
 * evicted via `.finally()` on the stored Promise.
 *
 * The problem: if the wrapped work never settles — e.g. an upstream `fetch()`
 * hangs because a CDN holds the TCP connection open — the `.finally()` never
 * runs and the Map entry leaks forever. With
 * `no_handle_cross_request_promise_resolution: true` on the consumer Worker,
 * the zombie Promise survives across requests. Every subsequent caller for
 * the same key `await`s it, pinning request context into memory until
 * `exceededMemory` terminates the isolate.
 *
 * Production observation on a TanStack Start storefront (24h window): 514
 * hard `exceededMemory` crashes, with CPU time ~0 and wall time in the tens
 * of minutes — workers sleeping on the dead Promise, not computing.
 *
 * Fix: race the stored Promise against a timeout so its terminal state is
 * guaranteed, which means `.finally()` always runs and the Map slot is
 * freed. The underlying hung work is abandoned (the CF runtime will GC it
 * once the request ends).
 */

/** Default per-entry timeout for inflight dedup caches. */
export const DEFAULT_INFLIGHT_TIMEOUT_MS = 10_000;

/**
 * Race `work` against a timeout. If `work` doesn't settle within `ms`, the
 * returned Promise rejects with a descriptive error so callers' `.finally()`
 * cleanup always runs.
 */
export function withInflightTimeout<T>(
  work: Promise<T>,
  label: string,
  ms: number = DEFAULT_INFLIGHT_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `[deco-start] inflight cache entry "${label}" timed out after ${ms}ms`,
        ),
      );
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
