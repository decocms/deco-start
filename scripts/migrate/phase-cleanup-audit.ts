/**
 * Phase 9: Post-Migration Cleanup Audit
 *
 * Runs the same `deco-post-cleanup` audit logic as the standalone CLI,
 * but inline at the tail of `deco-migrate`. The goal is to surface any
 * residual debt the migration script can't fix on its own (e.g.
 * silent vtex shim regressions, orphan TODOs, manual-review items)
 * the moment the migration completes — without making the user
 * remember a separate command.
 *
 * Behaviour:
 * - Always READ-ONLY. Auto-fix is opt-in via the standalone CLI's
 *   `--fix` flag — never invoked from inside the migration script
 *   to keep the migration's mutation surface predictable.
 * - Skipped in dry-run (no migrated output to scan).
 * - Skipped via `--no-cleanup-audit` when integrated runs are noisy.
 * - In `--strict` mode, returns true (caller exits 2) if any
 *   warning-severity findings exist. Info findings never fail the
 *   build — they're just hints.
 */

import { banner, bold, gray, green, red, yellow } from "./colors";
import { realFsAdapter, runAudit } from "./post-cleanup/runner";
import type { AuditReport, Severity } from "./post-cleanup/types";
import type { MigrationContext } from "./types";

export interface CleanupAuditOptions {
  /** Promote warning findings to fatal (exit 2 from main). Default: false. */
  strict?: boolean;
}

/**
 * Returns `true` when the caller should exit with a non-zero code.
 * Always false in normal mode — audit is informational by default.
 */
export function cleanupAudit(ctx: MigrationContext, opts: CleanupAuditOptions = {}): boolean {
  if (ctx.dryRun) {
    return false;
  }

  banner("Phase 9: Post-Migration Cleanup Audit");

  const report = runAudit(ctx.sourceDir, realFsAdapter);

  if (report.totalFindings === 0) {
    console.log(`  ${green("✓")} No findings — migration output is clean.`);
    return false;
  }

  printSummary(report);

  const warnings = countSeverity(report, "warning");
  const infos = countSeverity(report, "info");
  const willFail = (opts.strict ?? false) && warnings > 0;

  console.log("");
  console.log(
    `  ${bold("Audit:")} ${report.totalFindings} finding(s) — ${yellow(`${warnings} warning(s)`)}, ${gray(`${infos} info`)}`,
  );
  console.log(
    `  ${gray("Run")} ${bold("deco-post-cleanup --fix")} ${gray("from this directory to auto-correct the safe rules,")}`,
  );
  console.log(`  ${gray("or see post-migration-cleanup.md for the full per-rule playbook.")}`);

  if (willFail) {
    console.log(
      `\n  ${red("--strict:")} ${warnings} warning-severity finding(s) failed the audit.`,
    );
    return true;
  }

  return false;
}

function severityTag(sev: Severity, text: string): string {
  if (sev === "warning") return yellow(text);
  return gray(text);
}

function printSummary(report: AuditReport): void {
  let idx = 0;
  for (const summary of report.rules) {
    idx++;
    if (summary.findings.length === 0) continue;
    const headColor = yellow;
    console.log(
      `  ${headColor(`[${idx}] ${summary.title}`)} ${gray(`(${summary.findings.length} found)`)}`,
    );
    // Cap the per-rule output so a noisy site doesn't drown the
    // migration's own report. Standalone CLI shows everything.
    const visible = summary.findings.slice(0, 5);
    for (const f of visible) {
      const tag = severityTag(f.severity, `[${f.severity.toUpperCase()}]`);
      console.log(`      ${tag} ${bold(f.file)} — ${f.message}`);
    }
    const hidden = summary.findings.length - visible.length;
    if (hidden > 0) {
      console.log(`      ${gray(`...and ${hidden} more (run deco-post-cleanup for full list)`)}`);
    }
  }
}

function countSeverity(report: AuditReport, sev: Severity): number {
  return report.rules.flatMap((r) => r.findings).filter((f) => f.severity === sev).length;
}
