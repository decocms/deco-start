#!/usr/bin/env tsx
/**
 * Post-Migration Cleanup Audit
 *
 * Read-only audit that scans a migrated site for dead code and obsolete
 * boilerplate that the framework now owns. Mirrors the human checklist at
 * `.agents/skills/deco-to-tanstack-migration/references/post-migration-cleanup.md`
 * but turns it into something CI can actually run.
 *
 * Usage (from a migrated site directory):
 *   npx -p @decocms/start deco-post-cleanup
 *   npx -p @decocms/start deco-post-cleanup --json
 *
 * Options:
 *   --source <dir>   Site directory to audit (default: current directory)
 *   --json           Emit machine-readable JSON instead of pretty text
 *   --strict         Exit code 2 if any warning-severity findings exist
 *   --help, -h       Show this help
 *
 * This script is intentionally read-only. Auto-fix support (`--fix`) is
 * a planned follow-up — see the SKILL doc.
 */

import * as path from "node:path";
import { banner, bold, gray, green, red, yellow } from "./migrate/colors";
import { realFsAdapter, runAudit } from "./migrate/post-cleanup/runner";
import type { AuditReport, Severity } from "./migrate/post-cleanup/types";

interface CliOpts {
  source: string;
  json: boolean;
  strict: boolean;
  help: boolean;
}

function parseArgs(args: string[]): CliOpts {
  let source = ".";
  let json = false;
  let strict = false;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--source":
        source = args[++i];
        break;
      case "--json":
        json = true;
        break;
      case "--strict":
        strict = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
    }
  }
  return { source, json, strict, help };
}

function showHelp() {
  console.log(`
  @decocms/start — Post-Migration Cleanup Audit

  Scans a migrated site for dead code and obsolete boilerplate that the
  framework now owns. Read-only — prints findings, does not modify files.

  Usage:
    npx -p @decocms/start deco-post-cleanup [options]

  Options:
    --source <dir>   Site directory to audit (default: .)
    --json           Emit machine-readable JSON instead of pretty text
    --strict         Exit code 2 if any warning-severity findings exist
    --help, -h       Show this help

  Examples:
    npx -p @decocms/start deco-post-cleanup
    npx -p @decocms/start deco-post-cleanup --source ./my-site --json

  See: .agents/skills/deco-to-tanstack-migration/references/post-migration-cleanup.md
  `);
}

function severityColor(sev: Severity, text: string): string {
  if (sev === "warning") return yellow(text);
  return gray(text);
}

function printText(report: AuditReport): void {
  banner("Post-Migration Cleanup Audit");
  console.log(`  ${gray("Site:")} ${bold(report.site)}`);
  console.log(`  ${gray("Findings:")} ${bold(String(report.totalFindings))}`);
  console.log("");

  let idx = 0;
  for (const summary of report.rules) {
    idx++;
    const count = summary.findings.length;
    const headColor = count === 0 ? green : yellow;
    console.log(`${headColor(`[${idx}] ${summary.title}`)} ${gray(`(${count} found)`)}`);
    for (const f of summary.findings) {
      const tag = severityColor(f.severity, `[${f.severity.toUpperCase()}]`);
      console.log(`    ${tag} ${bold(f.file)} — ${f.message}`);
      if (f.fix) console.log(`        ${gray("fix:")} ${f.fix}`);
    }
    if (count === 0) console.log(`    ${gray("(nothing to clean up)")}`);
    console.log("");
  }

  const warnings = report.rules
    .flatMap((r) => r.findings)
    .filter((f) => f.severity === "warning").length;
  const infos = report.totalFindings - warnings;
  console.log(
    `${bold("Summary:")} ${report.totalFindings} finding(s) — ${yellow(`${warnings} warning(s)`)}, ${gray(`${infos} info`)}`,
  );
  if (report.totalFindings > 0) {
    console.log(gray("  See post-migration-cleanup.md for the canonical fix steps per rule."));
  }
}

function printJson(report: AuditReport): void {
  console.log(JSON.stringify(report, null, 2));
}

function shouldFail(report: AuditReport, strict: boolean): boolean {
  if (!strict) return false;
  return report.rules.some((r) => r.findings.some((f) => f.severity === "warning"));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    showHelp();
    process.exit(0);
  }

  const siteDir = path.resolve(opts.source);
  const report = runAudit(siteDir, realFsAdapter);

  if (opts.json) {
    printJson(report);
  } else {
    printText(report);
  }

  if (shouldFail(report, opts.strict)) {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(red(`Audit failed: ${(err as Error).message}`));
  process.exit(1);
});
