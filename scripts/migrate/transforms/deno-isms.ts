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
  const denoLintRegex = /^\s*\/\/\s*deno-lint-ignore[^\n]*\n?/gm;
  if (denoLintRegex.test(result)) {
    result = result.replace(denoLintRegex, "");
    changed = true;
    notes.push("Removed deno-lint-ignore comments");
  }

  // Remove npm: prefix in import specifiers that weren't caught by imports transform
  const npmPrefixRegex = /(from\s+["'])npm:([^"'@][^"']*)(["'])/g;
  if (npmPrefixRegex.test(result)) {
    result = result.replace(
      /(from\s+["'])npm:([^"'@][^"']*)(["'])/g,
      "$1$2$3",
    );
    changed = true;
    notes.push("Removed npm: prefix from imports");
  }

  // npm:pkg@version → pkg (strip version too)
  const npmVersionRegex = /(from\s+["'])npm:(@?[^@"']+)@[^"']*(["'])/g;
  if (npmVersionRegex.test(result)) {
    result = result.replace(
      /(from\s+["'])npm:(@?[^@"']+)@[^"']*(["'])/g,
      "$1$2$3",
    );
    changed = true;
    notes.push("Removed npm: prefix and version from imports");
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
