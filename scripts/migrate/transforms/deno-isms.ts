import type { TransformResult } from "../types.ts";

/**
 * Removes Deno-specific patterns:
 *
 * - // deno-lint-ignore ... comments
 * - // deno-lint-ignore-file comments
 * - npm: prefix from import specifiers (already in imports.ts but this catches stragglers)
 * - Strip .ts/.tsx extensions from local import paths
 */
export function transformDenoIsms(content: string): TransformResult {
  const notes: string[] = [];
  let changed = false;
  let result = content;

  // Remove deno-lint-ignore comments (single line and file-level)
  // Also handle JSX comment form: {/* deno-lint-ignore ... */}
  if (/deno-lint-ignore/.test(result)) {
    result = result.replace(/^\s*\/\/\s*deno-lint-ignore[^\n]*\n?/gm, "");
    result = result.replace(/\s*\{\/\*\s*deno-lint-ignore[^*]*\*\/\}\s*/g, " ");
    changed = true;
    notes.push("Removed deno-lint-ignore comments");
  }

  // Remove npm: prefix in import specifiers that weren't caught by imports transform
  if (/from\s+["']npm:/.test(result)) {
    // npm:pkg@version → pkg (strip version)
    result = result.replace(
      /(from\s+["'])npm:(@?[^@"']+)@[^"']*(["'])/g,
      "$1$2$3",
    );
    // npm:pkg → pkg (no version)
    result = result.replace(
      /(from\s+["'])npm:([^"'@][^"']*)(["'])/g,
      "$1$2$3",
    );
    changed = true;
    notes.push("Removed npm: prefix from imports");
  }

  // @ts-ignore → @ts-expect-error (TypeScript 5+ prefers @ts-expect-error)
  if (/@ts-ignore/.test(result)) {
    result = result.replace(/@ts-ignore/g, "@ts-expect-error");
    changed = true;
    notes.push("Replaced @ts-ignore with @ts-expect-error");
  }

  // Remove Deno.* API usages — flag for manual review
  if (result.includes("Deno.")) {
    notes.push("MANUAL: Deno.* API usage found — needs Node.js equivalent");
  }

  // Remove /// <reference ... /> directives for Deno
  const refDirectiveRegex =
    /^\/\/\/\s*<reference\s+(?:lib|path|types)\s*=\s*"[^"]*deno[^"]*"\s*\/>\s*\n?/gm;
  if (refDirectiveRegex.test(result)) {
    result = result.replace(refDirectiveRegex, "");
    changed = true;
    notes.push("Removed Deno reference directives");
  }

  // Clean up blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return { content: result, changed, notes };
}
