/**
 * Shim for @deco/deco/hooks
 * Provides useScript and other hooks used in the original stack.
 */

/**
 * Serializes a function into an inline script string.
 * In Fresh/Preact, this was used for injecting client-side JS without islands.
 * In React/TanStack, we render the script tag directly.
 */
export function useScript(fn: (...args: any[]) => void, ...args: any[]): string {
  const serializedArgs = args.map((a) => JSON.stringify(a)).join(",");
  return `(${fn.toString()})(${serializedArgs})`;
}

export function usePartialSection(props?: Record<string, unknown>) {
  return props || {};
}

export function useScriptAsDataURI(fn: (...args: any[]) => void, ...args: any[]): string {
  const serializedArgs = args.map((a) => JSON.stringify(a)).join(",");
  const code = `(${fn.toString()})(${serializedArgs})`;
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
}

export function useSection(props?: Record<string, unknown>) {
  return "";
}
