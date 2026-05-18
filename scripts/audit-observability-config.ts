#!/usr/bin/env tsx
/**
 * @decocms/start — observability config audit
 *
 * Read-only auditor for a site's `wrangler.jsonc`. Detects drift away
 * from the canonical Cloudflare-native observability block documented
 * in `docs/observability.md`. CI-friendly: exits 0 on a clean audit, 1
 * on findings.
 *
 * This is the **detect** half of D3 ("audit is the safety net"). The
 * matching **fix** half is `migrate-to-cf-observability.ts`, which can
 * rewrite the block back to canonical with `--write`. Every rule here
 * has a corresponding behavior in the codemod — there is no rule we
 * can detect but not auto-fix.
 *
 * Rules (id — severity — what it catches):
 *
 *   observability_missing            error   No `observability` key at all. CF captures nothing.
 *   observability_disabled           error   `observability.enabled: false`. Master switch off.
 *   traces_disabled                  warn    `observability.traces.enabled: false`. No traces in dashboard.
 *   logs_disabled                    warn    `observability.logs.enabled: false`. No logs in dashboard.
 *   head_sampling_rate_elevated      error   `traces.head_sampling_rate > 0.01`. Fleet-scale cost risk; see docs/observability.md.
 *   logs_head_sampling_rate_low      warn    `logs.head_sampling_rate < 1`. Sampling info/warn logs loses signal cheaply; errors go via the direct-POST channel.
 *   persist_disabled_no_destination  error   `persist: false` with no destination configured. Data captured then discarded.
 *
 * Usage (from a site directory):
 *   npx -p @decocms/start deco-audit-observability                # audit cwd
 *   npx -p @decocms/start deco-audit-observability --source ./   # explicit
 *   npx -p @decocms/start deco-audit-observability --json         # machine-readable
 *
 * Options:
 *   --source <dir>   Site directory (default: .)
 *   --json           Emit findings as JSON to stdout (still exits non-zero on findings)
 *   --help, -h       Show this message
 *
 * Exit codes:
 *   0 — no findings (or only `info`-level findings; none defined yet)
 *   1 — at least one finding (warn or error)
 *   2 — file invalid / can't parse
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { stripJsoncComments } from "./lib/jsonc";

export type Severity = "error" | "warn" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  message: string;
  /** Suggested remediation — usually a codemod invocation. */
  fix?: string;
}

interface CliOpts {
  source: string;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { source: ".", json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--source":
        opts.source = argv[++i] ?? ".";
        break;
      case "--json":
        opts.json = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
    }
  }
  return opts;
}

function showHelp(): void {
  console.log(`
  @decocms/start — observability config audit

  Read-only check for drift from the canonical Cloudflare-native
  observability block in wrangler.jsonc. Pair with
  \`deco-cf-observability --write\` to auto-fix.

  Usage:
    npx -p @decocms/start deco-audit-observability [options]

  Options:
    --source <dir>   Site directory (default: .)
    --json           Emit findings as JSON
    --help, -h       This message

  Exit codes:
    0   no findings
    1   one or more findings (warn or error)
    2   wrangler.jsonc missing or unparseable
`);
}

interface ObservabilityBlock {
  enabled?: boolean;
  logs?: {
    enabled?: boolean;
    head_sampling_rate?: number;
    persist?: boolean;
    destinations?: unknown[];
    invocation_logs?: boolean;
  };
  traces?: {
    enabled?: boolean;
    head_sampling_rate?: number;
    persist?: boolean;
    destinations?: unknown[];
  };
}

/**
 * Pure audit function. Exported for unit-testing; the CLI wrapper is the
 * thin sliver below.
 */
export function auditObservabilityBlock(
  obs: ObservabilityBlock | undefined,
): Finding[] {
  const findings: Finding[] = [];

  if (!obs) {
    findings.push({
      id: "observability_missing",
      severity: "error",
      message:
        "wrangler.jsonc has no `observability` block. Cloudflare won't capture logs or traces.",
      fix: "npx -p @decocms/start deco-cf-observability --write",
    });
    return findings;
  }

  if (obs.enabled === false) {
    findings.push({
      id: "observability_disabled",
      severity: "error",
      message:
        "`observability.enabled: false` — the master switch is off, sub-block flags do nothing.",
      fix: "npx -p @decocms/start deco-cf-observability --write",
    });
  }

  // ---- traces ----
  if (obs.traces?.enabled === false) {
    findings.push({
      id: "traces_disabled",
      severity: "warn",
      message:
        "`observability.traces.enabled: false` — traces won't reach the CF dashboard or any destination.",
      fix: "npx -p @decocms/start deco-cf-observability --write",
    });
  }

  const tracesRate = obs.traces?.head_sampling_rate;
  if (typeof tracesRate === "number" && tracesRate > 0.01) {
    findings.push({
      id: "head_sampling_rate_elevated",
      severity: "error",
      message:
        `traces.head_sampling_rate is ${tracesRate} (> 0.01). At fleet scale this is a cost trap; ` +
        `see docs/observability.md → Sampling. If this is intentional and time-bounded (incident, ` +
        `release window), leave a comment in wrangler.jsonc explaining why, then revert.`,
      fix: "npx -p @decocms/start deco-cf-observability --write --traces-rate 0.01",
    });
  }

  // ---- logs ----
  if (obs.logs?.enabled === false) {
    findings.push({
      id: "logs_disabled",
      severity: "warn",
      message:
        "`observability.logs.enabled: false` — logs won't reach the CF dashboard or any destination.",
      fix: "npx -p @decocms/start deco-cf-observability --write",
    });
  }

  const logsRate = obs.logs?.head_sampling_rate;
  if (typeof logsRate === "number" && logsRate < 1) {
    findings.push({
      id: "logs_head_sampling_rate_low",
      severity: "warn",
      message:
        `logs.head_sampling_rate is ${logsRate} (< 1). Info/warn logs are cheap and high-signal; ` +
        `error logs already bypass head sampling via the direct-POST channel, so there's little to ` +
        `gain by sampling logs.`,
      fix: "npx -p @decocms/start deco-cf-observability --write --logs-rate 1",
    });
  }

  // ---- persist / destinations ----
  const hasDestination = (block?: { destinations?: unknown[] }): boolean =>
    Array.isArray(block?.destinations) && block!.destinations!.length > 0;

  const tracesPersist = obs.traces?.persist ?? true;
  if (
    obs.traces?.enabled !== false &&
    !tracesPersist &&
    !hasDestination(obs.traces)
  ) {
    findings.push({
      id: "persist_disabled_no_destination",
      severity: "error",
      message:
        "traces.persist:false with no destinations — traces are captured and discarded. " +
        "Either set persist:true (CF dashboard storage) or configure a destination.",
      fix: "npx -p @decocms/start deco-cf-observability --write --persist",
    });
  }

  const logsPersist = obs.logs?.persist ?? true;
  if (
    obs.logs?.enabled !== false &&
    !logsPersist &&
    !hasDestination(obs.logs)
  ) {
    findings.push({
      id: "persist_disabled_no_destination",
      severity: "error",
      message:
        "logs.persist:false with no destinations — logs are captured and discarded. " +
        "Either set persist:true (CF dashboard storage) or configure a destination.",
      fix: "npx -p @decocms/start deco-cf-observability --write --persist",
    });
  }

  return findings;
}

function findingsToText(file: string, findings: Finding[]): string {
  if (findings.length === 0) {
    return `OK   ${file} — observability config looks canonical`;
  }
  const lines = [`Findings in ${file}:`];
  for (const f of findings) {
    lines.push(`  [${f.severity.toUpperCase()}] ${f.id}`);
    lines.push(`    ${f.message}`);
    if (f.fix) lines.push(`    fix: ${f.fix}`);
  }
  lines.push("");
  return lines.join("\n");
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    showHelp();
    process.exit(0);
  }

  const file = path.resolve(opts.source, "wrangler.jsonc");
  if (!fs.existsSync(file)) {
    console.error(`audit: ${file} not found`);
    process.exit(2);
  }

  let parsed: { observability?: ObservabilityBlock };
  try {
    parsed = JSON.parse(stripJsoncComments(fs.readFileSync(file, "utf8")));
  } catch (err) {
    console.error(`audit: ${file} could not be parsed: ${(err as Error).message}`);
    process.exit(2);
  }

  const findings = auditObservabilityBlock(parsed.observability);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ file, findings }, null, 2) + "\n");
  } else {
    process.stdout.write(findingsToText(file, findings) + "\n");
  }

  // Any finding (warn or error) is a non-zero exit. info-severity would not
  // flip the exit, but no info-severity rules are defined yet.
  const blocking = findings.some((f) => f.severity !== "info");
  process.exit(blocking ? 1 : 0);
}

// Only run when invoked directly, not when imported by tests.
// Works under both CJS (require.main === module) and ESM (import.meta.url
// matches argv[1]) because the package is `"type": "module"` but the
// codemod siblings ship .cjs bundles via tsup.
const isCjsEntry =
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  // biome-ignore lint/correctness/noNodejsModules: entry-point check
  require.main === module;
let isEsmEntry = false;
try {
  // import.meta is a syntax error in CJS, but we're in an ESM source file.
  isEsmEntry =
    typeof process !== "undefined" &&
    Array.isArray(process.argv) &&
    process.argv[1] !== undefined &&
    import.meta.url === `file://${process.argv[1]}`;
} catch {
  // ignore in CJS
}
if (isCjsEntry || isEsmEntry) {
  main();
}
