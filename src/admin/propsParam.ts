/** Run `fn`, returning its result or `null` if it throws. */
function tryOrNull<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * Parse the admin `props` query param into an object.
 *
 * The admin may send props in either of two encodings:
 *   1. encodeURIComponent(JSON.stringify(props))            — plain
 *   2. btoa(encodeURIComponent(JSON.stringify(props)))      — base64
 *
 * Strategies are tried in order; the first that yields a plain JSON object
 * wins. Returns null when no strategy parses, so callers can decide how to
 * react (instead of silently getting `{}`).
 *
 * Ordering note: a base64 string contains no `%`, so `decodeURIComponent`
 * returns it unchanged and `JSON.parse` fails, dropping cleanly to the
 * base64 branch.
 */
export function parsePropsParam(raw: string): Record<string, unknown> | null {
  const strategies = [
    () => decodeURIComponent(raw), // plain URI-encoded JSON
    () => decodeURIComponent(atob(raw)), // base64(URI-encoded JSON)
  ];
  for (const decode of strategies) {
    const parsed = tryOrNull(() => JSON.parse(decode()) as unknown);
    // Props are always a plain object — reject arrays and primitives.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return null;
}
