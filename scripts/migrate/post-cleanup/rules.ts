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

import type { Finding, Rule, RuleContext } from "./types";

const SRC_GLOB_EXCLUDES = ["node_modules", "dist", ".wrangler", ".vite", ".tanstack", "build"];

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

const ruleVtexShimRegression: Rule = {
  id: "vtex-shim-regression",
  title: "Imports from ~/lib/vtex-* (silent stub regression)",
  run({ siteDir, fs }: RuleContext): Finding[] {
    const tsFiles = fs.glob(siteDir, "src/**/*.{ts,tsx}", SRC_GLOB_EXCLUDES);
    const findings: Finding[] = [];
    const re = /from\s+['"]~\/lib\/vtex-([A-Za-z0-9-]+)['"]/g;
    for (const abs of tsFiles) {
      if (abs.includes("/src/lib/")) continue;
      const content = fs.readText(abs);
      const matches = [...content.matchAll(re)];
      if (matches.length === 0) continue;
      const rel = abs.slice(siteDir.length + 1);
      const shims = [...new Set(matches.map((m) => `vtex-${m[1]}`))];
      findings.push({
        rule: "vtex-shim-regression",
        severity: "warning",
        file: rel,
        message: `Imports from dead shim(s): ${shims.join(", ")} — runtime is silently stubbed`,
        fix: "Repoint imports to '@decocms/apps/vtex/...' or 'apps/commerce/utils/...'",
        meta: { shims },
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
