import type { TransformResult } from "../types.ts";

/**
 * Fix JSX after scriptAsDataURI → useScript replacement.
 *
 * Transforms patterns like:
 *   <script dangerouslySetInnerHTML={{ __html: useScript(fn, { ...props, x })}
 *     defer
 *   />
 * Into:
 *   <script dangerouslySetInnerHTML={{ __html: useScript(fn, { ...props, x }) }}
 *   />
 *
 * The key issue: the original `src={scriptAsDataURI(...)}` has one closing `}`,
 * but `dangerouslySetInnerHTML={{ __html: useScript(...) }}` needs two closing `}}`.
 * We also need to remove stray attrs like `defer` that sit between the call and `/>`.
 */
function rebalanceScriptDataUri(code: string): string {
  const marker = "dangerouslySetInnerHTML={{ __html: useScript(";
  let idx = code.indexOf(marker);

  while (idx !== -1) {
    const start = idx + marker.length;
    // Find the balanced closing paren for useScript(
    let depth = 1;
    let i = start;
    while (i < code.length && depth > 0) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
      i++;
    }
    // i is now right after the matching ) of useScript(...)
    // We expect `}` next (closing the old src={...})
    // We need to replace everything from ) to /> with `) }} />`
    // and remove any stray attributes like `defer`, `type="module"`, etc.
    const afterParen = code.substring(i);
    const closingMatch = afterParen.match(/^\s*\}\s*\n?\s*([\s\S]*?)\s*\/>/);
    if (closingMatch) {
      const endOffset = i + closingMatch[0].length;
      // i is already past the closing ), so just add the }} and />
      const replacement = ` }}\n    />`;
      code = code.substring(0, i) + replacement + code.substring(endOffset);
    }

    idx = code.indexOf(marker, idx + 1);
  }

  return code;
}

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
  if (/\basset\(/.test(result)) {
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

  // Replace <Head>...</Head> with <>...</>
  // React 19 auto-hoists <title>, <meta>, <link> tags to document <head>.
  if (result.includes("<Head>") || result.includes("<Head ")) {
    // Handle self-closing <Head ... /> first so it becomes <></> (not just <>)
    result = result.replace(/<Head\s[^>]*\/>/g, "<></>");
    result = result.replace(/<Head\s*\/>/g, "<></>");
    result = result.replace(/<Head>/g, "<>");
    result = result.replace(/<Head\s[^>]*>/g, "<>");
    result = result.replace(/<\/Head>/g, "</>");
    changed = true;
    notes.push("Replaced <Head> with fragment — React 19 hoists head tags automatically");
  }

  // scriptAsDataURI → useScript with dangerouslySetInnerHTML
  // scriptAsDataURI is a Fresh pattern that returns a data: URI for <script src=...>.
  // In React/TanStack, useScript returns a string for dangerouslySetInnerHTML.
  //
  // Before: <script src={scriptAsDataURI(fn, arg1, arg2)} defer />
  // After:  <script dangerouslySetInnerHTML={{ __html: useScript(fn, arg1, arg2) }} />
  if (result.includes("scriptAsDataURI")) {
    // Ensure useScript is imported
    if (
      !result.includes('"@decocms/start/sdk/useScript"') &&
      !result.includes("'@decocms/start/sdk/useScript'")
    ) {
      result = `import { useScript } from "@decocms/start/sdk/useScript";\n${result}`;
    }

    // Transform src={scriptAsDataURI(...)} into dangerouslySetInnerHTML={{ __html: useScript(...) }}
    // We need to match balanced parens to capture the full argument list.
    result = result.replace(
      /\bsrc=\{scriptAsDataURI\(/g,
      "dangerouslySetInnerHTML={{ __html: useScript(",
    );

    // Now close the pattern: find the matching )} and replace with ) }}
    // The pattern after replacement is: dangerouslySetInnerHTML={{ __html: useScript(...)}<maybe whitespace and other attrs>
    // We need to find the closing )} that ends the JSX expression
    result = rebalanceScriptDataUri(result);

    // Replace any remaining standalone scriptAsDataURI references
    result = result.replace(/\bscriptAsDataURI\b/g, "useScript");

    changed = true;
    notes.push("Replaced scriptAsDataURI with useScript + dangerouslySetInnerHTML");
  }

  // allowCorsFor — not available in @decocms/start, remove usage
  if (result.includes("allowCorsFor")) {
    result = result.replace(
      /^import\s+\{[^}]*\ballowCorsFor\b[^}]*\}\s+from\s+["'][^"']+["'];?\s*\n?/gm,
      "",
    );
    // Remove allowCorsFor calls
    result = result.replace(/\ballowCorsFor\b\([^)]*\);?\s*\n?/g, "");
    changed = true;
    notes.push("Removed allowCorsFor (not needed in TanStack)");
  }

  // ctx.response.headers → not available, flag
  if (result.includes("ctx.response")) {
    notes.push("MANUAL: ctx.response usage found — FnContext in @decocms/start does not have response object");
  }

  // { crypto } from "@std/crypto" → use globalThis.crypto (Web Crypto API)
  // The import is already removed by imports transform, but `crypto` references
  // need to be prefixed with globalThis if they'd shadow the global
  if (result.match(/^import\s+\{[^}]*\bcrypto\b/m)) {
    // Import already removed by imports transform, so just ensure bare `crypto` works
    // No action needed — globalThis.crypto is available in Workers + Node 20+
    notes.push("INFO: @std/crypto replaced with globalThis.crypto (Web Crypto API)");
  }

  // Clean up blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return { content: result, changed, notes };
}
