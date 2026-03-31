import type { TransformResult } from "../types.ts";

/**
 * Removes dead code patterns from the old Deco stack that don't work
 * in TanStack Start:
 *
 * - `export const cache = "stale-while-revalidate"` (old cache system)
 * - `export const cacheKey = ...` (old cache key generation)
 * - `export const loader = (props, req, ctx) => ...` (old section loader pattern)
 * - `crypto.subtle.digestSync(...)` (Deno-only sync API)
 *
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

  // Find the opening brace of the arrow function body
  let pos = match.index + match[0].length;
  // Skip past the arrow: (params) => {
  while (pos < src.length && src[pos] !== "{") {
    pos++;
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

  // Remove old cacheKey export (can be multiline with nested blocks)
  if (/^export\s+const\s+cacheKey\s*=/m.test(result)) {
    result = removeExportConstBlock(result, "cacheKey");
    // Also handle simpler inline forms
    result = result.replace(
      /^export\s+const\s+cacheKey\s*=[^;{]*;\s*\n?/gm,
      "",
    );
    changed = true;
    notes.push("Removed dead `export const cacheKey` (old caching system)");
  }

  // Remove old section loader export: export const loader = (props, req, ctx) => { ... };
  // This is the old pattern where sections had co-located loaders.
  // In TanStack Start, section loaders are handled differently.
  // Uses brace-counting to handle nested blocks (for loops, if/else, etc.)
  if (/^export\s+const\s+loader\s*=\s*\(/m.test(result)) {
    result = removeExportConstBlock(result, "loader");
    // Also handle simpler inline forms (no braces, single expression)
    result = result.replace(
      /^export\s+const\s+loader\s*=\s*\([^)]*\)\s*=>[^;{]*;\s*\n?/gm,
      "",
    );
    changed = true;
    notes.push("Removed dead `export const loader` (old section loader — use section loaders in @decocms/start)");
  }

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
