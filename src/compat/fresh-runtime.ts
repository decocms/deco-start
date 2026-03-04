/**
 * Shim for $fresh/runtime.ts
 * In Fresh, asset() prefixes paths with the base URL for static files.
 * In Vite, public/ files are served at the root, so we just return the path.
 */
export function asset(path: string): string {
  return path;
}

export const IS_BROWSER = typeof document !== "undefined";
