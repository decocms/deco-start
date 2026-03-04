/**
 * Serializes a function and arguments into an inline script string.
 * Used for injecting client-side JS in SSR output.
 */
export function useScript(fn: (...args: any[]) => void, ...args: any[]): string {
  const serializedArgs = args.map((a) => JSON.stringify(a)).join(",");
  return `(${fn.toString()})(${serializedArgs})`;
}

export function useScriptAsDataURI(fn: (...args: any[]) => void, ...args: any[]): string {
  const serializedArgs = args.map((a) => JSON.stringify(a)).join(",");
  const code = `(${fn.toString()})(${serializedArgs})`;
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
