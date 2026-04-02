import type { TransformResult } from "../types.ts";

/**
 * Removes dead code patterns from the old Deco stack that don't work
 * in TanStack Start:
 *
 * - `export const cache = "stale-while-revalidate"` (old cache system)
 * - `export const cacheKey = ...` (old cache key generation)
 * - `crypto.subtle.digestSync(...)` (Deno-only sync API)
 *
 * NOTE: `export const loader` is kept — it's a server-side function the CMS calls.
 * NOTE: invoke.* calls are NOT migrated — they are RPC calls to the server
 * where the CMS config (API keys, etc.) is available. The runtime.ts invoke
 * proxy handles routing them to /deco/invoke/*.
 */
/**
 * Remove an `export const <name> = ...` block using brace-counting
 * so nested `{}` (for loops, if/else) don't cause premature truncation.
 */
function removeExportConstBlock(src: string, name: string): string {
  const pattern = new RegExp(`^export\\s+const\\s+${name}\\s*=`, "m");
  const match = pattern.exec(src);
  if (!match) return src;

  // Find the arrow `=>` first, then the opening `{` of the body.
  // This avoids matching destructuring braces in parameters like
  // `export const loader = ({ groups }: Props) => { ... }`
  let pos = match.index + match[0].length;
  // Look for `=>`
  const arrowIdx = src.indexOf("=>", pos);
  if (arrowIdx === -1) {
    // No arrow function — try simple brace from current position
    while (pos < src.length && src[pos] !== "{") pos++;
  } else {
    // Start searching for `{` after the arrow
    pos = arrowIdx + 2;
    while (pos < src.length && src[pos] !== "{") pos++;
  }
  if (pos >= src.length) return src; // no brace body, skip

  // Count braces to find the matching closing brace
  let depth = 0;
  const start = match.index;
  for (; pos < src.length; pos++) {
    if (src[pos] === "{") depth++;
    else if (src[pos] === "}") {
      depth--;
      if (depth === 0) {
        // Skip optional semicolon and trailing newline
        let end = pos + 1;
        if (end < src.length && src[end] === ";") end++;
        if (end < src.length && src[end] === "\n") end++;
        return src.slice(0, start) + src.slice(end);
      }
    }
  }
  return src; // unbalanced braces, don't touch
}

export function transformDeadCode(content: string): TransformResult {
  const notes: string[] = [];
  let changed = false;
  let result = content;

  // Remove old cache export: export const cache = "stale-while-revalidate";
  if (/^export\s+const\s+cache\s*=\s*["'][^"']*["']/m.test(result)) {
    result = result.replace(
      /^export\s+const\s+cache\s*=\s*["'][^"']*["'];?\s*\n?/gm,
      "",
    );
    changed = true;
    notes.push("Removed dead `export const cache` (old caching system)");
  }

  // Remove old cacheKey export (can be multiline with brace-counting)
  if (/^export\s+const\s+cacheKey\s*=/m.test(result)) {
    result = removeExportConstBlock(result, "cacheKey");
    // Also handle simpler inline forms
    result = result.replace(
      /^export\s+const\s+cacheKey\s*=[^;]*;\s*\n?/gm,
      "",
    );
    changed = true;
    notes.push("Removed dead `export const cacheKey` (old caching system)");
  }

  // NOTE: `export const loader` is kept — these are server-side functions
  // that the CMS calls to modify section props before rendering.

  // Replace crypto.subtle.digestSync (Deno-only) with a note
  if (result.includes("digestSync")) {
    result = result.replace(
      /crypto\.subtle\.digestSync\(/g,
      "/* MIGRATION: digestSync is Deno-only, use await crypto.subtle.digest( */ crypto.subtle.digest(",
    );
    changed = true;
    notes.push("MANUAL: crypto.subtle.digestSync is Deno-only — replaced with crypto.subtle.digest (needs await)");
  }

  // invoke.* calls are server RPC via runtime.ts proxy → keep as-is
  // The runtime.ts scaffolded file creates a proxy that routes to /deco/invoke/*
  // where the CMS config (API keys, tokens) is available server-side.

  // Clean up blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return { content: result, changed, notes };
}
