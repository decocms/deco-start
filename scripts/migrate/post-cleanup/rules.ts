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
};

/* ------------------------------------------------------------------ */
/* Rule 3 — dead `src/runtime.ts` invoke shim                          */
/* ------------------------------------------------------------------ */

const ruleDeadRuntimeShim: Rule = {
  id: "dead-runtime-shim",
  title: "Dead src/runtime.ts invoke shim",
  run({ siteDir, fs }: RuleContext): Finding[] {
    const abs = `${siteDir}/src/runtime.ts`;
    if (!fs.exists(abs)) return [];
    const content = fs.readText(abs);
    // Heuristic: if the file's only meaningful exports are `invoke` /
    // `createNestedInvokeProxy`, it's purely a shim.
    const exports = extractExports(content);
    const onlyInvokeShim =
      exports.length > 0 && exports.every((e) => ["invoke", "createNestedInvokeProxy"].includes(e));
    if (!onlyInvokeShim) return [];
    return [
      {
        rule: "dead-runtime-shim",
        severity: "info",
        file: "src/runtime.ts",
        message: `Only re-exports invoke (${exports.join(", ")}) — replace with @decocms/start/sdk`,
        fix: 'rg -l "from \\"~/runtime\\"" src/ | xargs sed -i \'\' \'s|from "~/runtime"|from "@decocms/start/sdk"|g\' && rm src/runtime.ts',
      },
    ];
  },
  applyFix(ctx, findings, writer): FixAction[] {
    if (findings.length === 0) return [];
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
        .join("; ")
      ;
      findings.push({
        rule: "vtex-shim-regression",
        severity: "warning",
        file: rel,
        message: `Imports stub-only symbols from ${detail} — runtime is silently stubbed`,
        fix: "Repoint imports to '@decocms/apps/vtex/...' or 'apps/commerce/utils/...'",
        meta: {
          stubsBySim: Object.fromEntries(stubsBySim),
        },
      });
    }
    return findings;
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

export const ALL_RULES: Rule[] = [
  ruleDeadLibShims,
  ruleObsoleteVitePlugins,
  ruleDeadRuntimeShim,
  ruleSiteLocalGlobals,
  ruleVtexShimRegression,
  ruleLocalWidgetsTypes,
  ruleFrameworkTodos,
];

/** Exported for direct unit tests. */
export const _internals = {
  extractExports,
  symbolUsedOutsideLib,
  rules: {
    ruleDeadLibShims,
    ruleObsoleteVitePlugins,
    ruleDeadRuntimeShim,
    ruleSiteLocalGlobals,
    ruleVtexShimRegression,
    ruleLocalWidgetsTypes,
    ruleFrameworkTodos,
  },
};
