/**
 * Post-migration cleanup audit — orchestrator.
 *
 * `runAudit` is the testable, FS-injected entry. The CLI in
 * `../../migrate-post-cleanup.ts` wires up the real disk adapter.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ALL_RULES } from "./rules";
import type { AuditReport, FsAdapter, FsWriter, Rule, RuleSummary } from "./types";

export interface RunAuditOptions {
  /**
   * When set, rules with an `applyFix` implementation will run their
   * fix and the report will include the resulting `FixAction[]`.
   * Without this, the runner is purely read-only.
   */
  writer?: FsWriter;
  /** Restrict to a subset of rules (defaults to all). */
  rules?: Rule[];
}

export function runAudit(
  siteDir: string,
  adapter: FsAdapter,
  options: RunAuditOptions = {},
): AuditReport {
  const rules = options.rules ?? ALL_RULES;
  const summaries: RuleSummary[] = rules.map((rule) => {
    const findings = rule.run({ siteDir, fs: adapter });
    const supportsAutoFix = typeof rule.applyFix === "function";
    let fixes: RuleSummary["fixes"];
    if (options.writer && rule.applyFix && findings.length > 0) {
      fixes = rule.applyFix({ siteDir, fs: adapter }, findings, options.writer);
    }
    return {
      rule: rule.id,
      title: rule.title,
      findings,
      supportsAutoFix,
      fixes,
    };
  });
  return {
    site: siteDir,
    rules: summaries,
    totalFindings: summaries.reduce((acc, s) => acc + s.findings.length, 0),
    totalFixActions: summaries.reduce((acc, s) => acc + (s.fixes?.length ?? 0), 0),
  };
}

/* ------------------------------------------------------------------ */
/* Real disk adapter                                                  */
/* ------------------------------------------------------------------ */

/**
 * Minimal recursive-walk glob — intentionally tiny, no external deps.
 * Supports `**`, `*`, and `{a,b,c}` brace expansion.  Does NOT support
 * extglob, negation, or `?`. That's fine: every pattern in this audit
 * fits the supported subset.
 */
function expandBraces(pattern: string): string[] {
  const m = pattern.match(/\{([^{}]+)\}/);
  if (!m) return [pattern];
  const [whole, inner] = m;
  const start = pattern.indexOf(whole);
  const before = pattern.slice(0, start);
  const after = pattern.slice(start + whole.length);
  const branches = inner.split(",");
  return branches.flatMap((b) => expandBraces(`${before}${b}${after}`));
}

function patternToRegex(pattern: string): RegExp {
  const re = pattern
    .replace(/[.+^$()|]/g, "\\$&")
    .replace(/\*\*\//g, "<<DBL>>")
    .replace(/\*\*/g, "<<DBL>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<DBL>>/g, "(?:.*/)?");
  return new RegExp(`^${re}$`);
}

function walk(dir: string, rootDir: string, excludeDirs: Set<string>, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excludeDirs.has(entry.name)) continue;
      walk(abs, rootDir, excludeDirs, out);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
}

export const realFsAdapter: FsAdapter = {
  exists(absPath: string) {
    return fs.existsSync(absPath);
  },
  readText(absPath: string) {
    return fs.readFileSync(absPath, "utf-8");
  },
  glob(siteDir: string, pattern: string, excludeDirs: string[] = []) {
    const allFiles: string[] = [];
    walk(siteDir, siteDir, new Set(excludeDirs), allFiles);
    const patterns = expandBraces(pattern).map(patternToRegex);
    const matches = allFiles.filter((abs) => {
      const rel = abs.slice(siteDir.length + 1).replace(/\\/g, "/");
      return patterns.some((re) => re.test(rel));
    });
    return matches.sort();
  },
};

/**
 * Real disk writer used by the CLI when `--fix` is on. Tests should
 * use a recording adapter and never instantiate this.
 *
 * `deleteFile` is intentionally tolerant: if the file is already gone
 * (race with a previous fix or manual cleanup), we treat that as a
 * no-op rather than crashing the audit.
 */
export const realFsWriter: FsWriter = {
  deleteFile(absPath: string) {
    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
  },
  writeText(absPath: string, content: string) {
    fs.writeFileSync(absPath, content, "utf-8");
  },
};
