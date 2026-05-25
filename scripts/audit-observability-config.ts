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
 *   observability_missing                error   No `observability` key at all. CF captures nothing.
 *   observability_disabled               error   `observability.enabled: false`. Master switch off.
 *   traces_disabled                      warn    `observability.traces.enabled: false`. No traces in dashboard.
 *   logs_disabled                        warn    `observability.logs.enabled: false`. No logs in dashboard.
 *   head_sampling_rate_elevated          error   `traces.head_sampling_rate > 0.01`. Fleet-scale cost risk; see docs/observability.md.
 *   logs_head_sampling_rate_low          warn    `logs.head_sampling_rate < 1`. Sampling info/warn logs loses signal cheaply; errors go via the direct-POST channel.
 *   persist_disabled_no_destination      error   `persist: false` with no destination configured. Data captured then discarded.
 *
 * Phase 6 / D-14 — fleet-config drift rules (live outside the
 * `observability` block but still owned by this audit):
 *
 *   version_metadata_binding_missing     error   Missing `version_metadata` binding. `service.version` won't be stamped — regressions can't be attributed to a deploy.
 *   analytics_engine_binding_missing     warn    No `DECO_METRICS` AE binding. AE meter is off; OTLP meter still works but CF dashboard panels go dark.
 *   tail_consumer_missing                error   No `tail_consumers` entry pointing at `deco-otel-tail`. 100% error-capture is broken.
 *   otel_metrics_endpoint_missing        warn    `DECO_OTEL_METRICS_ENDPOINT` not set on `vars`. OTLP meter is off; only AE works.
 *   otel_traces_endpoint_missing         warn    `DECO_OTEL_TRACES_ENDPOINT` not set on `vars`. Framework `deco.*` spans drop unless CF Traces is on.
 *   otel_logs_endpoint_missing           warn    `DECO_OTEL_LOGS_ENDPOINT` not set on `vars`. Error logs ride CF Destinations only (head-sampled).
 *
 * Usage (from a site directory):
 *   npx -p @decocms/start deco-audit-observability                # audit cwd (warn mode — exit 0)
 *   npx -p @decocms/start deco-audit-observability --source ./   # explicit source dir
 *   npx -p @decocms/start deco-audit-observability --json         # machine-readable
 *   npx -p @decocms/start deco-audit-observability --mode block   # error findings exit 1 (CI gate)
 *   npx -p @decocms/start deco-audit-observability --github       # GitHub Actions annotations
 *
 * Options:
 *   --source <dir>   Site directory (default: .)
 *   --json           Emit findings as JSON to stdout
 *   --mode <m>       Gate hardness: "warn" (default — always exit 0 on findings,
 *                    just print them) or "block" (exit 1 on any `error` finding).
 *                    See D-16 in MIGRATION_TOOLING_PLAN.md for the rationale on
 *                    why warn is the v1 default.
 *   --github         Emit `::warning::` / `::error::` lines for GitHub Actions
 *                    annotations in addition to the normal text output.
 *   --help, -h       Show this message
 *
 * Exit codes:
 *   0 — no findings, or `--mode warn` (the default) regardless of findings
 *   1 — `--mode block` and at least one `error`-severity finding
 *   2 — file invalid / can't parse
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonc } from "./lib/jsonc";

export type Severity = "error" | "warn" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  message: string;
  /** Suggested remediation — usually a codemod invocation. */
  fix?: string;
}

export type GateMode = "warn" | "block";

interface CliOpts {
  source: string;
  json: boolean;
  help: boolean;
  mode: GateMode;
  github: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    source: ".",
    json: false,
    help: false,
    mode: "warn",
    github: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--source":
        opts.source = argv[++i] ?? ".";
        break;
      case "--json":
        opts.json = true;
        break;
      case "--mode": {
        const value = argv[++i];
        if (value !== "warn" && value !== "block") {
          console.error(
            `audit: --mode must be "warn" or "block" (got "${value ?? ""}")`,
          );
          process.exit(2);
        }
        opts.mode = value;
        break;
      }
      case "--github":
        opts.github = true;
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
    --source <dir>     Site directory (default: .)
    --json             Emit findings as JSON
    --mode <m>         "warn" (default, exit 0) | "block" (exit 1 on errors)
    --github           Emit ::warning::/::error:: lines for GitHub Actions
    --help, -h         This message

  Exit codes:
    0   no findings, OR --mode warn (default — annotate and move on)
    1   --mode block AND at least one error-severity finding
    2   wrangler.jsonc missing or unparseable

  See D-16 in MIGRATION_TOOLING_PLAN.md for the v1 "warn-only" policy.
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

/**
 * Fleet-config drift rules — owned by the same audit because the
 * cumulative effect of "observability block correct, bindings missing"
 * is identical to "observability block missing" (no data lands in
 * ClickHouse).
 *
 * The CLI composes `auditObservabilityBlock` + `auditFleetBindings`.
 * Both return Finding[]; callers concatenate.
 */
export interface WranglerLike {
  observability?: ObservabilityBlock;
  version_metadata?: { binding?: string } | unknown;
  analytics_engine_datasets?: Array<{ binding?: string; dataset?: string }> | unknown;
  tail_consumers?: Array<{ service?: string; environment?: string }> | unknown;
  vars?: Record<string, unknown> | unknown;
}

export function auditFleetBindings(wrangler: WranglerLike): Finding[] {
  const findings: Finding[] = [];

  // version_metadata — required so `service.version` is stamped on every
  // span and log line. Without it, regressions can't be tied to a
  // specific deployment.
  const vmBinding =
    typeof wrangler.version_metadata === "object" &&
    wrangler.version_metadata !== null &&
    "binding" in wrangler.version_metadata
      ? (wrangler.version_metadata as { binding?: string }).binding
      : undefined;
  if (!vmBinding) {
    findings.push({
      id: "version_metadata_binding_missing",
      severity: "error",
      message:
        "wrangler.jsonc is missing a `version_metadata.binding` entry. " +
        "`service.version` won't appear on spans/logs and the deploy-correlation " +
        "panel will be empty. Recommended value: `CF_VERSION_METADATA`.",
      fix: "npx -p @decocms/start deco-cf-observability --write",
    });
  }

  // DECO_METRICS — Analytics Engine binding. The AE meter is the hot-
  // path CF dashboard view; OTLP works without it but we lose the
  // operator-grade short-window panels.
  const aeDatasets = Array.isArray(wrangler.analytics_engine_datasets)
    ? (wrangler.analytics_engine_datasets as Array<{ binding?: string }>)
    : [];
  const hasMetricsBinding = aeDatasets.some((d) => d?.binding === "DECO_METRICS");
  if (!hasMetricsBinding) {
    findings.push({
      id: "analytics_engine_binding_missing",
      severity: "warn",
      message:
        "wrangler.jsonc has no `analytics_engine_datasets[].binding == 'DECO_METRICS'`. " +
        "The AE meter is off; the hot-path operator dashboards in CF will be empty. " +
        "OTLP metrics keep flowing if `DECO_OTEL_METRICS_ENDPOINT` is set.",
      fix: "npx -p @decocms/start deco-cf-observability --write",
    });
  }

  // tail_consumers — must list deco-otel-tail. Phase 1 enrichment is
  // useless without the tail consumer firing.
  const tail = Array.isArray(wrangler.tail_consumers)
    ? (wrangler.tail_consumers as Array<{ service?: string }>)
    : [];
  const hasTailConsumer = tail.some((t) => t?.service === "deco-otel-tail");
  if (!hasTailConsumer) {
    findings.push({
      id: "tail_consumer_missing",
      severity: "error",
      message:
        "wrangler.jsonc has no `tail_consumers[].service == 'deco-otel-tail'` entry. " +
        "100% error-capture is broken — only the head-sampled CF Destinations path " +
        "will report errors, and isolate crashes will be invisible.",
      fix: "npx -p @decocms/start deco-cf-observability --write",
    });
  }

  // DECO_OTEL_*_ENDPOINT env vars. Audit each separately so the message
  // explains which channel is silently no-op.
  const vars =
    typeof wrangler.vars === "object" && wrangler.vars !== null
      ? (wrangler.vars as Record<string, unknown>)
      : {};
  const checkVar = (id: string, name: string, severity: Severity, channel: string) => {
    const v = vars[name];
    if (typeof v !== "string" || v.length === 0) {
      findings.push({
        id,
        severity,
        message:
          `wrangler.jsonc \`vars.${name}\` is not set. ${channel} is a no-op; ` +
          `data captured in this channel never lands in ClickHouse. ` +
          `See docs/observability.md for the canonical endpoints.`,
        fix: "npx -p @decocms/start deco-cf-observability --write",
      });
    }
  };
  checkVar(
    "otel_metrics_endpoint_missing",
    "DECO_OTEL_METRICS_ENDPOINT",
    "warn",
    "OTLP metrics direct-POST",
  );
  checkVar(
    "otel_traces_endpoint_missing",
    "DECO_OTEL_TRACES_ENDPOINT",
    "warn",
    "OTLP traces direct-POST",
  );
  checkVar(
    "otel_logs_endpoint_missing",
    "DECO_OTEL_LOGS_ENDPOINT",
    "warn",
    "OTLP error-log direct-POST",
  );

  return findings;
}

/**
 * One-stop call for the full wrangler audit — composes the
 * observability-block rules with the fleet-binding rules. Both keep
 * working standalone for fine-grained tests.
 */
export function auditWranglerConfig(wrangler: WranglerLike): Finding[] {
  return [
    ...auditObservabilityBlock(wrangler.observability),
    ...auditFleetBindings(wrangler),
  ];
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

  let parsed: WranglerLike;
  try {
    parsed = parseJsonc(fs.readFileSync(file, "utf8")) as WranglerLike;
  } catch (err) {
    console.error(`audit: ${file} could not be parsed: ${(err as Error).message}`);
    process.exit(2);
  }

  const findings = auditWranglerConfig(parsed);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ file, mode: opts.mode, findings }, null, 2) + "\n",
    );
  } else {
    process.stdout.write(findingsToText(file, findings) + "\n");
  }

  if (opts.github) {
    for (const f of findings) {
      // GitHub Actions workflow command. `error` and `warning` annotate the
      // diff; `notice` is informational. We never emit `error` in warn mode
      // even for error-severity rules — the v1 policy is annotate-don't-fail.
      const level = opts.mode === "block" && f.severity === "error"
        ? "error"
        : f.severity === "info" ? "notice" : "warning";
      const msg = `${f.message}${f.fix ? ` (fix: ${f.fix})` : ""}`;
      const escaped = msg.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(
        /\n/g,
        "%0A",
      );
      process.stdout.write(`::${level} title=${f.id}::${escaped}\n`);
    }
  }

  // Exit policy: D-16 / Phase 6 decision.
  //   warn   — annotate only; always exit 0 (CI sees the findings but ships)
  //   block  — exit 1 on any `error`-severity finding
  // The default is `warn` because storefronts are upgraded over weeks; a
  // day-one block would fail PRs that have nothing to do with observability.
  const shouldFail = opts.mode === "block" &&
    findings.some((f) => f.severity === "error");
  process.exit(shouldFail ? 1 : 0);
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
