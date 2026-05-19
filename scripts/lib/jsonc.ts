/**
 * Shared JSONC helpers.
 *
 * Vendored mini-parser used by the observability codemod
 * (`migrate-to-cf-observability.ts`) and the audit
 * (`audit-observability-config.ts`). Kept here so a single bugfix
 * lands in both call sites.
 *
 * - `stripJsoncComments` removes line + block comments while:
 *   - preserving quoted strings (handles `\"` and `\\` escapes),
 *   - preserving newlines (so JSON.parse error line numbers stay
 *     aligned with the original source file).
 *
 * - `stripJsoncTrailingCommas` removes trailing commas before `}` and
 *   `]`. JSONC allows them; vanilla `JSON.parse` does not. Real
 *   `wrangler.jsonc` files commonly have trailing commas — audits that
 *   call `JSON.parse` directly fail surprisingly otherwise.
 *
 * - `parseJsonc` is the convenience wrapper: strip comments + trailing
 *   commas, then `JSON.parse`. Throws on malformed input.
 */
export function stripJsoncComments(src: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let stringQuote = "";
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < src.length) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === stringQuote) {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Strip trailing commas from a JSONC string — the comma between the
 * last value and its closing `}` or `]`. String-aware so commas inside
 * string literals are preserved verbatim.
 */
export function stripJsoncTrailingCommas(src: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let stringQuote = "";
  while (i < src.length) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === stringQuote) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === ",") {
      // Look ahead through whitespace for the next non-space character.
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (j < src.length && (src[j] === "}" || src[j] === "]")) {
        // Drop the comma, keep the whitespace so line numbers stay aligned.
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Parse a JSONC string. Strips comments + trailing commas before
 * handing to `JSON.parse`. Throws the same `SyntaxError` as JSON.parse
 * for inputs that remain malformed after stripping.
 */
export function parseJsonc<T = unknown>(src: string): T {
  return JSON.parse(stripJsoncTrailingCommas(stripJsoncComments(src))) as T;
}
