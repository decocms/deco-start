/**
 * Per-export classifier for `~/lib/vtex-*` shim files.
 *
 * The post-migration audit's `vtex-shim-regression` rule used to flag
 * any import from these shims. That was overconfident — some shims have
 * functional implementations of utility code (cookie parsing, fetch
 * wrapping), while others are silent stubs (`return null`, `return {}`,
 * identity casts) that drop runtime data and cause hard-to-trace bugs.
 *
 * This classifier inspects each export of a shim and labels it as:
 *
 * - **stub**: definitely a silent regression — body is `return null`,
 *   `return {}`, `return []`, an identity cast `return x as T`, or an
 *   unconditional `throw`. Importing this symbol means the shim is
 *   pretending to do work but isn't.
 * - **type-only**: `interface` or `type` declaration — no runtime impact,
 *   never a regression.
 * - **functional**: anything else (real implementations, even trivial
 *   ones like `return key.startsWith("filter.")`). Default-safe label —
 *   if we can't prove it's a stub, treat it as functional and don't flag.
 *
 * Trade-off — by design, we err toward "functional" when uncertain.
 * That means some lossy implementations (e.g. a `withSegmentCookie`
 * that returns `new Headers()` instead of attaching the cookie) classify
 * as functional even though they're effectively stubs. Catching those
 * would need real semantic analysis. False negatives are tolerable; the
 * rule still warns when *any* imported symbol from the shim is a clear
 * stub, which is enough to surface the real-world regressions we've
 * actually seen on production sites (casaevideo: `getSegmentFromBag`,
 * `getISCookiesFromBag`, `toProduct`).
 *
 * Implementation note — string parsing, not a real TypeScript AST. The
 * shim files are tiny by design (the casaevideo ones are 1-39 lines).
 * A balanced-brace body extractor + small set of stub patterns covers
 * every case observed on real sites. If this ever needs to handle
 * decorators, generics on consts, or weirder JSX forms, the right move
 * is to swap in `typescript`'s `createSourceFile` — but we don't pay
 * that dependency cost until it's clearly needed.
 */

export type ExportClass = "stub" | "type-only" | "functional";

export interface ClassifiedExport {
  name: string;
  class: ExportClass;
  /** Short, human-readable reason for the classification. */
  reason?: string;
}

/**
 * Strip line/block comments from a string before regex-matching the
 * body. Keeps newlines so positions stay roughly aligned for debug.
 */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/**
 * Find the matching `}` for the `{` at `openIdx`. Returns the index of
 * the closing brace, or -1 if unbalanced. Tolerates strings and template
 * literals that may contain stray braces — we honor the basic quoting
 * rules, not full TS lexer fidelity.
 */
function findMatchingBrace(content: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  let inStr: string | null = null;
  let esc = false;
  while (i < content.length) {
    const c = content[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (c === "\\") {
        esc = true;
      } else if (c === inStr) {
        inStr = null;
      }
    } else if (c === '"' || c === "'" || c === "`") {
      inStr = c;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Match `return null` / `return {}` / `return []` / `return X as Y` /
 * `throw new Error(...)` as the only meaningful statement in the body.
 * Comments and whitespace are tolerated.
 */
function classifyBodyText(body: string): { class: ExportClass; reason?: string } | null {
  const cleaned = stripComments(body).trim();
  // Allow a trailing semicolon, but not multiple statements.
  const single = cleaned.replace(/;\s*$/, "").trim();
  if (single === "") return null;
  // Reject anything that looks like multiple statements.
  if (/[;\n]/.test(single.replace(/\s+/g, " ").trim()) && !/^return\s/.test(single)) {
    return null;
  }
  if (/^return\s+null$/.test(single)) {
    return { class: "stub", reason: "returns null" };
  }
  if (/^return\s+\{\s*\}$/.test(single)) {
    return { class: "stub", reason: "returns empty object" };
  }
  if (/^return\s+\[\s*\]$/.test(single)) {
    return { class: "stub", reason: "returns empty array" };
  }
  if (/^return\s+""$/.test(single) || /^return\s+''$/.test(single)) {
    return { class: "stub", reason: "returns empty string" };
  }
  // Identity cast: `return ident as Type`. The right-hand side must be a
  // bare identifier (or nested member like `obj.prop`) — anything else is
  // probably real work.
  const identityMatch = single.match(
    /^return\s+([A-Za-z_][A-Za-z0-9_.]*)\s+as\s+[A-Za-z_][A-Za-z0-9_<>,\s.|&]*$/,
  );
  if (identityMatch) {
    return { class: "stub", reason: `identity cast (return ${identityMatch[1]} as …)` };
  }
  if (/^throw\s+new\s+\w+\s*\(/.test(single)) {
    return { class: "stub", reason: "unconditional throw" };
  }
  return null;
}

/**
 * Locate `export function NAME(args): RT { body }` and `export async`
 * variants. Returns each export with its body classified.
 */
function classifyFunctionDecls(content: string): ClassifiedExport[] {
  const out: ClassifiedExport[] = [];
  // Anchored at start-of-line + optional indent — avoids catching
  // `export default function` (which has no name immediately after).
  const re = /(?:^|\n)[ \t]*export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  for (const m of content.matchAll(re)) {
    const name = m[1];
    const startSearchAt = (m.index ?? 0) + m[0].length;
    const openIdx = content.indexOf("{", startSearchAt);
    if (openIdx === -1) {
      out.push({ name, class: "functional", reason: "no body found (declaration only)" });
      continue;
    }
    const closeIdx = findMatchingBrace(content, openIdx);
    if (closeIdx === -1) {
      out.push({ name, class: "functional", reason: "unbalanced braces" });
      continue;
    }
    const body = content.slice(openIdx + 1, closeIdx);
    const verdict = classifyBodyText(body);
    out.push(
      verdict
        ? { name, class: verdict.class, reason: verdict.reason }
        : { name, class: "functional" },
    );
  }
  return out;
}

/**
 * Locate `export const NAME = (args) => …` and classify the arrow body.
 * Block-bodied arrows reuse the function-body classifier; expression
 * bodies are matched directly.
 */
function classifyConstArrowDecls(content: string): ClassifiedExport[] {
  const out: ClassifiedExport[] = [];
  const re = /(?:^|\n)[ \t]*export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
  for (const m of content.matchAll(re)) {
    const name = m[1];
    const startIdx = (m.index ?? 0) + m[0].length;
    const after = content.slice(startIdx);
    // Look for: optional `async`, `(args)`, optional `: ReturnType`, `=>`.
    const arrowHead = after.match(/^\s*(?:async\s+)?\([^)]*\)\s*(?::[^=]+)?=>\s*/);
    if (!arrowHead) {
      out.push({ name, class: "functional" });
      continue;
    }
    const bodyStart = startIdx + arrowHead[0].length;
    // Block body: classify the inside via the shared body classifier.
    if (content[bodyStart] === "{") {
      const closeIdx = findMatchingBrace(content, bodyStart);
      if (closeIdx === -1) {
        out.push({ name, class: "functional", reason: "unbalanced braces" });
        continue;
      }
      const body = content.slice(bodyStart + 1, closeIdx);
      const verdict = classifyBodyText(body);
      out.push(
        verdict
          ? { name, class: verdict.class, reason: verdict.reason }
          : { name, class: "functional" },
      );
      continue;
    }
    // Expression body: read until line break / semicolon.
    const exprMatch = content.slice(bodyStart).match(/^([^;\n]+?)\s*;?\s*(?:\n|$)/);
    if (!exprMatch) {
      out.push({ name, class: "functional" });
      continue;
    }
    const expr = exprMatch[1].trim();
    if (expr === "null") {
      out.push({ name, class: "stub", reason: "arrow returns null" });
    } else if (/^\(\s*\{\s*\}\s*\)$/.test(expr) || expr === "{}") {
      out.push({ name, class: "stub", reason: "arrow returns empty object" });
    } else if (/^\[\s*\]$/.test(expr)) {
      out.push({ name, class: "stub", reason: "arrow returns empty array" });
    } else {
      out.push({ name, class: "functional" });
    }
  }
  return out;
}

/**
 * Locate `export interface NAME` / `export type NAME` declarations.
 */
function classifyTypeDecls(content: string): ClassifiedExport[] {
  const out: ClassifiedExport[] = [];
  const re = /(?:^|\n)[ \t]*export\s+(?:interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  for (const m of content.matchAll(re)) {
    out.push({ name: m[1], class: "type-only" });
  }
  return out;
}

/**
 * Classify every top-level export in a shim file. Returns one entry per
 * export, in source order is not guaranteed (we run three passes over
 * the content); callers should look up by `name`.
 */
export function classifyShimExports(content: string): ClassifiedExport[] {
  return [
    ...classifyFunctionDecls(content),
    ...classifyConstArrowDecls(content),
    ...classifyTypeDecls(content),
  ];
}
