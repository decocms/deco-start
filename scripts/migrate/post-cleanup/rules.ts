/**
 * Post-migration cleanup audit — rule implementations.
 *
 * Each rule mirrors a section in
 * `.agents/skills/deco-to-tanstack-migration/references/post-migration-cleanup.md`.
 * The intent is to take the human checklist and make it programmatically
 * detectable so future migrations get the same scrubbing automatically.
 *
 * Rules are intentionally read-only here — `--fix` is a follow-up.
 */

import { analyzeFile as analyzeHtmxFile } from "../analyzers/htmx-analyze";
import { classifyShimExports, type ExportClass } from "./shim-classify";
import type { Finding, FixAction, FsWriter, Rule, RuleContext } from "./types";

const SRC_GLOB_EXCLUDES = ["node_modules", "dist", ".wrangler", ".vite", ".tanstack", "build"];

/**
 * Rewrite all `from "<oldSpec>"` (or `from '<oldSpec>'`) imports in
 * `src/**` to `from "<newSpec>"`. Returns the list of site-relative
 * paths actually changed so fix-action summaries can quote a count.
 * Uses the write side of the FS adapter — never touches disk in unit
 * tests.
 *
 * Intentionally string-anchored on the exact spec; will not pick up
 * partial-prefix matches like `~/types/widgets-extra`.
 */
function rewriteImportSpec(
  ctx: RuleContext,
  writer: FsWriter,
  oldSpec: string,
  newSpec: string,
): string[] {
  const { siteDir, fs } = ctx;
  const tsFiles = fs.glob(siteDir, "src/**/*.{ts,tsx}", SRC_GLOB_EXCLUDES);
  const escaped = oldSpec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`from\\s+(['"])${escaped}\\1`, "g");
  const updated: string[] = [];
  for (const abs of tsFiles) {
    const content = fs.readText(abs);
    if (!re.test(content)) {
      re.lastIndex = 0;
      continue;
    }
    re.lastIndex = 0;
    const next = content.replace(re, (_m, q) => `from ${q}${newSpec}${q}`);
    if (next !== content) {
      writer.writeText(abs, next);
      updated.push(abs.slice(siteDir.length + 1));
    }
  }
  return updated;
}

/* ------------------------------------------------------------------ */
/* Rule 1 — dead `src/lib/*` shims                                     */
/* ------------------------------------------------------------------ */

const EXPORT_RE = /^export\s+(?:function|const|interface|type|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

function extractExports(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(EXPORT_RE)) {
    out.push(m[1]);
  }
  return out;
}

function symbolUsedOutsideLib(siteDir: string, fs: RuleContext["fs"], symbol: string): boolean {
  const tsFiles = fs.glob(siteDir, "src/**/*.{ts,tsx}", SRC_GLOB_EXCLUDES);
  const re = new RegExp(`\\b${symbol}\\b`);
  for (const file of tsFiles) {
    if (file.includes("/src/lib/")) continue;
    const content = fs.readText(file);
    if (re.test(content)) return true;
  }
  return false;
}

const ruleDeadLibShims: Rule = {
  id: "dead-lib-shims",
  title: "Dead src/lib/* shims",
  run({ siteDir, fs }: RuleContext): Finding[] {
    const libFiles = fs.glob(siteDir, "src/lib/*.ts", SRC_GLOB_EXCLUDES);
    if (libFiles.length === 0) return [];

    const findings: Finding[] = [];
    for (const abs of libFiles) {
      const rel = abs.slice(siteDir.length + 1);
      const content = fs.readText(abs);
      const exports = extractExports(content);
      if (exports.length === 0) continue;
      const allDead = exports.every((s) => !symbolUsedOutsideLib(siteDir, fs, s));
      if (!allDead) continue;
      findings.push({
        rule: "dead-lib-shims",
        severity: "info",
        file: rel,
        message: `${exports.length} export(s), 0 external imports`,
        fix: `rm ${rel}`,
        meta: { exports },
      });
    }
    return findings;
  },
  applyFix({ siteDir }, findings, writer): FixAction[] {
    const actions: FixAction[] = [];
    for (const f of findings) {
      writer.deleteFile(`${siteDir}/${f.file}`);
      actions.push({
        file: f.file,
        kind: "delete",
        detail: "deleted (all exports verified unused)",
      });
    }
    return actions;
  },
};

/* ------------------------------------------------------------------ */
/* Rule 2 — obsolete inline vite plugins                               */
/* ------------------------------------------------------------------ */

const OBSOLETE_VITE_PLUGINS: { name: string; reason: string }[] = [
  {
    name: "site-manual-chunks",
    reason: "framework's decoVitePlugin() now owns chunking",
  },
  {
    name: "deco-stub-meta-gen",
    reason: "framework now stubs meta.gen.{json,ts} on the client by default",
  },
];

const ruleObsoleteVitePlugins: Rule = {
  id: "obsolete-vite-plugins",
  title: "Obsolete inline Vite plugins",
  run({ siteDir, fs }: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const candidates = ["vite.config.ts", "vite.config.js", "vite.config.mjs"];
    for (const rel of candidates) {
      const abs = `${siteDir}/${rel}`;
      if (!fs.exists(abs)) continue;
      const content = fs.readText(abs);
      for (const plugin of OBSOLETE_VITE_PLUGINS) {
        const re = new RegExp(`name:\\s*["']${plugin.name}["']`);
        if (!re.test(content)) continue;
        findings.push({
          rule: "obsolete-vite-plugins",
          severity: "warning",
          file: rel,
          message: `'${plugin.name}' plugin is obsolete — ${plugin.reason}`,
          fix: `delete the inline '${plugin.name}' plugin from ${rel}`,
          meta: { plugin: plugin.name },
        });
      }
    }
    return findings;
  },
  applyFix({ siteDir, fs }, findings, writer): FixAction[] {
    // Group findings by file so we rewrite each vite.config in one pass.
    const byFile = new Map<string, string[]>();
    for (const f of findings) {
      const plugin = (f.meta?.plugin as string | undefined) ?? "";
      if (!plugin) continue;
      const arr = byFile.get(f.file) ?? [];
      arr.push(plugin);
      byFile.set(f.file, arr);
    }
    const actions: FixAction[] = [];
    for (const [rel, pluginNames] of byFile) {
      const abs = `${siteDir}/${rel}`;
      if (!fs.exists(abs)) continue;
      const before = fs.readText(abs);
      const removed: string[] = [];
      let next = before;
      // Process plugins right-to-left in document order so each removal
      // does not invalidate the indices of the next one.
      const ordered = pluginNames
        .map((name) => ({ name, span: findInlineVitePluginSpan(next, name) }))
        .filter((p): p is { name: string; span: PluginSpan } => p.span !== null)
        .sort((a, b) => b.span.startIdx - a.span.startIdx);
      for (const p of ordered) {
        next = next.slice(0, p.span.startIdx) + next.slice(p.span.endIdx);
        removed.push(p.name);
      }
      if (next !== before) {
        writer.writeText(abs, next);
        actions.push({
          file: rel,
          kind: "rewrite-vite-config",
          detail: `removed obsolete plugin(s): ${removed
            .reverse()
            .join(", ")}`,
        });
      }
    }
    return actions;
  },
};

/**
 * Span of an inline plugin object literal inside vite.config.ts that
 * the auto-fixer should strip. Includes:
 *
 * - `startIdx`: position of the first attached `// ...` line above the
 *   `{`, or the `{` itself if no leading comment is attached. Leading
 *   indentation is included.
 * - `endIdx`: exclusive — points just past the trailing `,\n` (or `\n`
 *   if there's no comma). The next character is the start of the next
 *   plugin (or the closing `]`).
 *
 * Removing `[startIdx, endIdx)` produces a clean diff: comment + literal
 * gone, no orphan separator, surrounding plugins still paired with their
 * own commas / comments.
 */
type PluginSpan = { startIdx: number; endIdx: number };

/**
 * Brace-balanced search for an inline `{ name: "<plugin>", ... }`
 * object literal inside a vite config. Properly skips over strings,
 * template literals, line comments and block comments so it doesn't
 * miscount braces inside e.g. a `config()` body that contains
 * `{ build: { rollupOptions: ... } }` or template-string interpolation.
 *
 * Returns null when the plugin name isn't present, or when we can't
 * walk the braces unambiguously (defensive — the rule's `run()` will
 * still flag the finding for a manual fix).
 */
export function findInlineVitePluginSpan(
  content: string,
  pluginName: string,
): PluginSpan | null {
  const re = new RegExp(`name:\\s*(['"\`])${escapeRegex(pluginName)}\\1`);
  const m = re.exec(content);
  if (!m) return null;
  const namePropIdx = m.index;

  // Walk backwards from the name property to find the enclosing `{`.
  // Track string / comment state so we don't false-match on `{` inside
  // a string literal somewhere earlier in the file.
  const openIdx = findEnclosingObjectOpen(content, namePropIdx);
  if (openIdx < 0) return null;

  // Walk forward from the open brace counting matching braces, again
  // skipping strings / comments. Returns the index of the matching `}`.
  const closeIdx = findMatchingClose(content, openIdx);
  if (closeIdx < 0) return null;

  // Compute trailingEnd: consume `,` (optional) then whitespace up to
  // and including the first `\n` after the closing brace. If we never
  // hit `\n`, just stop at the comma / next non-whitespace.
  let trailingEnd = closeIdx + 1;
  while (
    trailingEnd < content.length &&
    (content[trailingEnd] === " " || content[trailingEnd] === "\t")
  ) {
    trailingEnd++;
  }
  if (content[trailingEnd] === ",") trailingEnd++;
  while (
    trailingEnd < content.length &&
    (content[trailingEnd] === " " || content[trailingEnd] === "\t")
  ) {
    trailingEnd++;
  }
  if (content[trailingEnd] === "\n") trailingEnd++;

  // Compute leadingStart: walk backwards over consecutive `//`-only
  // lines that are immediately attached to the `{` (no blank line
  // between them and the literal). Block comments are left alone.
  const leadingStart = findAttachedLeadingComments(content, openIdx);

  return { startIdx: leadingStart, endIdx: trailingEnd };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Walk backwards from `fromIdx` to find the index of the `{` that
 * opens the object literal currently containing `fromIdx`. Returns
 * -1 if no such `{` is found before the start of the file or if
 * the walk is too ambiguous (mismatched balance).
 *
 * Skips over string, template-literal and comment regions so braces
 * inside those don't affect the count.
 */
function findEnclosingObjectOpen(content: string, fromIdx: number): number {
  // Strategy: scan the file from the start to fromIdx, maintaining a
  // stack of open `{` positions, skipping inside strings/comments.
  // The top of the stack at fromIdx is our enclosing open.
  const stack: number[] = [];
  let i = 0;
  const n = Math.min(content.length, fromIdx);
  while (i < n) {
    const ch = content[i];
    const next = content[i + 1];
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && content[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(content[i] === "*" && content[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < n && content[i] !== quote) {
        if (content[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "`") {
      i++;
      while (i < n && content[i] !== "`") {
        if (content[i] === "\\") {
          i += 2;
          continue;
        }
        if (content[i] === "$" && content[i + 1] === "{") {
          i += 2;
          // Recursively skip until matching `}` of the interpolation.
          let depth = 1;
          while (i < n && depth > 0) {
            if (content[i] === "{") depth++;
            else if (content[i] === "}") depth--;
            if (depth === 0) break;
            i++;
          }
        }
        i++;
      }
      i++;
      continue;
    }
    if (ch === "{") {
      stack.push(i);
      i++;
      continue;
    }
    if (ch === "}") {
      stack.pop();
      i++;
      continue;
    }
    i++;
  }
  return stack.length > 0 ? stack[stack.length - 1] : -1;
}

/**
 * From the `{` at `openIdx`, walk forward to find the matching `}`.
 * Skips strings / template literals / comments.
 */
function findMatchingClose(content: string, openIdx: number): number {
  let i = openIdx + 1;
  let depth = 1;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    const next = content[i + 1];
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && content[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(content[i] === "*" && content[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < n && content[i] !== quote) {
        if (content[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "`") {
      i++;
      while (i < n && content[i] !== "`") {
        if (content[i] === "\\") {
          i += 2;
          continue;
        }
        if (content[i] === "$" && content[i + 1] === "{") {
          i += 2;
          let d = 1;
          while (i < n && d > 0) {
            if (content[i] === "{") d++;
            else if (content[i] === "}") d--;
            if (d === 0) break;
            i++;
          }
        }
        i++;
      }
      i++;
      continue;
    }
    if (ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Walk backwards from `openIdx` consuming the contiguous block of
 * `//`-only lines immediately preceding the `{`. Stops at the first
 * blank line, the first non-comment line, or block-comment territory.
 * Returns the absolute index where the leading comment block (plus
 * its indentation) starts — equal to `openIdx` minus its own line's
 * indentation when no comment is attached.
 */
function findAttachedLeadingComments(content: string, openIdx: number): number {
  // Walk back to start of the line containing `{`.
  let lineStart = openIdx;
  while (lineStart > 0 && content[lineStart - 1] !== "\n") lineStart--;
  // Now climb up: each iteration considers the line ending at
  // `lineStart - 1`. If it is a `//`-only line, include it; else stop.
  let cursor = lineStart;
  while (cursor > 0) {
    const prevLineEnd = cursor - 1; // index of the `\n` separating
    if (prevLineEnd <= 0) break;
    let prevLineStart = prevLineEnd;
    while (prevLineStart > 0 && content[prevLineStart - 1] !== "\n") {
      prevLineStart--;
    }
    const line = content.slice(prevLineStart, prevLineEnd);
    if (/^\s*\/\/.*$/.test(line)) {
      cursor = prevLineStart;
      continue;
    }
    break;
  }
  return cursor;
}

/* ------------------------------------------------------------------ */
/* Rule 3 — dead `src/runtime.ts` invoke shim                          */
/* ------------------------------------------------------------------ */

/**
 * Detection covers two shapes of `src/runtime.ts`:
 *
 * 1. Legacy inline proxy (pre-Wave 15-A migration template) — defines
 *    `createNestedInvokeProxy` plus `invoke` and `Runtime` constants.
 *    The whole 40-50 LOC body duplicates `@decocms/start/sdk`'s `invoke`.
 *
 * 2. Simple re-export shim — the file only re-exports `invoke` /
 *    `createNestedInvokeProxy` (no inline proxy body, but also not yet
 *    pointing at `@decocms/start/sdk`).
 *
 * Both should be replaced with `import { invoke } from "@decocms/start/sdk"`
 * at every callsite, and the file deleted. The Wave 15-A migration template
 * scaffolds a thin re-export form that's also acceptable (re-exports
 * `invoke` from `@decocms/start/sdk` and rebuilds `Runtime = { invoke }`);
 * we explicitly skip it via the "imports invoke from @decocms/start/sdk
 * AND no inline proxy" check below.
 */
const INLINE_PROXY_RE =
  /(?:function|const)\s+createNestedInvokeProxy\b|new\s+Proxy\s*\(\s*Object\.assign\s*\(\s*async\s*\(\s*props/;
const FRAMEWORK_INVOKE_IMPORT_RE =
  /import\s+\{[^}]*\binvoke\b[^}]*\}\s+from\s+['"]@decocms\/start(?:\/sdk)?['"]/;

const ALLOWED_RUNTIME_EXPORTS = new Set(["invoke", "createNestedInvokeProxy", "Runtime"]);

const ruleDeadRuntimeShim: Rule = {
  id: "dead-runtime-shim",
  title: "Dead src/runtime.ts invoke shim",
  run({ siteDir, fs }: RuleContext): Finding[] {
    const abs = `${siteDir}/src/runtime.ts`;
    if (!fs.exists(abs)) return [];
    const content = fs.readText(abs);

    const hasInlineProxy = INLINE_PROXY_RE.test(content);
    const reExportsFromFramework = FRAMEWORK_INVOKE_IMPORT_RE.test(content);
    const exports = extractExports(content);
    const onlyKnownInvokeExports =
      exports.length > 0 && exports.every((e) => ALLOWED_RUNTIME_EXPORTS.has(e));

    // Wave 15-A canonical template: re-exports invoke from @decocms/start/sdk
    // and exposes `Runtime = { invoke }` for legacy callers. No inline proxy
    // body. This is the desired shape — skip.
    if (reExportsFromFramework && !hasInlineProxy) return [];

    // Site-specific helpers alongside invoke: don't flag — the file has its
    // own purpose beyond shimming. (Old behavior preserved.)
    if (!hasInlineProxy && !onlyKnownInvokeExports) return [];

    const exportSummary = exports.length > 0 ? exports.join(", ") : "(re-exports only)";
    const flavor = hasInlineProxy ? "inline createNestedInvokeProxy body" : "shim re-exports";
    // Only safe to auto-delete when exports are pure invoke surface; if a
    // legacy file mixes the inline proxy with custom helpers, we still flag
    // it but skip the destructive fix.
    const safeToAutoFix = onlyKnownInvokeExports;

    return [
      {
        rule: "dead-runtime-shim",
        severity: "info",
        file: "src/runtime.ts",
        message: safeToAutoFix
          ? `${flavor} [${exportSummary}] — replace with @decocms/start/sdk`
          : `${flavor} [${exportSummary}] — manual review: file mixes the runtime proxy with site-specific exports`,
        fix: safeToAutoFix
          ? 'rg -l "from \\"~/runtime\\"" src/ | xargs sed -i \'\' \'s|from "~/runtime"|from "@decocms/start/sdk"|g\' && rm src/runtime.ts'
          : "Move the inline `createNestedInvokeProxy` body to call @decocms/start/sdk's `invoke`; relocate site-specific helpers to a dedicated module before deleting src/runtime.ts",
        meta: {
          hasInlineProxy,
          exports,
          safeToAutoFix,
        },
      },
    ];
  },
  applyFix(ctx, findings, writer): FixAction[] {
    if (findings.length === 0) return [];
    // Honor the per-finding safety gate emitted by run() — never auto-delete
    // a runtime.ts that mixes the proxy with site-specific helpers.
    const safe = findings.every((f) => f.meta?.safeToAutoFix !== false);
    if (!safe) return [];
    const updated = rewriteImportSpec(ctx, writer, "~/runtime", "@decocms/start/sdk");
    writer.deleteFile(`${ctx.siteDir}/src/runtime.ts`);
    return [
      {
        file: "src/runtime.ts",
        kind: "rewrite-imports+delete",
        detail: `rewrote ${updated.length} import(s) → @decocms/start/sdk and deleted src/runtime.ts`,
      },
    ];
  },
};

/* ------------------------------------------------------------------ */
/* Rule 4 — site-local `withSiteGlobals` workaround                    */
/* ------------------------------------------------------------------ */

const ruleSiteLocalGlobals: Rule = {
  id: "site-local-with-globals",
  title: "Site-local withSiteGlobals wrapper",
  run({ siteDir, fs }: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const candidates = fs.glob(siteDir, "src/**/withSiteGlobals.ts", SRC_GLOB_EXCLUDES);
    for (const abs of candidates) {
      const content = fs.readText(abs);
      // Heuristic: any local definition (function/const) of withSiteGlobals or
      // cmsRouteWithGlobals indicates a local wrapper, not a re-export from
      // the framework. The framework version would just re-export.
      const definesWrapper =
        /(?:export\s+)?(?:function|const)\s+(?:withSiteGlobals|cmsRouteWithGlobals)\b/.test(
          content,
        );
      const reExportsFromFramework = /from\s+['"]@decocms\/start\/routes['"]/.test(content);
      if (!definesWrapper || reExportsFromFramework) continue;
      const rel = abs.slice(siteDir.length + 1);
      const lineCount = content.split("\n").length;
      findings.push({
        rule: "site-local-with-globals",
        severity: "warning",
        file: rel,
        message: `Local wrapper (~${lineCount} LOC) — framework now exports withSiteGlobals from @decocms/start/routes`,
        fix: "delete the local wrapper and import { withSiteGlobals } from '@decocms/start/routes'",
        meta: { lineCount },
      });
    }
    return findings;
  },
};

/* ------------------------------------------------------------------ */
/* Rule 5 — `~/lib/vtex-*` shim regression                             */
/* ------------------------------------------------------------------ */

/**
 * Per-symbol guidance for the canonical replacement of each known
 * shim stub. Used by the `vtex-shim-regression` rule to compose
 * actionable `fix:` messages instead of the generic "Repoint imports"
 * fallback.
 *
 * Kept as data (not code) so the JSON output of the audit can carry
 * structured fix metadata for downstream tooling (CI dashboards,
 * follow-up auto-fix rules, etc.).
 *
 * Categories:
 * - `swap`: 1:1 import swap is safe — caller imports the symbol from
 *   `canonical` instead of the local shim. Note may flag a signature
 *   gotcha that the caller has to address at the call site.
 * - `refactor`: a call-site rewrite is required (typically because the
 *   stub's "bag-based" API has no analog on TanStack Start; the request
 *   headers are the new source of truth). The note explains the pattern.
 *
 * Symbols absent from this table fall back to the generic guidance.
 * The rule still flags them — only the `fix:` prose changes.
 */
export type FixHint =
  | { kind: "swap"; canonical: string; note?: string }
  | { kind: "refactor"; note: string };

export const STUB_FIX_HINTS: Record<string, FixHint> = {
  // src/lib/vtex-transform
  toProduct: {
    kind: "swap",
    canonical: "@decocms/apps/vtex/utils/transform",
    note:
      "canonical signature is `toProduct(product, sku, level, options)`; " +
      "1-arg call sites need to expand args first — see skill § 5",
  },
  // src/lib/vtex-segment
  getSegmentFromBag: {
    kind: "refactor",
    note:
      "read cookies via `request.headers.get('cookie')` then call " +
      "`buildSegmentFromCookies()` from '@decocms/apps/vtex/utils/segment'. " +
      "The bag-based lookup mechanism does not exist on TanStack Start.",
  },
  withSegmentCookie: {
    kind: "swap",
    canonical: "@decocms/apps/vtex/utils/segment",
    note:
      "canonical signature is `withSegmentCookie(segment, headers?)`; " +
      "if you currently pass only headers, also pass a segment object",
  },
  // src/lib/vtex-intelligent-search
  getISCookiesFromBag: {
    kind: "refactor",
    note:
      "extract IS cookies from `request.headers.get('cookie')` directly. " +
      "The bag-based lookup mechanism does not exist on TanStack Start.",
  },
};

/**
 * Format a single symbol's fix guidance as a one-liner suitable for
 * the audit's `fix:` field. Returns undefined when the symbol has no
 * specific entry in `STUB_FIX_HINTS`.
 */
export function formatFixHint(symbol: string): string | undefined {
  const hint = STUB_FIX_HINTS[symbol];
  if (!hint) return undefined;
  if (hint.kind === "swap") {
    const head = `${symbol} → ${hint.canonical} (1:1 import swap)`;
    return hint.note ? `${head} — ${hint.note}` : head;
  }
  return `${symbol} → call-site refactor: ${hint.note}`;
}

/**
 * Compose the `fix:` message for a finding from the per-shim stub map.
 * Splits symbols into "have specific guidance" vs "fall back to generic".
 * Output joins each piece with ` | ` so the message stays one logical
 * line even when there are several stubs.
 */
export function buildVtexShimFixMessage(stubsBySim: Map<string, string[]>): string {
  const known: string[] = [];
  const unknown: string[] = [];
  for (const syms of stubsBySim.values()) {
    for (const s of syms) {
      const hint = formatFixHint(s);
      if (hint) known.push(hint);
      else unknown.push(s);
    }
  }
  const parts: string[] = [...known];
  if (unknown.length > 0) {
    parts.push(
      `${unknown.join(", ")} → repoint to '@decocms/apps/vtex/...' or 'apps/commerce/utils/...'`,
    );
  }
  return parts.length > 0
    ? parts.join(" | ")
    : "Repoint imports to '@decocms/apps/vtex/...' or 'apps/commerce/utils/...'";
}

/**
 * Build the structured `fixHints` payload for `meta` so JSON consumers
 * (CI dashboards, follow-up tooling) can render their own UI. Each
 * entry is keyed by symbol; symbols without specific guidance are
 * omitted (the prose fallback covers them).
 */
function fixHintsToMeta(stubsBySim: Map<string, string[]>): Record<string, FixHint> {
  const out: Record<string, FixHint> = {};
  for (const syms of stubsBySim.values()) {
    for (const s of syms) {
      const hint = STUB_FIX_HINTS[s];
      if (hint) out[s] = hint;
    }
  }
  return out;
}

/**
 * Parse one or more ES `import { a, b as c, type d } from "spec"` blocks
 * targeting a specific source spec out of a file. Returns the list of
 * imported names (resolved to their original symbol, ignoring `as`
 * rebinds), with `import type {…}` and inline `type` modifiers stripped
 * — those carry no runtime, so the rule treats them as out-of-scope.
 */
function namedRuntimeImportsFrom(content: string, spec: string): string[] {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `(type\s+)?` captures the entire-import `import type { … }` form.
  // Per-symbol `type` modifiers inside the braces are stripped below.
  const re = new RegExp(
    `import\\s+(type\\s+)?\\{([^}]+)\\}\\s+from\\s+['\"]${escaped}['\"]`,
    "g",
  );
  const out: string[] = [];
  for (const m of content.matchAll(re)) {
    if (m[1]) continue; // entire import is type-only
    for (const raw of m[2].split(",")) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("type ")) continue;
      // `foo as bar` → `foo` (we want the source symbol, not the local alias).
      const sourceName = trimmed.split(/\s+as\s+/)[0].trim();
      if (sourceName) out.push(sourceName);
    }
  }
  return out;
}

const ruleVtexShimRegression: Rule = {
  id: "vtex-shim-regression",
  title: "Imports from ~/lib/vtex-* (silent stub regression)",
  run({ siteDir, fs }: RuleContext): Finding[] {
    const tsFiles = fs.glob(siteDir, "src/**/*.{ts,tsx}", SRC_GLOB_EXCLUDES);
    const findings: Finding[] = [];

    // Per-shim classification cache. Each shim file is read at most once
    // per audit run, even when imported by dozens of consumers.
    const shimClasses = new Map<string, Map<string, ExportClass>>();
    function classOf(shim: string, symbol: string): ExportClass {
      let map = shimClasses.get(shim);
      if (!map) {
        const abs = `${siteDir}/src/lib/${shim}.ts`;
        map = new Map<string, ExportClass>();
        if (fs.exists(abs)) {
          for (const ce of classifyShimExports(fs.readText(abs))) {
            map.set(ce.name, ce.class);
          }
        }
        shimClasses.set(shim, map);
      }
      // Unknown symbols (file missing or not exported) default to "stub" —
      // pessimistic on purpose. If the symbol can't be found locally, the
      // import is at best dead code, at worst a TS error; either way the
      // user wants visibility into it. Compile phase catches the TS side.
      return map.get(symbol) ?? "stub";
    }

    // Match the bare `from "~/lib/vtex-X"` to know which shims are touched.
    const fromRe = /from\s+['"]~\/lib\/vtex-([A-Za-z0-9-]+)['"]/g;
    for (const abs of tsFiles) {
      if (abs.includes("/src/lib/")) continue;
      const content = fs.readText(abs);
      const usedShims = new Set<string>(
        [...content.matchAll(fromRe)].map((m) => `vtex-${m[1]}`),
      );
      if (usedShims.size === 0) continue;

      // Per-file: which shim → which stub symbols are imported.
      const stubsBySim = new Map<string, string[]>();
      for (const shim of usedShims) {
        const symbols = namedRuntimeImportsFrom(content, `~/lib/${shim}`);
        const stubs = symbols.filter((s) => classOf(shim, s) === "stub");
        if (stubs.length > 0) stubsBySim.set(shim, stubs);
      }
      if (stubsBySim.size === 0) continue;

      const rel = abs.slice(siteDir.length + 1);
      const detail = [...stubsBySim.entries()]
        .map(([s, syms]) => `${s} (${syms.join(", ")})`)
        .join("; ");
      const fixHintsMeta = fixHintsToMeta(stubsBySim);
      findings.push({
        rule: "vtex-shim-regression",
        severity: "warning",
        file: rel,
        message: `Imports stub-only symbols from ${detail} — runtime is silently stubbed`,
        fix: buildVtexShimFixMessage(stubsBySim),
        meta: {
          stubsBySim: Object.fromEntries(stubsBySim),
          ...(Object.keys(fixHintsMeta).length > 0 ? { fixHints: fixHintsMeta } : {}),
        },
      });
    }
    return findings;
  },
  applyFix({ siteDir, fs }, findings, writer): FixAction[] {
    if (findings.length === 0) return [];
    const actions: FixAction[] = [];

    // Per-file rewrite. Conservative: only swap the import path when EVERY
    // imported symbol from the shim is a `kind: "swap"` hint pointing at
    // the same canonical module. Mixed surfaces (some swap + some
    // refactor, or a real impl + a stub) stay untouched — those need a
    // human looking at call-site signatures.
    for (const finding of findings) {
      const stubsBySim = (finding.meta?.stubsBySim ?? {}) as Record<string, string[]>;
      const abs = `${siteDir}/${finding.file}`;
      if (!fs.exists(abs)) continue;

      let content = fs.readText(abs);
      let modified = false;

      for (const [shim, _stubSyms] of Object.entries(stubsBySim)) {
        const oldSpec = `~/lib/${shim}`;
        const importedSymbols = namedRuntimeImportsFrom(content, oldSpec);
        if (importedSymbols.length === 0) continue;

        // Every imported symbol must be a swap-kind hint AND every hint
        // must point at the same canonical module — otherwise we'd
        // either drop a real impl or split the import across two paths,
        // both of which are unsafe to do mechanically here.
        const hints = importedSymbols.map((s) => STUB_FIX_HINTS[s]);
        const allSwap = hints.every((h) => h && h.kind === "swap");
        if (!allSwap) continue;
        const targets = new Set(
          hints.map((h) => (h as { kind: "swap"; canonical: string }).canonical),
        );
        if (targets.size !== 1) continue;
        const target = [...targets][0];

        const escaped = oldSpec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const importLineRe = new RegExp(`from\\s+(['"])${escaped}\\1`, "g");
        const next = content.replace(importLineRe, (_m, q) => `from ${q}${target}${q}`);
        if (next !== content) {
          content = next;
          modified = true;
          actions.push({
            file: finding.file,
            kind: "rewrite-imports",
            detail: `${oldSpec} → ${target} (${importedSymbols.join(", ")})`,
          });
        }
      }

      if (modified) writer.writeText(abs, content);
    }

    return actions;
  },
};

/* ------------------------------------------------------------------ */
/* Rule 6 — local `src/types/widgets.ts` shadowing framework           */
/* ------------------------------------------------------------------ */

const ruleLocalWidgetsTypes: Rule = {
  id: "local-widgets-types",
  title: "Local src/types/widgets.ts shadowing framework",
  run({ siteDir, fs }: RuleContext): Finding[] {
    const abs = `${siteDir}/src/types/widgets.ts`;
    if (!fs.exists(abs)) return [];
    const tsFiles = fs.glob(siteDir, "src/**/*.{ts,tsx}", SRC_GLOB_EXCLUDES);
    const re = /from\s+['"]~\/types\/widgets['"]/;
    let importCount = 0;
    for (const f of tsFiles) {
      if (f === abs) continue;
      if (re.test(fs.readText(f))) importCount++;
    }
    return [
      {
        rule: "local-widgets-types",
        severity: "info",
        file: "src/types/widgets.ts",
        message: `Local file shadows @decocms/start/types/widgets (used in ${importCount} place(s))`,
        fix: 'rewrite imports to "@decocms/start/types/widgets" and rm src/types/widgets.ts',
        meta: { importCount },
      },
    ];
  },
  applyFix(ctx, findings, writer): FixAction[] {
    if (findings.length === 0) return [];
    const updated = rewriteImportSpec(
      ctx,
      writer,
      "~/types/widgets",
      "@decocms/start/types/widgets",
    );
    writer.deleteFile(`${ctx.siteDir}/src/types/widgets.ts`);
    return [
      {
        file: "src/types/widgets.ts",
        kind: "rewrite-imports+delete",
        detail: `rewrote ${updated.length} import(s) → @decocms/start/types/widgets and deleted src/types/widgets.ts`,
      },
    ];
  },
};

/* ------------------------------------------------------------------ */
/* Rule 7 — orphan "TODO: framework" comments                          */
/* ------------------------------------------------------------------ */

const ruleFrameworkTodos: Rule = {
  id: "framework-todos",
  title: "Orphan TODOs deferring to the framework",
  run({ siteDir, fs }: RuleContext): Finding[] {
    const tsFiles = [
      ...fs.glob(siteDir, "src/**/*.{ts,tsx}", SRC_GLOB_EXCLUDES),
      ...fs.glob(siteDir, "vite.config.ts", SRC_GLOB_EXCLUDES),
    ];
    const findings: Finding[] = [];
    const re = /TODO[^\n]*?(?:deco|framework|move into)/i;
    for (const abs of tsFiles) {
      const content = fs.readText(abs);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        const rel = abs.slice(siteDir.length + 1);
        findings.push({
          rule: "framework-todos",
          severity: "info",
          file: `${rel}:${i + 1}`,
          message: lines[i].trim().slice(0, 120),
          fix: "Triage: shipped → adopt; deferred → file issue; obsolete → delete",
        });
      }
    }
    return findings;
  },
};

/* ------------------------------------------------------------------ */
/* Rule — `local-framework-duplicate` — site-local copy of fwk code   */
/* ------------------------------------------------------------------ */

/**
 * Registry of files we expect sites to NOT carry locally because the
 * canonical implementation already lives in `@decocms/start` (or a
 * sibling apps package).
 *
 * Two flavours:
 *  - `safeToAutoFix: true`  — site file is a behaviour-equivalent dup
 *    of the framework export. `--fix` rewrites every `from "~/<path>"`
 *    importer to `from "<canonicalImport>"` and deletes the file.
 *  - `safeToAutoFix: false` — site file *overlaps* with framework code
 *    but isn't a clean drop-in (different typing, partial coverage,
 *    stricter behaviour, etc.). The rule still flags it so the entry
 *    surfaces in audits, but never deletes — the `reason` explains why
 *    a human has to make the call.
 *
 * `contentSignature` regexes ALL must match the site file's contents
 * before the rule fires. They are deliberately specific enough to
 * avoid catching forks that happen to share a filename but have
 * diverged.
 */
interface FrameworkDuplicate {
  /** Stable id surfaced in finding meta and CLI/JSON output. */
  id: string;
  /** Site-relative path of the duplicated file (e.g. "src/sdk/clx.ts"). */
  sitePath: string;
  /** Canonical import to rewrite to. */
  canonicalImport: string;
  /**
   * Heuristic content fingerprint. The site file must match every
   * regex for the rule to consider it the framework dup.
   */
  contentSignature: RegExp[];
  /**
   * When true, the rule's `applyFix` will rewrite all importers and
   * delete the file. When false, the rule emits a warning only —
   * `reason` explains the manual judgement required.
   */
  safeToAutoFix: boolean;
  /**
   * Required when `safeToAutoFix: false`. Surfaces in the finding's
   * `fix:` field so users see *why* the auto-fix is gated.
   */
  reason?: string;
  /**
   * Human-readable one-liner shown in the finding message and used
   * to compose the `fix:` hint when auto-fixable.
   */
  description: string;
}

/**
 * Add an entry here when:
 *  - 1+ migrated sites carry their own copy of code that already
 *    exists in `@decocms/start` (or a sibling apps package), AND
 *  - the canonical version is at least feature-equivalent.
 *
 * Per D4 in the migration tooling policy, the framework promotion
 * itself happens at 3+ sites — but once promoted, this registry is
 * how we *enforce* convergence on the remaining sites.
 */
export const FRAMEWORK_DUPLICATES: FrameworkDuplicate[] = [
  {
    id: "clx",
    sitePath: "src/sdk/clx.ts",
    canonicalImport: "@decocms/start/sdk/clx",
    contentSignature: [
      /export\s+const\s+clx\s*=/,
      /args\.filter\(Boolean\)\.join/,
    ],
    safeToAutoFix: true,
    description: "src/sdk/clx.ts duplicates @decocms/start/sdk/clx",
  },
  {
    id: "use-send-event",
    sitePath: "src/sdk/useSendEvent.ts",
    canonicalImport: "@decocms/start/sdk/analytics",
    contentSignature: [
      /export\s+(?:const|function)\s+useSendEvent/,
      /data-event/,
      /encodeURIComponent/,
    ],
    safeToAutoFix: false,
    reason:
      "site copy uses a typed AnalyticsEvent generic; the framework export is permissive. " +
      "Replacing 1:1 weakens type-safety. Either widen the framework export (preferred), or " +
      "rewrite call sites to drop the generic. Manual review required.",
    description:
      "src/sdk/useSendEvent.ts overlaps with @decocms/start/sdk/analytics → useSendEvent",
  },
  {
    id: "location-matcher",
    sitePath: "src/matchers/location.ts",
    canonicalImport: "@decocms/start/matchers/builtins",
    contentSignature: [
      /registerMatcher\(\s*['"]website\/matchers\/location\.ts['"]/,
      /__cf_geo/,
    ],
    safeToAutoFix: false,
    reason:
      "framework's registerBuiltinMatchers() ships a richer location matcher (request.cf + " +
      "geo cookies + headers + 10 sibling matchers). Adopting it changes behaviour: " +
      "verify country-name lookup parity (resolveCountryCode vs site's inline table) and " +
      "swap setup.ts's customMatchers entry to call registerBuiltinMatchers().",
    description:
      "src/matchers/location.ts overlaps with @decocms/start/matchers/builtins → registerBuiltinMatchers()",
  },
  {
    id: "url-relative",
    sitePath: "src/sdk/url.ts",
    canonicalImport: "@decocms/apps/commerce/sdk/url",
    // Fingerprint: site fork carries a positional `removeIdSku?: boolean`
    // flag + hardcoded VTEX-specific keys (`idsku`, `skuId`). Canonical
    // apps export uses an options object — `{ stripSearchParams: string[] }`
    // — which is generic and platform-agnostic.
    contentSignature: [
      /export\s+const\s+relative\s*=/,
      /removeIdSku\s*\?\s*:\s*boolean/,
      /['"](idsku|skuId)['"]/,
    ],
    safeToAutoFix: false,
    reason:
      "rewrite imports to '@decocms/apps/commerce/sdk/url'. " +
      "Each call site using the boolean form `relative(url, true)` becomes " +
      "`relative(url, { stripSearchParams: [\"idsku\", \"skuId\"] })`. " +
      "1-arg calls are unchanged. Then delete src/sdk/url.ts. " +
      "Auto-fix is gated because the call-site rewrite needs JSX/TS-aware " +
      "transformation (positional bool → options object), not pure import " +
      "rewrite.",
    description:
      "src/sdk/url.ts overlaps with @decocms/apps/commerce/sdk/url → relative() (extended in @decocms/apps@1.9+)",
  },
  {
    id: "use-suggestions",
    sitePath: "src/sdk/useSuggestions.ts",
    canonicalImport: "@decocms/start/sdk/useSuggestions",
    // Fingerprint: hand-rolled hook with the module-level signal +
    // serial-queue + latestQuery cancel pattern. Both casaevideo and
    // baggagio independently invented this exact shape. Sites that
    // already adopted `createUseSuggestions(…)` factory calls won't
    // match this signature.
    contentSignature: [
      /export\s+const\s+useSuggestions\s*=/,
      /\/deco\/invoke\//,
      /latestQuery/,
    ],
    safeToAutoFix: false,
    reason:
      "rewrite to a 5-line factory shim: " +
      "`export const { useSuggestions } = createUseSuggestions<MySuggestion>({ onError });` " +
      "where MySuggestion is the site's payload type. The call sites " +
      "(`const { setQuery, payload, loading } = useSuggestions(loader)`) are unchanged. " +
      "Then delete src/sdk/useSuggestions.ts. Auto-fix is gated because " +
      "the per-site type parameter and onError wiring need site-specific " +
      "decisions. See references/platform-hooks-factories.md § useSuggestions.",
    description:
      "src/sdk/useSuggestions.ts duplicates @decocms/start/sdk/useSuggestions → createUseSuggestions() (added in @decocms/start@2.25+)",
  },
];

const ruleLocalFrameworkDuplicate: Rule = {
  id: "local-framework-duplicate",
  title: "Site-local copy of framework code",
  run({ siteDir, fs }: RuleContext): Finding[] {
    const findings: Finding[] = [];
    for (const dup of FRAMEWORK_DUPLICATES) {
      const abs = `${siteDir}/${dup.sitePath}`;
      if (!fs.exists(abs)) continue;
      const content = fs.readText(abs);
      const matchesAll = dup.contentSignature.every((re) => re.test(content));
      if (!matchesAll) continue;

      const fixMessage = dup.safeToAutoFix
        ? `Auto-fixable: rewrite \`from "~/${stripExt(dup.sitePath.replace(/^src\//, ""))}"\` → \`from "${dup.canonicalImport}"\` and delete ${dup.sitePath}.`
        : dup.reason ?? "Manual review required.";

      findings.push({
        rule: "local-framework-duplicate",
        severity: "warning",
        file: dup.sitePath,
        message: `${dup.description}${dup.safeToAutoFix ? " (pure dup)" : " (partial overlap)"}`,
        fix: fixMessage,
        meta: {
          id: dup.id,
          canonicalImport: dup.canonicalImport,
          safeToAutoFix: dup.safeToAutoFix,
          ...(dup.reason ? { reason: dup.reason } : {}),
        },
      });
    }
    return findings;
  },
  applyFix(ctx, findings, writer): FixAction[] {
    const actions: FixAction[] = [];
    for (const f of findings) {
      const id = f.meta?.id as string | undefined;
      const safe = f.meta?.safeToAutoFix === true;
      if (!safe || !id) continue;
      const dup = FRAMEWORK_DUPLICATES.find((d) => d.id === id);
      if (!dup) continue;

      const siteImportSpec = `~/${stripExt(dup.sitePath.replace(/^src\//, ""))}`;
      const updated = rewriteImportSpec(
        ctx,
        writer,
        siteImportSpec,
        dup.canonicalImport,
      );
      writer.deleteFile(`${ctx.siteDir}/${dup.sitePath}`);
      actions.push({
        file: dup.sitePath,
        kind: "rewrite-imports+delete",
        detail: `rewrote ${updated.length} import(s) "${siteImportSpec}" → "${dup.canonicalImport}" and deleted ${dup.sitePath}`,
      });
    }
    return actions;
  },
};

function stripExt(path: string): string {
  return path.replace(/\.(ts|tsx|js|jsx|mjs)$/, "");
}

/* ------------------------------------------------------------------ */
/* Rule 8 — `htmx-residue` — leftover hx-* attrs in migrated src/      */
/* ------------------------------------------------------------------ */

/**
 * Per D2 in the migration tooling policy, every `hx-*` attribute is
 * rewritten on migration; nothing in `@decocms/start` ships an htmx
 * runtime. This rule is the verification gate: a migrated site is
 * "rewrite-complete" when there are zero `hx-*` attributes left in
 * `src/`.
 *
 * Implementation reuses the htmx analyzer (`analyzeFile` from
 * `analyzers/htmx-analyze.ts`) so categorisation and the JSX walker
 * stay consistent with the standalone `deco-htmx-analyze` CLI. The
 * rule restricts to `src/**` (the migrated React tree) and excludes
 * test files — tests are allowed to mention `hx-*` for fixtures or
 * regression checks.
 *
 * Severity is `warning`, so `--strict` exits 2 on any finding. The
 * rule is intentionally detect-only: rewrites are non-mechanical
 * (state machine + sub-route + mutation choices vary per call site)
 * — the
 * `references/htmx-rewrite.md` skill is the playbook.
 */
const ruleHtmxResidue: Rule = {
  id: "htmx-residue",
  title: "HTMX residue in migrated src/",
  run({ siteDir, fs }: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const tsFiles = fs.glob(siteDir, "src/**/*.{ts,tsx}", SRC_GLOB_EXCLUDES);
    for (const abs of tsFiles) {
      const rel = abs.slice(siteDir.length + 1);
      // Skip test files — tests legitimately reference hx-* in fixtures
      // or regression checks. Same exclusion shape as vitest's default.
      if (/\.(test|spec)\.(ts|tsx)$/.test(rel)) continue;
      if (rel.startsWith("src/__tests__/") || rel.includes("/__tests__/")) {
        continue;
      }
      const content = fs.readText(abs);
      const occurrences = analyzeHtmxFile(rel, content);
      if (occurrences.length === 0) continue;

      // Aggregate per-file: total + categories present.
      const byCat = new Map<string, number>();
      for (const occ of occurrences) {
        byCat.set(occ.category, (byCat.get(occ.category) ?? 0) + 1);
      }
      const catSummary = [...byCat.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cat, n]) => `${cat}=${n}`)
        .join(", ");
      const firstLine = occurrences[0].line;

      findings.push({
        rule: "htmx-residue",
        severity: "warning",
        file: `${rel}:${firstLine}`,
        message: `${occurrences.length} hx-* element(s) — ${catSummary}`,
        fix: `Rewrite per .agents/skills/deco-to-tanstack-migration/references/htmx-rewrite.md (run \`deco-htmx-analyze\` for the per-category breakdown)`,
        meta: {
          total: occurrences.length,
          byCategory: Object.fromEntries(byCat),
          firstLine,
        },
      });
    }
    return findings;
  },
};

/* ------------------------------------------------------------------ */
/* Rule 9 — `lockfile-multiple` — multiple lockfiles tracked          */
/* ------------------------------------------------------------------ */

/**
 * Per the fleet-wide bun-canonical decision, every storefront commits
 * exactly one lockfile: `bun.lock`. This rule fires when any of the
 * non-bun lockfiles co-exist with bun.lock — that's the exact pattern
 * that broke Cloudflare Workers Builds with `lockfile had changes, but
 * lockfile is frozen` (the dual-lockfile drift).
 *
 * The `--fix` deletes the offending non-bun lockfiles. Adding the
 * `.gitignore` bans is a separate concern handled by `packageManager-missing`
 * (which also nudges the site to add the bans), so this rule stays
 * focused.
 */
const NON_BUN_LOCKFILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"];

const ruleLockfileMultiple: Rule = {
  id: "lockfile-multiple",
  title: "Multiple lockfiles tracked alongside bun.lock",
  run({ siteDir, fs }: RuleContext): Finding[] {
    const bunLock = `${siteDir}/bun.lock`;
    if (!fs.exists(bunLock)) return [];
    const findings: Finding[] = [];
    for (const name of NON_BUN_LOCKFILES) {
      const abs = `${siteDir}/${name}`;
      if (!fs.exists(abs)) continue;
      findings.push({
        rule: "lockfile-multiple",
        severity: "warning",
        file: name,
        message: `${name} co-exists with bun.lock — Cloudflare Workers Builds picks bun and the other will silently drift`,
        fix: `rm ${name} (bun.lock is the canonical lockfile)`,
        meta: { lockfile: name },
      });
    }
    return findings;
  },
  applyFix({ siteDir }, findings, writer): FixAction[] {
    const actions: FixAction[] = [];
    for (const f of findings) {
      writer.deleteFile(`${siteDir}/${f.file}`);
      actions.push({
        file: f.file,
        kind: "delete",
        detail: `deleted (bun.lock is canonical)`,
      });
    }
    return actions;
  },
};

/* ------------------------------------------------------------------ */
/* Rule 10 — `lockfile-missing` — package.json without bun.lock        */
/* ------------------------------------------------------------------ */

/**
 * A storefront with `package.json` but no committed lockfile cannot
 * run `bun install --frozen-lockfile` in CI — Cloudflare Workers
 * Builds either falls back to a non-reproducible install or fails
 * outright depending on the build image. Detect-only because the
 * fix (`bun install`) requires network access and a working bun
 * toolchain that the audit shouldn't shell out to from inside its
 * own runner.
 */
const ruleLockfileMissing: Rule = {
  id: "lockfile-missing",
  title: "Lockfile missing",
  run({ siteDir, fs }: RuleContext): Finding[] {
    const pkg = `${siteDir}/package.json`;
    if (!fs.exists(pkg)) return [];
    const bunLock = `${siteDir}/bun.lock`;
    if (fs.exists(bunLock)) return [];
    // If a non-bun lockfile is present, `lockfile-multiple` doesn't
    // apply but the site is still mid-migration to bun. We flag the
    // missing bun.lock here so the operator runs `bun install` to
    // produce the canonical one.
    return [
      {
        rule: "lockfile-missing",
        severity: "warning",
        file: "bun.lock",
        message: `No bun.lock committed — frozen installs cannot run on CF Workers Builds`,
        fix: `Run \`bun install\` and commit the resulting bun.lock`,
        meta: {},
      },
    ];
  },
};

/* ------------------------------------------------------------------ */
/* Rule 11 — `lockfile-drift` — bun.lock out of sync with package.json */
/* ------------------------------------------------------------------ */

/**
 * Detects the head-on case behind the `lockfile had changes, but
 * lockfile is frozen` Workers Builds error: a direct dependency in
 * `package.json` has no version in `bun.lock` that satisfies the
 * declared range.
 *
 * Coverage is intentionally pragmatic — we recognise the four most
 * common range shapes (`^a.b.c`, `~a.b.c`, plain `a.b.c`, and the
 * sentinels `*` / `latest` / `next` / git/github specs which we skip).
 * Everything else falls back to "present in lockfile?", treating
 * unknown ranges as satisfied as long as the name appears at all.
 * The goal is high signal on the storefront fleet's actual failure
 * mode; full npm-semver fidelity is out of scope for this rule.
 *
 * Detect-only: regenerating bun.lock requires running `bun install`,
 * which the audit script doesn't do (would need network + bun in
 * PATH). Operators run it manually and re-run the audit.
 */
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.+-]+)?$/;

function parseSemver(v: string): [number, number, number] | null {
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function gte(a: [number, number, number], b: [number, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] >= b[2];
}

function lt(a: [number, number, number], b: [number, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

/**
 * Minimal `range satisfies version` check. Returns:
 * - `true` when the range is satisfied,
 * - `false` when it is definitely violated,
 * - `null` when we don't recognise the range shape and the caller
 *   should fall back to a presence check.
 */
function satisfiesRange(version: string, range: string): boolean | null {
  const trimmed = range.trim();
  // Sentinels and non-numeric specs we don't try to evaluate.
  if (
    trimmed === "*" ||
    trimmed === "latest" ||
    trimmed === "next" ||
    trimmed.startsWith("workspace:") ||
    trimmed.startsWith("file:") ||
    trimmed.startsWith("link:") ||
    trimmed.startsWith("git+") ||
    trimmed.startsWith("github:") ||
    trimmed.includes("://")
  ) {
    return null;
  }
  const ver = parseSemver(version);
  if (!ver) return null;
  // Caret: ^a.b.c → >=a.b.c <(a+1).0.0   when a > 0
  //        ^0.b.c → >=0.b.c <0.(b+1).0   when a == 0 && b > 0
  //        ^0.0.c → exactly 0.0.c
  if (trimmed.startsWith("^")) {
    const base = parseSemver(trimmed.slice(1));
    if (!base) return null;
    if (!gte(ver, base)) return false;
    let upper: [number, number, number];
    if (base[0] > 0) upper = [base[0] + 1, 0, 0];
    else if (base[1] > 0) upper = [0, base[1] + 1, 0];
    else upper = [0, 0, base[2] + 1];
    return lt(ver, upper);
  }
  // Tilde: ~a.b.c → >=a.b.c <a.(b+1).0
  if (trimmed.startsWith("~")) {
    const base = parseSemver(trimmed.slice(1));
    if (!base) return null;
    return gte(ver, base) && lt(ver, [base[0], base[1] + 1, 0]);
  }
  // Plain pin: a.b.c → exact match.
  const exact = parseSemver(trimmed);
  if (exact) return exact[0] === ver[0] && exact[1] === ver[1] && exact[2] === ver[2];
  return null;
}

/**
 * Pull every `"<name>@<version>"` token out of bun.lock for a given
 * package name. Bun's lockfile format embeds the version inside the
 * package descriptor array, e.g.:
 *
 *   "@decocms/start": ["@decocms/start@2.1.1", ...]
 *
 * We scan all such occurrences (a single package may appear multiple
 * times if the dep tree pulled different versions).
 */
function lockfileVersionsOf(lockfile: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`['"]${escaped}@([^'"\\s]+)['"]`, "g");
  const seen = new Set<string>();
  for (const m of lockfile.matchAll(re)) {
    seen.add(m[1]);
  }
  return [...seen];
}

const ruleLockfileDrift: Rule = {
  id: "lockfile-drift",
  title: "bun.lock drifted vs package.json direct dependencies",
  run({ siteDir, fs }: RuleContext): Finding[] {
    const pkgPath = `${siteDir}/package.json`;
    const lockPath = `${siteDir}/bun.lock`;
    if (!fs.exists(pkgPath) || !fs.exists(lockPath)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readText(pkgPath));
    } catch {
      return [];
    }
    if (typeof parsed !== "object" || parsed === null) return [];
    const pkg = parsed as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const lockText = fs.readText(lockPath);
    const drifted: { name: string; range: string; locked: string[] }[] = [];
    const buckets: Record<string, string>[] = [pkg.dependencies ?? {}, pkg.devDependencies ?? {}];
    for (const bucket of buckets) {
      for (const [name, range] of Object.entries(bucket)) {
        const versions = lockfileVersionsOf(lockText, name);
        if (versions.length === 0) {
          drifted.push({ name, range, locked: [] });
          continue;
        }
        // If at least one locked version satisfies the range, we're fine.
        // For unknown range shapes (return null), treat presence as
        // satisfaction — pragmatic, see rule docstring.
        let satisfied = false;
        for (const v of versions) {
          const result = satisfiesRange(v, range);
          if (result === true || result === null) {
            satisfied = true;
            break;
          }
        }
        if (!satisfied) drifted.push({ name, range, locked: versions });
      }
    }
    if (drifted.length === 0) return [];
    return [
      {
        rule: "lockfile-drift",
        severity: "warning",
        file: "bun.lock",
        message: `${drifted.length} direct dep(s) not satisfied by bun.lock — frozen install will fail`,
        fix: `Run \`bun install\` to refresh bun.lock, then commit. Drift: ${drifted
          .slice(0, 5)
          .map((d) => `${d.name} ${d.range} (locked: ${d.locked.length > 0 ? d.locked.join(", ") : "none"})`)
          .join("; ")}${drifted.length > 5 ? `; +${drifted.length - 5} more` : ""}`,
        meta: { drifted },
      },
    ];
  },
};

/* ------------------------------------------------------------------ */
/* Rule 12 — `package-manager-missing` — no packageManager field      */
/* ------------------------------------------------------------------ */

/**
 * Without a `packageManager` field in package.json, neither developers
 * nor CI are forced to agree on a PM. Anyone running `npm install`
 * or `yarn` produces an alternate lockfile that risks drifting from
 * `bun.lock` and breaking Workers Builds. The fleet-wide canonical
 * value is `bun@<CANONICAL_BUN_VERSION>`; bumping that constant here
 * propagates to all `--fix` runs.
 */
const CANONICAL_PACKAGE_MANAGER = "bun@1.3.5";

const rulePackageManagerMissing: Rule = {
  id: "package-manager-missing",
  title: "Missing packageManager field in package.json",
  run({ siteDir, fs }: RuleContext): Finding[] {
    const pkgPath = `${siteDir}/package.json`;
    if (!fs.exists(pkgPath)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readText(pkgPath));
    } catch {
      return [];
    }
    if (typeof parsed !== "object" || parsed === null) return [];
    const pkg = parsed as { packageManager?: string };
    if (typeof pkg.packageManager === "string" && pkg.packageManager.length > 0) {
      return [];
    }
    return [
      {
        rule: "package-manager-missing",
        severity: "info",
        file: "package.json",
        message: `Missing "packageManager" field — contributors and CF Workers Builds may pick different PMs`,
        fix: `Set "packageManager": "${CANONICAL_PACKAGE_MANAGER}" in package.json`,
        meta: { canonical: CANONICAL_PACKAGE_MANAGER },
      },
    ];
  },
  applyFix({ siteDir, fs }, findings, writer): FixAction[] {
    if (findings.length === 0) return [];
    const pkgPath = `${siteDir}/package.json`;
    if (!fs.exists(pkgPath)) return [];
    const content = fs.readText(pkgPath);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return [];
    }
    if (typeof parsed.packageManager === "string" && parsed.packageManager.length > 0) {
      return [];
    }
    // Insert `packageManager` directly after `license` to match the
    // convention used across the storefront fleet. Falls back to the
    // end of the object when `license` is absent.
    const ordered: Record<string, unknown> = {};
    let inserted = false;
    for (const [k, v] of Object.entries(parsed)) {
      ordered[k] = v;
      if (!inserted && k === "license") {
        ordered.packageManager = CANONICAL_PACKAGE_MANAGER;
        inserted = true;
      }
    }
    if (!inserted) ordered.packageManager = CANONICAL_PACKAGE_MANAGER;
    writer.writeText(pkgPath, `${JSON.stringify(ordered, null, 2)}\n`);
    return [
      {
        file: "package.json",
        kind: "edit",
        detail: `set packageManager: "${CANONICAL_PACKAGE_MANAGER}"`,
      },
    ];
  },
};

/* ------------------------------------------------------------------ */
/* Rule N — `vtex-proxy-handler-missing` — worker-entry without proxy */
/* ------------------------------------------------------------------ */

/**
 * Every VTEX storefront on @decocms/start needs a reverse proxy for
 * `/checkout/*`, `/account/*`, `/api/*`, `/files/*`, etc. — those paths
 * must hit the VTEX origin (not TanStack Start) so the user lands on
 * the real checkout UI carrying their VTEX session cookies.
 *
 * The canonical wiring lives in `src/worker-entry.ts` via
 * `createDecoWorkerEntry(..., { proxyHandler })`, where the handler
 * calls `shouldProxyToVtex(url.pathname)` + a `createVtexCheckoutProxy`
 * instance. The migration scaffold (`scripts/migrate/templates/server-entry.ts`)
 * emits this by default for VTEX sites, but two regressions sneak it out:
 *
 *  1. A site migrated by a pre-scaffold version of the script (e.g.
 *     before the VTEX worker-entry template existed).
 *  2. Someone refactors `worker-entry.ts` and drops the proxy block.
 *
 * Without the proxy, add-to-cart still "succeeds" (the action runs
 * server-side via TanStack RPC), but clicking "Finalizar" navigates
 * to `/checkout` on the storefront — which returns the SPA shell —
 * and the user never reaches VTEX checkout. The VTEX-side orderForm
 * lives at vtexcommercestable.com.br with no way to see it.
 *
 * Detection is cheap: VTEX sites should import `shouldProxyToVtex`
 * (or wire a `proxyHandler:` to `createDecoWorkerEntry`). We flag
 * absence as `info` (not warning) because old in-prod sites we
 * deliberately don't touch would otherwise stay noisy.
 */
const ruleVtexProxyHandlerMissing: Rule = {
  id: "vtex-proxy-handler-missing",
  title: "VTEX worker-entry missing the checkout/API proxy handler",
  run({ siteDir, fs }: RuleContext): Finding[] {
    // Only run when the site is actually VTEX. The cheapest signal is
    // any import from `@decocms/apps/vtex/...` in src/ — every VTEX
    // site has at least one (commerceLoaders, hooks, types, etc.).
    const srcFiles = fs.glob(siteDir, "src/**/*.{ts,tsx}", SRC_GLOB_EXCLUDES);
    const isVtex = srcFiles.some((abs) =>
      fs.readText(abs).includes("@decocms/apps/vtex"),
    );
    if (!isVtex) return [];

    const workerEntryAbs = `${siteDir}/src/worker-entry.ts`;
    if (!fs.exists(workerEntryAbs)) {
      return [
        {
          rule: "vtex-proxy-handler-missing",
          severity: "info",
          file: "src/worker-entry.ts",
          message:
            "VTEX site has no src/worker-entry.ts — /checkout proxy can't run, the user will see the SPA shell instead of VTEX checkout",
          fix: "Re-run `deco-migrate` (the scaffold emits a worker-entry with createVtexCheckoutProxy), or copy from scripts/migrate/templates/server-entry.ts",
        },
      ];
    }

    const content = fs.readText(workerEntryAbs);
    // Match either symbol — sites use the factory function OR the
    // shouldProxyToVtex predicate as the entry point. Presence of
    // either is a strong signal the proxy block exists; absence of
    // both means it was dropped.
    const hasProxyImport =
      /from\s+["']@decocms\/apps\/vtex\/utils\/proxy["']/.test(content);
    // Match both long form (`proxyHandler: async (...) => ...`) and
    // object-shorthand wiring (`{ proxyHandler }`, `{ proxyHandler, admin }`).
    // The anchor `[{,]` requires the identifier to appear as a property —
    // not as a bare `const proxyHandler = ...` declaration, which is
    // followed by `=` and wouldn't match either branch.
    const hasProxyHandler = /[{,]\s*proxyHandler\s*[:,}]/.test(content);

    if (hasProxyImport && hasProxyHandler) return [];

    return [
      {
        rule: "vtex-proxy-handler-missing",
        severity: "info",
        file: "src/worker-entry.ts",
        message: hasProxyImport
          ? "imports proxy helpers but no `proxyHandler:` is wired into createDecoWorkerEntry — /checkout requests will fall through to TanStack and render the SPA shell"
          : "no `@decocms/apps/vtex/utils/proxy` import — VTEX /checkout, /account, /api won't be proxied to the origin",
        fix: "Add `proxyHandler` to createDecoWorkerEntry; see scripts/migrate/templates/server-entry.ts (generateVtexWorkerEntry) for the canonical block",
      },
    ];
  },
};

export const ALL_RULES: Rule[] = [
  ruleDeadLibShims,
  ruleObsoleteVitePlugins,
  ruleDeadRuntimeShim,
  ruleSiteLocalGlobals,
  ruleVtexShimRegression,
  ruleVtexProxyHandlerMissing,
  ruleLocalWidgetsTypes,
  ruleFrameworkTodos,
  ruleLocalFrameworkDuplicate,
  ruleHtmxResidue,
  ruleLockfileMultiple,
  ruleLockfileMissing,
  ruleLockfileDrift,
  rulePackageManagerMissing,
];

/** Exported for direct unit tests. */
export const _internals = {
  extractExports,
  symbolUsedOutsideLib,
  satisfiesRange,
  lockfileVersionsOf,
  rules: {
    ruleDeadLibShims,
    ruleObsoleteVitePlugins,
    ruleDeadRuntimeShim,
    ruleSiteLocalGlobals,
    ruleVtexShimRegression,
    ruleVtexProxyHandlerMissing,
    ruleHtmxResidue,
    ruleLocalWidgetsTypes,
    ruleFrameworkTodos,
    ruleLocalFrameworkDuplicate,
    ruleLockfileMultiple,
    ruleLockfileMissing,
    ruleLockfileDrift,
    rulePackageManagerMissing,
  },
};
