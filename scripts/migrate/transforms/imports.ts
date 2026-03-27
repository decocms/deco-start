import type { TransformResult } from "../types.ts";

/**
 * Import rewriting rules: from (Deno/Fresh/Preact) → to (Node/TanStack/React)
 *
 * Order matters: more specific rules should come first.
 */
const IMPORT_RULES: Array<[RegExp, string | null]> = [
  // Fresh — remove entirely (handled by fresh-apis transform)
  [/^"\$fresh\/runtime\.ts"/, null],
  [/^"\$fresh\/server\.ts"/, null],

  // Preact → React
  [/^"preact\/hooks"$/, `"react"`],
  [/^"preact\/jsx-runtime"$/, null],
  [/^"preact\/compat"$/, `"react"`],
  [/^"preact"$/, `"react"`],
  [/^"@preact\/signals-core"$/, null],
  [/^"@preact\/signals"$/, null],

  // Deco framework
  [/^"@deco\/deco\/hooks"$/, `"@decocms/start/sdk/useScript"`],
  [/^"@deco\/deco\/blocks"$/, `"@decocms/start/types"`],
  [/^"@deco\/deco\/web"$/, null], // runtime.ts is rewritten
  [/^"@deco\/deco"$/, `"@decocms/start"`],

  // Apps — widgets & components
  [/^"apps\/admin\/widgets\.ts"$/, `"@decocms/start/admin/widgets"`],
  [/^"apps\/website\/components\/Image\.tsx"$/, `"@decocms/apps/commerce/components/Image"`],
  [/^"apps\/website\/components\/Picture\.tsx"$/, `"@decocms/apps/commerce/components/Picture"`],
  [/^"apps\/website\/components\/Video\.tsx"$/, `"@decocms/apps/commerce/components/Video"`],
  [/^"apps\/commerce\/types\.ts"$/, `"@decocms/apps/commerce/types"`],

  // Apps — catch-all (things like apps/website/mod.ts, apps/vtex/mod.ts, etc.)
  [/^"apps\/([^"]+)"$/, null], // Remove — site.ts is rewritten

  // Deco old CDN imports
  [/^"deco\/([^"]+)"$/, null],

  // Std lib — not needed in Node
  [/^"std\/([^"]+)"$/, null],

  // site/ → ~/
  [/^"site\/(.+)"$/, `"~/$1"`],
];

/**
 * Rewrites import specifiers in a file.
 *
 * Handles:
 * - import X from "old" → import X from "new"
 * - import { X } from "old" → import { X } from "new"
 * - import type { X } from "old" → import type { X } from "new"
 * - export { X } from "old" → export { X } from "new"
 * - import "old" → import "new"
 *
 * When a rule maps to null, the entire import line is removed.
 */
export function transformImports(content: string): TransformResult {
  const notes: string[] = [];
  let changed = false;

  // Match import/export lines with their specifiers
  const importLineRegex =
    /^(import\s+(?:type\s+)?(?:\{[^}]*\}|[\w*]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+)("[^"]+"|'[^']+')(;?\s*)$/gm;
  const reExportLineRegex =
    /^(export\s+(?:type\s+)?\{[^}]*\}\s+from\s+)("[^"]+"|'[^']+')(;?\s*)$/gm;
  const sideEffectImportRegex = /^(import\s+)("[^"]+"|'[^']+')(;?\s*)$/gm;

  function rewriteSpecifier(specifier: string): string | null {
    // Remove quotes for matching
    const inner = specifier.slice(1, -1);

    for (const [pattern, replacement] of IMPORT_RULES) {
      if (pattern.test(`"${inner}"`)) {
        if (replacement === null) return null;
        // Apply regex replacement
        return `"${inner}"`.replace(pattern, replacement);
      }
    }

    // npm: prefix removal
    if (inner.startsWith("npm:")) {
      const cleaned = inner
        .slice(4)
        .replace(/@[\d^~>=<.*]+$/, ""); // strip version
      return `"${cleaned}"`;
    }

    // Strip .ts/.tsx extensions from relative imports
    if (
      (inner.startsWith("./") || inner.startsWith("../") ||
        inner.startsWith("~/")) &&
      (inner.endsWith(".ts") || inner.endsWith(".tsx"))
    ) {
      const stripped = inner.replace(/\.tsx?$/, "");
      return `"${stripped}"`;
    }

    return specifier;
  }

  function processLine(
    _match: string,
    prefix: string,
    specifier: string,
    suffix: string,
  ): string {
    const newSpec = rewriteSpecifier(specifier);
    if (newSpec === null) {
      changed = true;
      notes.push(`Removed import: ${specifier}`);
      return ""; // Remove the line
    }
    if (newSpec !== specifier) {
      changed = true;
      notes.push(`Rewrote: ${specifier} → ${newSpec}`);
      return `${prefix}${newSpec}${suffix}`;
    }
    return `${prefix}${specifier}${suffix}`;
  }

  let result = content;
  result = result.replace(importLineRegex, processLine);
  result = result.replace(reExportLineRegex, processLine);
  result = result.replace(sideEffectImportRegex, processLine);

  // Clean up blank lines left by removed imports (collapse multiple to one)
  result = result.replace(/\n{3,}/g, "\n\n");

  return { content: result, changed, notes };
}
