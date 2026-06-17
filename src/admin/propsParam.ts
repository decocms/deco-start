/**
 * Parse the admin `props` query param into an object.
 *
 * The admin may send props in either of two encodings:
 *   1. encodeURIComponent(JSON.stringify(props))            — plain
 *   2. btoa(encodeURIComponent(JSON.stringify(props)))      — base64
 *
 * Strategies are tried in order; the first that yields a JSON object wins.
 * Returns null when no strategy parses, so callers can decide how to react
 * (instead of silently getting `{}`).
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
    try {
      const parsed = JSON.parse(decode());
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next strategy
    }
  }
  return null;
}
