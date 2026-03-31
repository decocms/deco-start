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
  [/^"@preact\/signals-core"$/, `"~/sdk/signal"`],
  [/^"@preact\/signals"$/, `"~/sdk/signal"`],

  // Deco framework
  [/^"@deco\/deco\/hooks"$/, `"@decocms/start/sdk/useScript"`],
  [/^"@deco\/deco\/blocks"$/, `"@decocms/start/types"`],
  [/^"@deco\/deco\/web"$/, null], // runtime.ts is rewritten
  [/^"@deco\/deco"$/, `"@decocms/start"`],

  // Apps — widgets & components
  [/^"apps\/admin\/widgets\.ts"$/, `"@decocms/start/types/widgets"`],
  [/^"apps\/website\/components\/Image\.tsx"$/, `"@decocms/apps/commerce/components/Image"`],
  [/^"apps\/website\/components\/Picture\.tsx"$/, `"@decocms/apps/commerce/components/Picture"`],
  [/^"apps\/website\/components\/Video\.tsx"$/, `"@decocms/apps/commerce/components/Video"`],
  [/^"apps\/website\/components\/Theme\.tsx"$/, `"~/components/ui/Theme"`],
  [/^"apps\/commerce\/types\.ts"$/, `"@decocms/apps/commerce/types"`],

  // Apps — VTEX (hooks, utils, actions, loaders, types)
  [/^"apps\/vtex\/hooks\/([^"]+?)(?:\.ts)?"$/, `"@decocms/apps/vtex/hooks/$1"`],
  [/^"apps\/vtex\/utils\/([^"]+?)(?:\.ts)?"$/, `"@decocms/apps/vtex/utils/$1"`],
  [/^"apps\/vtex\/actions\/([^"]+?)(?:\.ts)?"$/, `"@decocms/apps/vtex/actions/$1"`],
  [/^"apps\/vtex\/loaders\/([^"]+?)(?:\.ts)?"$/, `"@decocms/apps/vtex/loaders/$1"`],
  [/^"apps\/vtex\/types(?:\.ts)?"$/, `"@decocms/apps/vtex/types"`],
  // Apps — Shopify (hooks, utils, actions, loaders)
  [/^"apps\/shopify\/hooks\/([^"]+?)(?:\.ts)?"$/, `"@decocms/apps/shopify/hooks/$1"`],
  [/^"apps\/shopify\/utils\/([^"]+?)(?:\.ts)?"$/, `"@decocms/apps/shopify/utils/$1"`],
  [/^"apps\/shopify\/actions\/([^"]+?)(?:\.ts)?"$/, `"@decocms/apps/shopify/actions/$1"`],
  [/^"apps\/shopify\/loaders\/([^"]+?)(?:\.ts)?"$/, `"@decocms/apps/shopify/loaders/$1"`],
  // Apps — commerce (types, SDK, utils)
  [/^"apps\/commerce\/sdk\/([^"]+?)(?:\.ts)?"$/, `"@decocms/apps/commerce/sdk/$1"`],
  [/^"apps\/commerce\/utils\/([^"]+?)(?:\.ts)?"$/, `"@decocms/apps/commerce/utils/$1"`],

  // Apps — catch-all (things like apps/website/mod.ts, apps/analytics/mod.ts, etc.)
  [/^"apps\/([^"]+)"$/, null], // Remove — site.ts is rewritten

  // Deco old CDN imports
  [/^"deco\/([^"]+)"$/, null],

  // Std lib — not needed in Node (Deno std lib)
  [/^"std\/([^"]+)"$/, null],
  [/^"@std\/crypto"$/, null], // Use globalThis.crypto instead

  // site/sdk/* → framework equivalents (before the catch-all site/ → ~/ rule)
  [/^"site\/sdk\/clx(?:\.tsx?)?.*"$/, `"~/sdk/clx"`],
  [/^"site\/sdk\/useId(?:\.tsx?)?.*"$/, `"react"`],
  [/^"site\/sdk\/useOffer(?:\.tsx?)?.*"$/, `"@decocms/apps/commerce/sdk/useOffer"`],
  [/^"site\/sdk\/useVariantPossiblities(?:\.tsx?)?.*"$/, `"@decocms/apps/commerce/sdk/useVariantPossibilities"`],
  [/^"site\/sdk\/usePlatform(?:\.tsx?)?.*"$/, null],

  // $store/ → ~/ (common Deno import map alias for project root)
  [/^"\$store\/sdk\/clx(?:\.tsx?)?.*"$/, `"~/sdk/clx"`],
  [/^"\$store\/sdk\/useId(?:\.tsx?)?.*"$/, `"react"`],
  [/^"\$store\/sdk\/useOffer(?:\.tsx?)?.*"$/, `"@decocms/apps/commerce/sdk/useOffer"`],
  [/^"\$store\/sdk\/useVariantPossiblities(?:\.tsx?)?.*"$/, `"@decocms/apps/commerce/sdk/useVariantPossibilities"`],
  [/^"\$store\/sdk\/usePlatform(?:\.tsx?)?.*"$/, null],
  [/^"\$store\/(.+)"$/, `"~/$1"`],

  // site/ → ~/
  [/^"site\/(.+)"$/, `"~/$1"`],
];

/**
 * Relative import rewrites for SDK files that are deleted during migration.
 * These are matched against the resolved import path (after ../.. resolution).
 * The key is the ending of the import path, the value is the replacement specifier.
 */
const RELATIVE_SDK_REWRITES: Array<[RegExp, string]> = [
  // sdk/clx → ~/sdk/clx (scaffolded locally with default export)
  [/(?:\.\.\/)*sdk\/clx(?:\.tsx?)?$/, "~/sdk/clx"],
  // sdk/useId → react (useId is built-in in React 19)
  [/(?:\.\.\/)*sdk\/useId(?:\.tsx?)?$/, "react"],
  // sdk/useOffer → @decocms/apps/commerce/sdk/useOffer
  [/(?:\.\.\/)*sdk\/useOffer(?:\.tsx?)?$/, "@decocms/apps/commerce/sdk/useOffer"],
  // sdk/useVariantPossiblities → @decocms/apps/commerce/sdk/useVariantPossibilities
  [/(?:\.\.\/)*sdk\/useVariantPossiblities(?:\.tsx?)?$/, "@decocms/apps/commerce/sdk/useVariantPossibilities"],
  // sdk/usePlatform → remove entirely
  [/(?:\.\.\/)*sdk\/usePlatform(?:\.tsx?)?$/, ""],
  // static/adminIcons → deleted (icon loaders need rewriting)
  [/(?:\.\.\/)*static\/adminIcons(?:\.ts)?$/, ""],
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

  /**
   * Post-process: split @deco/deco/hooks imports.
   * In the old stack, @deco/deco/hooks exported useDevice, useScript, useSection, etc.
   * In @decocms/start, useDevice is at @decocms/start/sdk/useDevice.
   * After import rewriting, we need to split lines like:
   *   import { useDevice, useScript } from "@decocms/start/sdk/useScript"
   * into:
   *   import { useDevice } from "@decocms/start/sdk/useDevice"
   *   import { useScript } from "@decocms/start/sdk/useScript"
   */
  function splitDecoHooksImports(code: string): string {
    return code.replace(
      /^(import\s+(?:type\s+)?\{)([^}]*\buseDevice\b[^}]*)(\}\s+from\s+["']@decocms\/start\/sdk\/useScript["'];?)$/gm,
      (_match, _prefix, importList, _suffix) => {
        const items = importList.split(",").map((s: string) => s.trim()).filter(Boolean);
        const deviceItems = items.filter((s: string) => s.includes("useDevice"));
        const otherItems = items.filter((s: string) => !s.includes("useDevice"));

        const lines: string[] = [];
        if (deviceItems.length > 0) {
          lines.push(`import { ${deviceItems.join(", ")} } from "@decocms/start/sdk/useDevice";`);
        }
        if (otherItems.length > 0) {
          lines.push(`import { ${otherItems.join(", ")} } from "@decocms/start/sdk/useScript";`);
        }
        return lines.join("\n");
      },
    );
  }

  function rewriteSpecifier(specifier: string): string | null {
    // Remove quotes for matching
    const inner = specifier.slice(1, -1);

    for (const [pattern, replacement] of IMPORT_RULES) {
      if (pattern.test(`"${inner}"`)) {
        if (replacement === null) return null;
        // Apply regex replacement
        let result = `"${inner}"`.replace(pattern, replacement);
        // Strip .ts/.tsx extensions from the rewritten path if it's a relative/alias import
        const resultInner = result.slice(1, -1);
        if (
          (resultInner.startsWith("~/") || resultInner.startsWith("./") || resultInner.startsWith("../")) &&
          (resultInner.endsWith(".ts") || resultInner.endsWith(".tsx"))
        ) {
          result = `"${resultInner.replace(/\.tsx?$/, "")}"`;
        }
        return result;
      }
    }

    // Relative imports pointing to deleted SDK files → framework equivalents
    if (inner.startsWith("./") || inner.startsWith("../")) {
      for (const [pattern, replacement] of RELATIVE_SDK_REWRITES) {
        if (pattern.test(inner)) {
          if (replacement === "") return null; // remove the import
          return `"${replacement}"`;
        }
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

  // Split @deco/deco/hooks imports that contain useDevice
  const afterSplit = splitDecoHooksImports(result);
  if (afterSplit !== result) {
    result = afterSplit;
    changed = true;
    notes.push("Split useDevice into separate import from @decocms/start/sdk/useDevice");
  }

  // Rewrite dynamic imports: import("$store/...") and import("site/...")
  const dynamicImportRe = /\bimport\(\s*(["'])(\$store\/|site\/)([^"']+)\1\s*\)/g;
  result = result.replace(dynamicImportRe, (_match, quote, _prefix, rest) => {
    const cleaned = rest.replace(/\.tsx?$/, "");
    changed = true;
    notes.push(`Rewrote dynamic import: ${_prefix}${rest} → ~/${cleaned}`);
    return `import(${quote}~/${cleaned}${quote})`;
  });

  // Clean up blank lines left by removed imports (collapse multiple to one)
  result = result.replace(/\n{3,}/g, "\n\n");

  return { content: result, changed, notes };
}
