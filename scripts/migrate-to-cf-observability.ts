#!/usr/bin/env tsx
/**
 * Cloudflare-native observability codemod
 *
 * Rewrites a migrated site's `wrangler.jsonc` so the Cloudflare runtime
 * captures `console.*` logs and auto-instrumented traces directly into
 * the per-Worker observability dashboard. No in-Worker exporter, no
 * external destination — the CF dashboard is the destination.
 *
 * The canonical block this script writes:
 *
 *   "observability": {
 *     "enabled": true,
 *     "logs":   { "enabled": true, "invocation_logs": true,
 *                 "head_sampling_rate": 1, "persist": true },
 *     "traces": { "enabled": true,
 *                 "head_sampling_rate": 0.1, "persist": true }
 *   }
 *
 * `enabled: true` at the top level is the master switch — without it
 * Cloudflare captures nothing, regardless of the sub-block flags.
 * `persist: true` keeps the data queryable in the CF dashboard
 * (Workers Logs view + Traces view). Discovered the hard way during the
 * lebiscuit canary cutover.
 *
 * Behavior:
 *   - dry-run by default — prints a unified diff against the existing
 *     observability block. Safe in CI.
 *   - `--write` performs the in-place edit. The script:
 *       1. locates the existing `"observability": { ... }` block
 *          (matching balanced braces, JSONC-comment-aware),
 *       2. replaces it with the canonical CF-native block, OR
 *       3. appends a new block before the trailing `}` if no
 *          observability key exists yet,
 *       4. validates the result parses as JSON (after stripping
 *          comments) before writing.
 *   - Idempotent: a wrangler.jsonc already on the canonical block is a
 *     no-op. A wrangler.jsonc with stale HyperDX-style destinations is
 *     rewritten to drop them.
 *   - Forwarding to an external destination (an OTel collector for
 *     ClickHouse, a third-party SaaS, etc.) is opt-in via
 *     `--destination-logs` / `--destination-traces`. The destination
 *     itself must be provisioned out-of-band in the CF dashboard.
 *
 * Usage (from a migrated site directory):
 *   npx -p @decocms/start deco-cf-observability                # dry-run
 *   npx -p @decocms/start deco-cf-observability --write        # apply
 *
 *   # Opt-in: also forward to an account-level destination:
 *   npx -p @decocms/start deco-cf-observability --write \
 *     --destination-logs my-logs-dest --destination-traces my-traces-dest
 *
 * Options:
 *   --source <dir>            Site directory containing wrangler.jsonc (default: cwd)
 *   --write                   Apply the change. Otherwise prints diff and exits 1.
 *   --destination-logs <n>    Optional CF destination name to forward logs to.
 *   --destination-traces <n>  Optional CF destination name to forward traces to.
 *   --traces-rate <r>         head_sampling_rate for traces (default: 0.1)
 *   --logs-rate <r>           head_sampling_rate for logs   (default: 1.0)
 *   --no-persist              Set persist:false (do not keep data in CF dashboard)
 *   --persist                 Set persist:true (default — required if no destination)
 *   --help, -h                Show this help
 *
 * Exit codes:
 *   0 — no change needed (already canonical), or dry-run completed cleanly
 *   1 — change required and `--write` not passed (CI signal)
 *   2 — file invalid / can't parse / can't safely edit
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface CliOpts {
  source: string;
  write: boolean;
  /** Optional CF destination slug for logs. Empty = no forwarding. */
  logsDest: string;
  /** Optional CF destination slug for traces. Empty = no forwarding. */
  tracesDest: string;
  tracesRate: number;
  logsRate: number;
  persist: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    source: ".",
    write: false,
    logsDest: "",
    tracesDest: "",
    tracesRate: 0.1,
    logsRate: 1.0,
    // CF dashboard persistence on by default — without either persist:true
    // OR a destination, observability data is captured and discarded.
    persist: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--source":
        opts.source = argv[++i] ?? ".";
        break;
      case "--write":
        opts.write = true;
        break;
      case "--destination-logs":
        opts.logsDest = argv[++i] ?? "";
        break;
      case "--destination-traces":
        opts.tracesDest = argv[++i] ?? "";
        break;
      case "--traces-rate":
        opts.tracesRate = Number(argv[++i] ?? opts.tracesRate);
        break;
      case "--logs-rate":
        opts.logsRate = Number(argv[++i] ?? opts.logsRate);
        break;
      case "--persist":
        opts.persist = true;
        break;
      case "--no-persist":
        opts.persist = false;
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
  @decocms/start — Cloudflare-native observability codemod

  Rewrites wrangler.jsonc so Cloudflare captures \`console.*\` logs and
  auto-instrumented traces directly into the per-Worker dashboard. No
  in-Worker exporter SDK, no external destination required.

  Usage:
    npx -p @decocms/start deco-cf-observability [options]

  Options:
    --source <dir>             Site directory (default: .)
    --write                    Apply the edit. Without it, prints diff and exits 1.
    --destination-logs <n>     Optional CF destination slug to also forward logs to.
    --destination-traces <n>   Optional CF destination slug to also forward traces to.
    --traces-rate <r>          head_sampling_rate for traces (default: 0.1)
    --logs-rate <r>            head_sampling_rate for logs   (default: 1.0)
    --persist                  Keep the dashboard storage tier (default)
    --no-persist               Drop the dashboard tier (only sane when forwarding)
    --help, -h                 This message

  After running with --write you must:
    1. Deploy the Worker (\`wrangler deploy\`).
    2. Verify the CF dashboard shows logs + traces within ~5 min:
         Workers & Pages → <site> → Observability
    3. If migrating from an older app-side OTLP setup, delete the
       now-orphaned secrets:
         wrangler secret delete OTEL_EXPORTER_OTLP_ENDPOINT \\
                                OTEL_EXPORTER_OTLP_HEADERS \\
                                OTEL_SAMPLING_CONFIG \\
                                OTEL_LOG_MIN_SEVERITY
`);
}

// ---------------------------------------------------------------------------
// JSONC handling (no external deps — vendored mini-stripper)
// ---------------------------------------------------------------------------

/**
 * Strip line and block comments from a JSONC string so the result parses
 * with vanilla `JSON.parse`. Preserves quoted strings (handles escaped
 * quotes), preserves whitespace/newlines so line numbers in error
 * messages stay stable.
 */
function stripJsoncComments(src: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let stringQuote = "";
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < src.length) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === stringQuote) {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      // Line comment — skip to newline (preserve newline for line counts).
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      // Block comment — skip to */, preserving newlines for line counts.
      i += 2;
      while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Locate the value range of a top-level JSON object key inside JSONC text.
 * Returns the absolute character span of the value (the contents between
 * the opening `{` and matching closing `}`) and the span of the entire
 * `"key": value` pair, including the key and surrounding whitespace
 * adequate for clean removal.
 *
 * Returns `null` when the key isn't found at the top level.
 *
 * Brace-counting is JSONC-aware (skips comments and strings).
 */
function findTopLevelKeyRange(
  src: string,
  key: string,
): { keyStart: number; valueEnd: number } | null {
  // Walk to find the opening `{` of the top-level object first.
  let i = 0;
  let inString = false;
  let stringQuote = "";

  // Find first `{`
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "{") break;
    i++;
  }
  if (i >= src.length) return null;

  // Now scan inside the top-level object, depth-tracked, looking for our key.
  // Top-level keys appear at depth 1.
  let depth = 1;
  i++;
  const needle = `"${key}"`;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      if (ch === "\\" && i + 1 < src.length) {
        i += 2;
        continue;
      }
      if (ch === stringQuote) inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      // Possible key match. Check.
      if (depth === 1 && src.startsWith(needle, i)) {
        const keyStart = i;
        // Advance past the matched key string.
        i += needle.length;
        // Skip whitespace + `:`
        while (i < src.length && /\s/.test(src[i])) i++;
        if (src[i] !== ":") return null;
        i++;
        while (i < src.length && /\s/.test(src[i])) i++;
        // Now we're at the value. Find its end (handle objects, arrays, strings, primitives).
        if (src[i] === "{" || src[i] === "[") {
          const open = src[i];
          const close = open === "{" ? "}" : "]";
          let d = 1;
          i++;
          while (i < src.length && d > 0) {
            const c2 = src[i];
            const n2 = src[i + 1];
            if (c2 === '"' || c2 === "'") {
              const q = c2;
              i++;
              while (i < src.length) {
                if (src[i] === "\\") {
                  i += 2;
                  continue;
                }
                if (src[i] === q) {
                  i++;
                  break;
                }
                i++;
              }
              continue;
            }
            if (c2 === "/" && n2 === "/") {
              while (i < src.length && src[i] !== "\n") i++;
              continue;
            }
            if (c2 === "/" && n2 === "*") {
              i += 2;
              while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/")) i++;
              i += 2;
              continue;
            }
            if (c2 === open) d++;
            else if (c2 === close) d--;
            i++;
          }
          return { keyStart, valueEnd: i };
        }
        // Primitive / string value — read until comma or closing brace at depth 1.
        while (i < src.length && src[i] !== "," && src[i] !== "}" && src[i] !== "\n") i++;
        return { keyStart, valueEnd: i };
      }
      inString = true;
      stringQuote = '"';
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return null;
    }
    i++;
  }
  return null;
}

/**
 * Locate the end of the top-level object (position of the closing `}`).
 * Used when appending a new key. JSONC-aware.
 */
function findTopLevelObjectEnd(src: string): number | null {
  let i = 0;
  let inString = false;
  let stringQuote = "";

  // Find first `{`
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "{") break;
    i++;
  }
  if (i >= src.length) return null;
  let depth = 1;
  i++;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      if (ch === "\\" && i + 1 < src.length) {
        i += 2;
        continue;
      }
      if (ch === stringQuote) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function renderObservabilityBlock(opts: CliOpts, indent = "  "): string {
  const persist = opts.persist;
  const lines: string[] = [
    `"observability": {`,
    `${indent}// Master switch — without enabled:true at the top level CF`,
    `${indent}// captures nothing, regardless of the sub-block flags.`,
    `${indent}"enabled": true,`,
    `${indent}// Cloudflare captures every console.* call from the Worker`,
    `${indent}// (structured JSON via @decocms/start's logger lands here too).`,
    `${indent}// persist:true keeps them queryable in the CF dashboard.`,
    `${indent}"logs": {`,
    `${indent}${indent}"enabled": true,`,
    `${indent}${indent}"invocation_logs": true,`,
    `${indent}${indent}"head_sampling_rate": ${opts.logsRate},`,
    `${indent}${indent}"persist": ${persist}`,
  ];
  if (opts.logsDest) {
    // Replace the trailing line with a comma'd version, then append the
    // destinations array. Keeps the block valid JSON either way.
    lines[lines.length - 1] = `${indent}${indent}"persist": ${persist},`;
    lines.push(`${indent}${indent}"destinations": ["${opts.logsDest}"]`);
  }
  lines.push(
    `${indent}},`,
    `${indent}// Cloudflare auto-instruments fetch/KV/R2/DO subrequests and`,
    `${indent}// also picks up @opentelemetry/api global-tracer spans the`,
    `${indent}// framework's withTracing() helper emits.`,
    `${indent}"traces": {`,
    `${indent}${indent}"enabled": true,`,
    `${indent}${indent}"head_sampling_rate": ${opts.tracesRate},`,
    `${indent}${indent}"persist": ${persist}`,
  );
  if (opts.tracesDest) {
    lines[lines.length - 1] = `${indent}${indent}"persist": ${persist},`;
    lines.push(`${indent}${indent}"destinations": ["${opts.tracesDest}"]`);
  }
  lines.push(`${indent}}`, `}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Detect "already canonical"
// ---------------------------------------------------------------------------

/**
 * A wrangler.jsonc is considered canonical when it has the master
 * `enabled: true` switch under `observability`, both `logs` and
 * `traces` sub-blocks present, AND the `destinations` arrays match
 * what `--destination-logs` / `--destination-traces` requested (which
 * is "absent" by default). This means a stale HyperDX-style
 * destination array always triggers a rewrite even if the rest of the
 * shape happens to match.
 */
function isAlreadyCanonical(src: string, opts: CliOpts): boolean {
  // Fast structural checks — full JSONC parse only if they pass.
  if (!src.includes(`"observability"`)) return false;
  if (!src.includes(`"enabled": true`) && !src.includes(`"enabled":true`)) {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsoncComments(src));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const obs = (parsed as Record<string, unknown>).observability;
  if (!obs || typeof obs !== "object") return false;
  const obsObj = obs as Record<string, unknown>;
  if (obsObj.enabled !== true) return false;

  const checkLeaf = (leaf: unknown, expectedDest: string): boolean => {
    if (!leaf || typeof leaf !== "object") return false;
    const l = leaf as Record<string, unknown>;
    if (l.enabled !== true) return false;
    const dests = l.destinations;
    if (expectedDest === "") {
      // Caller wants no destinations. Tolerate either absent or an
      // empty array; reject any non-empty array.
      if (dests === undefined) return true;
      return Array.isArray(dests) && dests.length === 0;
    }
    if (!Array.isArray(dests) || dests.length !== 1) return false;
    return dests[0] === expectedDest;
  };

  if (!checkLeaf(obsObj.logs, opts.logsDest)) return false;
  if (!checkLeaf(obsObj.traces, opts.tracesDest)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateJson(src: string): { ok: true } | { ok: false; error: string } {
  try {
    JSON.parse(stripJsoncComments(src));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Diff (tiny line-level)
// ---------------------------------------------------------------------------

function unifiedDiff(before: string, after: string, file: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  // Find the changed window — it's always contiguous because we only edit
  // one block. Keep it brain-simple: shrink both ends, print the rest with
  // -/+ markers.
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let endA = a.length;
  let endB = b.length;
  while (endA > i && endB > i && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ctxStart = Math.max(0, i - 3);
  const ctxAEnd = Math.min(a.length, endA + 3);
  const ctxBEnd = Math.min(b.length, endB + 3);
  const lines: string[] = [];
  lines.push(`--- ${file}  (before)`);
  lines.push(`+++ ${file}  (after)`);
  for (let k = ctxStart; k < i; k++) lines.push(`  ${a[k]}`);
  for (let k = i; k < endA; k++) lines.push(`- ${a[k]}`);
  for (let k = i; k < endB; k++) lines.push(`+ ${b[k]}`);
  for (let k = endA; k < ctxAEnd; k++) lines.push(`  ${a[k]}`);
  // ctxBEnd guards equality at the tail; printing either tail context is fine.
  void ctxBEnd;
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Detect the column-0..keyStart whitespace of the line containing
 * `keyStart`, so we can re-indent every line of the rendered block to
 * match the file's existing nesting depth.
 */
function detectLineIndent(src: string, position: number): string {
  let lineStart = position;
  while (lineStart > 0 && src[lineStart - 1] !== "\n") lineStart--;
  let i = lineStart;
  while (i < src.length && (src[i] === " " || src[i] === "\t")) i++;
  return src.slice(lineStart, i);
}

function reindentBlockBody(block: string, indent: string): string {
  const lines = block.split("\n");
  // Leave line 0 alone — it's spliced in at the existing key position
  // which is already indented by surrounding text. Re-indent the rest.
  return [lines[0], ...lines.slice(1).map((l) => indent + l)].join("\n");
}

function applyEdit(src: string, opts: CliOpts): string {
  const block = renderObservabilityBlock(opts);
  const range = findTopLevelKeyRange(src, "observability");

  if (range) {
    // Replace the existing `"observability": {...}` (key + value) with the
    // new block. Re-indent body lines to match the existing key's column
    // so the final wrangler.jsonc stays cleanly formatted.
    const indent = detectLineIndent(src, range.keyStart);
    const indentedBlock = reindentBlockBody(block, indent);
    return src.slice(0, range.keyStart) + indentedBlock + src.slice(range.valueEnd);
  }

  // No observability key — append before the closing `}` of the top-level object.
  const end = findTopLevelObjectEnd(src);
  if (end == null) {
    throw new Error("wrangler.jsonc: could not locate top-level closing `}`");
  }
  // Walk back from the closing `}` over whitespace to find the last
  // non-whitespace character. We splice in two pieces:
  //  - the comma (if needed) goes immediately AFTER that char so it
  //    sits on the same line as the prior key, not on a line of its own
  //  - the new key + value goes right before the closing `}`
  let scan = end - 1;
  while (scan >= 0 && /\s/.test(src[scan])) scan--;
  const prevChar = scan >= 0 ? src[scan] : "";
  const needsComma = prevChar !== "{" && prevChar !== ",";
  const baseIndent = "  ";
  const indented = block
    .split("\n")
    .map((l) => baseIndent + l)
    .join("\n");
  if (needsComma) {
    const commaInsertAt = scan + 1;
    const before = `${src.slice(0, commaInsertAt)},`;
    // Preserve any whitespace/newlines that were between the prior key
    // and the closing `}` so the new block lines up under existing
    // indentation conventions.
    const between = src.slice(commaInsertAt, end);
    return `${before}${between}${indented}\n${src.slice(end)}`;
  }
  return `${src.slice(0, end)}${indented}\n${src.slice(end)}`;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    showHelp();
    return;
  }
  const wranglerPath = path.join(path.resolve(opts.source), "wrangler.jsonc");
  if (!fs.existsSync(wranglerPath)) {
    console.error(`error: ${wranglerPath} does not exist`);
    process.exit(2);
  }

  const before = fs.readFileSync(wranglerPath, "utf8");

  if (isAlreadyCanonical(before, opts)) {
    console.log(`${wranglerPath} already on the canonical CF observability block — no change.`);
    process.exit(0);
  }

  let after: string;
  try {
    after = applyEdit(before, opts);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const validation = validateJson(after);
  if (!validation.ok) {
    console.error(`error: result wouldn't parse as JSONC: ${validation.error}`);
    console.error("aborting; no changes written.");
    process.exit(2);
  }

  if (!opts.write) {
    console.log(unifiedDiff(before, after, wranglerPath));
    console.log("\nDry-run only. Re-run with --write to apply.");
    process.exit(1);
  }

  fs.writeFileSync(wranglerPath, after, "utf8");
  console.log(`wrote ${wranglerPath}`);
  console.log(`
  Next steps:
    1. wrangler deploy
    2. Verify CF dashboard captures logs + traces (~5 min):
         Workers & Pages → <site> → Observability
    3. If migrating from an older app-side OTLP setup, delete the
       now-orphaned secrets:
         wrangler secret delete OTEL_EXPORTER_OTLP_ENDPOINT \\
                                OTEL_EXPORTER_OTLP_HEADERS \\
                                OTEL_SAMPLING_CONFIG \\
                                OTEL_LOG_MIN_SEVERITY
`);
}

main();
