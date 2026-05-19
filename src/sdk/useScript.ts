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
 * @deprecated `fn.toString()` produces different output in SSR vs client Vite
 * builds (React Compiler transforms differ), causing hydration mismatches on
 * `dangerouslySetInnerHTML.__html`. Use {@link inlineScript} with a plain
 * string constant instead.
 *
 * @example
 * ```tsx
 * // BEFORE (causes hydration mismatch):
 * <script dangerouslySetInnerHTML={{ __html: useScript(onLoad, elementId) }} />
 *
 * // AFTER (safe):
 * <script {...inlineScript(`(${MY_SCRIPT_STRING})("${elementId}")`)} />
 * ```
 */
export function useScript<T extends (...args: any[]) => void>(
  fn: T,
  ...args: Parameters<T>
): string {
  if (typeof (globalThis as any).__DECO_USE_SCRIPT_WARNED === "undefined") {
    (globalThis as any).__DECO_USE_SCRIPT_WARNED = new Set<string>();
  }
  const warnedSet = (globalThis as any).__DECO_USE_SCRIPT_WARNED as Set<string>;
  const fnName = fn.name || "anonymous";
  if (
    typeof process !== "undefined" &&
    process.env?.NODE_ENV !== "production" &&
    !warnedSet.has(fnName)
  ) {
    warnedSet.add(fnName);
    console.warn(
      `[useScript] Using fn.toString() for "${fnName}". ` +
        `This may produce different output in SSR vs client builds, causing hydration mismatch. ` +
        `Consider using inlineScript() with a plain string constant instead.`,
    );
  }

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
 *
 * @deprecated Same hydration issues as {@link useScript}. Use {@link inlineScript} instead.
 */
export function useScriptAsDataURI<T extends (...args: any[]) => void>(
  fn: T,
  ...args: Parameters<T>
): string {
  const code = useScript(fn, ...args);
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
}

/**
 * Returns props for a `<script>` element with safe inline JavaScript.
 * Unlike {@link useScript}, this accepts a plain string — no `fn.toString()`
 * means no SSR/client divergence and no hydration mismatch.
 *
 * @example
 * ```tsx
 * const SCROLL_SCRIPT = `document.getElementById("btn").addEventListener("click", () => { ... })`;
 * <script {...inlineScript(SCROLL_SCRIPT)} />
 *
 * // With arguments:
 * const INIT_SCRIPT = (id: string) => `document.getElementById("${id}").dataset.ready = "true"`;
 * <script {...inlineScript(INIT_SCRIPT("my-element"))} />
 * ```
 */
export function inlineScript(js: string) {
  return { dangerouslySetInnerHTML: { __html: js } } as const;
}

/**
 * @deprecated Removed in TanStack Start.
 *
 * The Fresh/Deno HTMX-based partial-section pattern (`useSection` /
 * `usePartialSection` + `sections/Component.tsx`) does not apply on
 * Cloudflare Workers and React. Replace call-sites with one of:
 *
 *   1. Local React state (`useState` + event handlers) for client-side toggles.
 *   2. `createServerFn` + `useMutation` for server actions.
 *   3. Direct `invoke` calls (`~/server/invoke`) for ad-hoc loaders.
 *
 * See: deco-to-tanstack-migration skill, "useComponent / partial sections"
 * section, for the per-pattern recipes.
 *
 * ## SSR-safe stub behavior (since 2.27)
 *
 * Earlier versions threw on call. That broke SSR for the *entire page* if a
 * single section still imported `useSection` — even sections that the user
 * never interacts with (e.g. legacy login form on the homepage). React's
 * error boundary would catch the throw and degrade the whole route to
 * client rendering.
 *
 * The current behavior:
 *   - returns a stable placeholder URL (`HTMX_LEGACY_URL`) so it can be
 *     embedded in `hx-get` / `hx-post` attributes without crashing the
 *     SSR pass,
 *   - logs a deduped `console.warn` (in dev only) per call site so the
 *     migration signal stays loud,
 *   - the `htmx-residue` audit rule still catalogues every call site for
 *     systematic rewrite.
 *
 * This is a deliberate trade-off: SSR success > strict-throw enforcement.
 * Audit + skill docs do the enforcement instead.
 */
const DEPRECATION_MESSAGE =
  "[@decocms/start] useSection / usePartialSection were removed. " +
  "The Fresh/Deno HTMX partial-section pattern does not apply on " +
  "TanStack Start / Cloudflare Workers. Replace call-sites with " +
  "createServerFn + useMutation, or local React state. See the " +
  "deco-to-tanstack-migration skill for per-pattern recipes. " +
  "Run `deco-post-cleanup` and look for rule [9] htmx-residue to find " +
  "every site call-site that still depends on this.";

/**
 * Stable placeholder URL returned by the legacy `useSection` /
 * `usePartialSection` stubs. Hitting this URL surfaces a clear error.
 * Exported so frameworks/tests can match against it.
 */
export const HTMX_LEGACY_URL = "/__deco_legacy_htmx_section__";

function warnLegacyHtmx(name: string) {
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "production") {
    return;
  }
  if (typeof (globalThis as any).__DECO_LEGACY_HTMX_WARNED === "undefined") {
    (globalThis as any).__DECO_LEGACY_HTMX_WARNED = new Set<string>();
  }
  const set = (globalThis as any).__DECO_LEGACY_HTMX_WARNED as Set<string>;
  if (set.has(name)) return;
  set.add(name);
  console.warn(`[${name}] ${DEPRECATION_MESSAGE}`);
}

export function usePartialSection(_props?: Record<string, unknown>): string {
  warnLegacyHtmx("usePartialSection");
  return HTMX_LEGACY_URL;
}

export function useSection(_props?: Record<string, unknown>): string {
  warnLegacyHtmx("useSection");
  return HTMX_LEGACY_URL;
}
