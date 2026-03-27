import type { TransformResult } from "../types.ts";

/**
 * Removes or replaces Fresh-specific APIs:
 *
 * - asset("/path") → "/path"
 * - <Head>...</Head> → content extracted or removed
 * - defineApp wrapper → unwrap
 * - IS_BROWSER → typeof window !== "undefined"
 * - Context.active().release?.revision() → "" (Vite handles cache busting)
 */
export function transformFreshApis(content: string): TransformResult {
  const notes: string[] = [];
  let changed = false;
  let result = content;

  // asset("/path") → "/path" and asset(`/path`) → `/path`
  const assetCallRegex = /\basset\(\s*(`[^`]+`|"[^"]+"|'[^']+')\s*\)/g;
  if (assetCallRegex.test(result)) {
    result = result.replace(
      /\basset\(\s*(`[^`]+`|"[^"]+"|'[^']+')\s*\)/g,
      (_match, path) => {
        // For template literals with revision, simplify
        const inner = path.slice(1, -1);
        if (inner.includes("${revision}") || inner.includes("?revision=")) {
          // Remove cache-busting query — Vite handles it
          const clean = inner
            .replace(/\?revision=\$\{revision\}/, "")
            .replace(/\$\{revision\}/, "");
          return `"${clean}"`;
        }
        return path;
      },
    );
    changed = true;
    notes.push("Replaced asset() calls with direct paths");
  }

  // Remove import { asset, Head } from "$fresh/runtime.ts"
  // (the imports transform handles the specifier, but we also need to handle
  // cases where the import line wasn't fully removed)
  result = result.replace(
    /^import\s+\{[^}]*\b(?:asset|Head)\b[^}]*\}\s+from\s+["']\$fresh\/runtime\.ts["'];?\s*\n?/gm,
    "",
  );
  result = result.replace(
    /^import\s+\{[^}]*\}\s+from\s+["']\$fresh\/server\.ts["'];?\s*\n?/gm,
    "",
  );

  // IS_BROWSER → typeof window !== "undefined"
  if (result.includes("IS_BROWSER")) {
    result = result.replace(
      /\bIS_BROWSER\b/g,
      '(typeof window !== "undefined")',
    );
    // Remove the import
    result = result.replace(
      /^import\s+\{[^}]*\bIS_BROWSER\b[^}]*\}\s+from\s+["'][^"']+["'];?\s*\n?/gm,
      "",
    );
    changed = true;
    notes.push('Replaced IS_BROWSER with typeof window !== "undefined"');
  }

  // Context.active().release?.revision() → "" or remove the entire await line
  if (result.includes("Context.active()")) {
    result = result.replace(
      /(?:const|let)\s+\w+\s*=\s*await\s+Context\.active\(\)\.release\?\.revision\(\);?\s*\n?/g,
      "",
    );
    result = result.replace(
      /Context\.active\(\)\.release\?\.revision\(\)/g,
      '""',
    );
    result = result.replace(
      /^import\s+\{\s*Context\s*\}\s+from\s+["']@deco\/deco["'];?\s*\n?/gm,
      "",
    );
    changed = true;
    notes.push("Removed Context.active().release?.revision()");
  }

  // defineApp wrapper → unwrap to a plain function
  // Matches: export default defineApp(async (_req, ctx) => { ... });
  if (result.includes("defineApp")) {
    result = result.replace(
      /export\s+default\s+defineApp\(\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{/,
      "// NOTE: defineApp removed — this file needs manual conversion to a route\nexport default function AppLayout() {",
    );
    // Remove trailing ); that closed defineApp
    // This is tricky — we'll flag for manual review instead of guessing
    changed = true;
    notes.push(
      "MANUAL: defineApp wrapper partially unwrapped — verify closing brackets",
    );
  }

  // Remove <Head> wrapper — its children should go into route head() config
  // This is complex to do with regex, so we flag it
  if (result.includes("<Head>") || result.includes("<Head ")) {
    notes.push(
      "MANUAL: <Head> component found — move contents to route head() config",
    );
  }

  // Clean up blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return { content: result, changed, notes };
}
