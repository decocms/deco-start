/**
 * Centralized environment detection for @decocms/start.
 *
 * Works in Cloudflare Workers (wrangler dev), Node, and Vite SSR.
 * Evaluates lazily on first call so it picks up env vars set after module load.
 */

let _isDev: boolean | null = null;

/**
 * Returns `true` when running in a development environment.
 *
 * Detection order:
 *  1. `DECO_CACHE_DISABLE=true` — explicit opt-in (always wins)
 *  2. `NODE_ENV=development`    — standard Node/Vite convention
 *
 * The result is memoised after the first evaluation.
 */
export function isDevMode(): boolean {
  if (_isDev !== null) return _isDev;

  const env = typeof globalThis.process !== "undefined" ? globalThis.process.env : undefined;

  _isDev = env?.DECO_CACHE_DISABLE === "true" || env?.NODE_ENV === "development";

  return _isDev;
}
