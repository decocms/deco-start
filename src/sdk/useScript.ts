/**
 * Serializes functions into inline script strings for SSR output.
 *
 * Includes lightweight minification (whitespace + comment removal)
 * with an LRU cache to avoid re-processing the same function bodies.
 */

// ---------------------------------------------------------------------------
// LRU cache for minified function bodies
// ---------------------------------------------------------------------------

const MAX_CACHE_SIZE = 200;
const minifyCache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const value = minifyCache.get(key);
  if (value !== undefined) {
    // Move to end (most recently used)
    minifyCache.delete(key);
    minifyCache.set(key, value);
  }
  return value;
}

function cacheSet(key: string, value: string) {
  if (minifyCache.size >= MAX_CACHE_SIZE) {
    // Delete oldest entry (first key in insertion order)
    const oldest = minifyCache.keys().next().value;
    if (oldest !== undefined) minifyCache.delete(oldest);
  }
  minifyCache.set(key, value);
}

// ---------------------------------------------------------------------------
// Lightweight minification (no external deps)
// ---------------------------------------------------------------------------

function minifyJs(code: string): string {
  return (
    code
      // Remove block comments only — line-comment stripping and operator-spacing
      // collapse are unsafe: they can corrupt string literals containing "//"
      // or operators, and regex literals whose delimiters look like operators.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // Collapse runs of whitespace (spaces, tabs, newlines) to a single space.
      // This is safe because whitespace inside string/template literals is
      // preserved as a single space, which is semantically identical.
      .replace(/\s+/g, " ")
      .trim()
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serializes a function and its arguments into a self-executing inline script.
 *
 * @example
 * ```tsx
 * <script dangerouslySetInnerHTML={{ __html: useScript(onLoad, elementId, config) }} />
 * ```
 */
export function useScript<T extends (...args: any[]) => void>(
  fn: T,
  ...args: Parameters<T>
): string {
  const fnStr = fn.toString();
  let minified = cacheGet(fnStr);
  if (minified === undefined) {
    minified = minifyJs(fnStr);
    cacheSet(fnStr, minified);
  }

  const serializedArgs = args.map((a) => JSON.stringify(a)).join(",");
  return `(${minified})(${serializedArgs})`;
}

/**
 * Like useScript, but returns a data: URI suitable for `<script src="...">`.
 */
export function useScriptAsDataURI<T extends (...args: any[]) => void>(
  fn: T,
  ...args: Parameters<T>
): string {
  const code = useScript(fn, ...args);
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
}

/**
 * Stub -- Deco partial sections don't apply in TanStack Start.
 * Returns the provided props as-is.
 */
export function usePartialSection(props?: Record<string, unknown>) {
  return props || {};
}

export function useSection(_props?: Record<string, unknown>) {
  return "";
}
