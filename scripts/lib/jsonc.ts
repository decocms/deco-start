/**
 * Shared JSONC helpers.
 *
 * Vendored mini-stripper used by the observability codemod
 * (`migrate-to-cf-observability.ts`) and the audit
 * (`audit-observability-config.ts`). Kept here so a single bugfix
 * lands in both call sites.
 *
 * `stripJsoncComments` removes line + block comments while:
 *   - preserving quoted strings (handles `\"` and `\\` escapes),
 *   - preserving newlines (so JSON.parse error line numbers stay
 *     aligned with the original source file).
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
