#!/usr/bin/env node
/**
 * Chrome Performance Trace Comparator
 * Compares two Chrome DevTools traces side-by-side for performance analysis.
 *
 * Usage:
 *   node analyze-traces.mjs <traceA.gz> <traceB.gz> [labelA] [labelB] [flags]
 *
 * Flags:
 *   --all             Include everything (extensions + third-party)
 *   --first-party     Only site code: filters out GTM, analytics, ads, chat, etc.
 *   --output <name>   Write results to <name>.md as markdown
 *   --ai              Generate AI context file with raw data + analysis prompt
 *   (default)         Filters extensions, includes third-party scripts
 *
 * Examples:
 *   node analyze-traces.mjs worker.gz fallback.gz Worker Fallback
 *   node analyze-traces.mjs worker.gz fallback.gz Worker Fallback --first-party
 *   node analyze-traces.mjs worker.gz fallback.gz Worker Fallback --output report
 *   node analyze-traces.mjs worker.gz fallback.gz --all --output results
 *   node analyze-traces.mjs worker.gz fallback.gz Worker Fallback --ai
 */
import { readFileSync, writeFileSync } from "fs";
import { gunzipSync } from "zlib";
import { basename } from "path";

// ── CLI parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

// Parse --output <name>
let outputFile = null;
const outputIdx = args.indexOf("--output");
if (outputIdx !== -1 && args[outputIdx + 1]) {
  outputFile = args[outputIdx + 1];
  if (!outputFile.endsWith(".md")) outputFile += ".md";
  args.splice(outputIdx, 2);
}

const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

const [pathA, pathB, labelA, labelB] = positional;

if (!pathA || !pathB) {
  console.error(
    "Usage: node analyze-traces.mjs <traceA.gz> <traceB.gz> [labelA] [labelB] [--first-party|--all] [--output name]"
  );
  process.exit(1);
}

const MODE_ALL = flags.has("--all");
const MODE_FIRST_PARTY = flags.has("--first-party");
const MODE_AI = flags.has("--ai");
const modeLabel = MODE_ALL
  ? "ALL (incl. extensions)"
  : MODE_FIRST_PARTY
    ? "FIRST-PARTY only"
    : "default (excl. extensions)";

const nameA = labelA || basename(pathA).replace(/\.(json\.)?gz$/, "");
const nameB = labelB || basename(pathB).replace(/\.(json\.)?gz$/, "");

// ── filter helpers ───────────────────────────────────────────────────────────

const isExtension = (url) =>
  url &&
  (url.includes("chrome-extension://") || url.includes("moz-extension://"));

// Known third-party domains/patterns
const THIRD_PARTY_PATTERNS = [
  "googletagmanager.com",
  "google-analytics.com",
  "analytics.google.com",
  "gtag/js",
  "googlesyndication.com",
  "googleads.g.doubleclick.net",
  "google.com/ccm",
  "connect.facebook.net",
  "facebook.com/tr",
  "facebook.com/privacy_sandbox",
  "analytics.tiktok.com",
  "tiktok.com/i18n/pixel",
  "bat.bing.com",
  "clarity.ms",
  "scripts.clarity.ms",
  "hotjar.com",
  "script.hotjar.com",
  "scarabresearch.com",
  "creativecdn.com",
  "cdn.pn.vg",
  "osp-assets.pn.vg",
  "ilabspush",
  "pmweb.com",
  "lilstts.com",
  "onedollarstats.com",
  "push-webchat",
  "storage.googleapis.com/push-webchat",
  "weni-sp-integrations",
];

function isThirdParty(url) {
  if (!url) return false;
  return THIRD_PARTY_PATTERNS.some((p) => url.includes(p));
}

/** Returns true if this URL should be excluded based on current mode */
function shouldExclude(url) {
  if (!url) return false;
  if (!MODE_ALL && isExtension(url)) return true;
  if (MODE_FIRST_PARTY && isThirdParty(url)) return true;
  return false;
}

function shouldExcludeEvent(e) {
  const url =
    e.args?.data?.url ||
    e.args?.data?.scriptName ||
    e.args?.data?.sourceURL ||
    "";
  return shouldExclude(url);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function loadTrace(path) {
  const gz = readFileSync(path);
  const json = gunzipSync(gz).toString("utf-8");
  const data = JSON.parse(json);
  return Array.isArray(data) ? data : data.traceEvents || [];
}

function navStart(events) {
  return (
    events.find(
      (e) =>
        e.name === "navigationStart" ||
        (e.cat === "blink.user_timing" && e.name === "navigationStart")
    )?.ts ?? null
  );
}

// ── metric extractors ────────────────────────────────────────────────────────

function timingMarks(events, ns) {
  const names = [
    "firstPaint",
    "firstContentfulPaint",
    "largestContentfulPaint::Candidate",
    "domInteractive",
    "domContentLoadedEventEnd",
    "domComplete",
    "loadEventEnd",
  ];
  const marks = {};
  for (const e of events) {
    if (!e.cat?.includes("blink.user_timing") && !e.cat?.includes("loading"))
      continue;
    for (const n of names) {
      if (e.name === n || e.name.startsWith(n)) {
        const ms = (e.ts - ns) / 1000;
        if (!marks[n] || ms > marks[n]) marks[n] = ms;
      }
    }
  }
  for (const e of events) {
    if (e.name === "firstPaint" || e.name === "firstContentfulPaint") {
      const ms = (e.ts - ns) / 1000;
      if (!marks[e.name] || ms > marks[e.name]) marks[e.name] = ms;
    }
  }
  return marks;
}

function cls(events) {
  let score = 0;
  const shifts = [];
  for (const e of events) {
    if (
      e.name === "LayoutShift" &&
      e.args?.data?.is_main_frame !== false &&
      !e.args?.data?.had_recent_input
    ) {
      const s = e.args.data.score || 0;
      score += s;
      if (s > 0.001) shifts.push({ score: s, sources: e.args.data.sources });
    }
  }
  return { score, shifts };
}

function tbt(events) {
  let total = 0;
  for (const e of events) {
    if (
      (e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask") &&
      e.dur > 50000 &&
      !shouldExcludeEvent(e)
    ) {
      total += e.dur - 50000;
    }
  }
  return total / 1000;
}

function longTasks(events, ns) {
  const tasks = [];
  for (const e of events) {
    if (
      (e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask") &&
      e.dur > 50000
    ) {
      const taskStart = e.ts;
      const taskEnd = e.ts + e.dur;
      const childScripts = events.filter(
        (c) =>
          c.name === "EvaluateScript" &&
          c.ts >= taskStart &&
          c.ts <= taskEnd &&
          c.args?.data?.url
      );
      const allExcluded =
        childScripts.length > 0 &&
        childScripts.every((c) => shouldExclude(c.args.data.url));
      if (!allExcluded) {
        const mainScript = childScripts.find((c) => !shouldExclude(c.args.data.url));
        tasks.push({
          ts_ms: (e.ts - ns) / 1000,
          dur_ms: e.dur / 1000,
          script: mainScript
            ? (mainScript.args.data.url || "").split("/").slice(-2).join("/")
            : "",
        });
      }
    }
  }
  return tasks.sort((a, b) => b.dur_ms - a.dur_ms);
}

function layoutTree(events) {
  let count = 0,
    total = 0;
  for (const e of events) {
    if (e.name === "UpdateLayoutTree" && e.dur > 1000) {
      count++;
      total += e.dur;
    }
  }
  return { count, total_ms: total / 1000 };
}

function v8Compile(events) {
  let count = 0,
    total = 0;
  const top = [];
  for (const e of events) {
    if (
      (e.name === "v8.compile" || e.name === "V8.CompileCode") &&
      e.dur > 1000 &&
      !shouldExcludeEvent(e)
    ) {
      count++;
      total += e.dur;
      top.push({
        dur_ms: e.dur / 1000,
        url: (e.args?.data?.url || "inline").split("/").slice(-2).join("/"),
      });
    }
  }
  top.sort((a, b) => b.dur_ms - a.dur_ms);
  return { count, total_ms: total / 1000, top: top.slice(0, 10) };
}

function scriptEval(events, ns) {
  const scripts = [];
  for (const e of events) {
    if (
      e.name === "EvaluateScript" &&
      e.dur > 5000 &&
      !shouldExcludeEvent(e)
    ) {
      scripts.push({
        url: (e.args?.data?.url || "inline").split("/").slice(-2).join("/"),
        fullUrl: e.args?.data?.url || "inline",
        ts_ms: (e.ts - ns) / 1000,
        dur_ms: e.dur / 1000,
        isThirdParty: isThirdParty(e.args?.data?.url || ""),
      });
    }
  }
  return scripts.sort((a, b) => b.dur_ms - a.dur_ms).slice(0, 15);
}

function paintEvents(events) {
  let count = 0,
    total = 0;
  for (const e of events) {
    if (e.name === "Paint" && e.dur > 500) {
      count++;
      total += e.dur;
    }
  }
  return { count, total_ms: total / 1000 };
}

function htmlDoc(events) {
  const htmlResps = events.filter(
    (e) =>
      e.name === "ResourceReceiveResponse" &&
      e.args?.data?.mimeType?.includes("text/html")
  );
  for (const resp of htmlResps) {
    const id = resp.args.data.requestId;
    const send = events.find(
      (e) =>
        e.name === "ResourceSendRequest" && e.args?.data?.requestId === id
    );
    if (!send) continue;
    const url = send.args.data.url || "";
    if (isExtension(url)) continue;
    if (url.includes("sw_iframe") || url.includes("service_worker")) continue;
    const finish = events.find(
      (e) => e.name === "ResourceFinish" && e.args?.data?.requestId === id
    );
    return {
      url,
      encoded_kb: (finish?.args?.data?.encodedDataLength || 0) / 1024,
      decoded_kb: (finish?.args?.data?.decodedBodyLength || 0) / 1024,
      ttfb_ms: (resp.ts - send.ts) / 1000,
      total_ms: finish ? (finish.ts - send.ts) / 1000 : 0,
    };
  }
  return null;
}

function serverFnPayload(events) {
  const sends = events.filter(
    (e) =>
      e.name === "ResourceSendRequest" &&
      (e.args?.data?.url?.includes("_serverFn") ||
        e.args?.data?.url?.includes("deco/render"))
  );
  let encoded = 0,
    decoded = 0,
    count = 0;
  for (const s of sends) {
    const id = s.args.data.requestId;
    const finish = events.find(
      (e) => e.name === "ResourceFinish" && e.args?.data?.requestId === id
    );
    if (finish) {
      encoded += finish.args.data.encodedDataLength || 0;
      decoded += finish.args.data.decodedBodyLength || 0;
    }
    count++;
  }
  return { count, encoded_kb: encoded / 1024, decoded_kb: decoded / 1024 };
}

function imageStats(events, ns) {
  const imgDomains = [
    "vtexassets",
    "decoims",
    "decoazn",
    "decocache",
    "deco-sites-assets",
  ];
  const sends = events.filter((e) => {
    if (e.name !== "ResourceSendRequest") return false;
    const url = e.args?.data?.url || "";
    return imgDomains.some((d) => url.includes(d));
  });

  const pivot = events.find(
    (e) =>
      e.name === "ResourceSendRequest" &&
      (e.args?.data?.url?.includes("_serverFn") ||
        e.args?.data?.url?.includes("deco/render"))
  );
  const pivotTs = pivot ? (pivot.ts - ns) / 1000 : Infinity;

  let before = 0,
    after = 0,
    totalEncoded = 0;
  for (const s of sends) {
    const ts = (s.ts - ns) / 1000;
    const id = s.args.data.requestId;
    const finish = events.find(
      (e) => e.name === "ResourceFinish" && e.args?.data?.requestId === id
    );
    totalEncoded += finish?.args?.data?.encodedDataLength || 0;
    if (ts < pivotTs) before++;
    else after++;
  }
  return {
    total: sends.length,
    before_deferred: before,
    after_deferred: after,
    total_kb: totalEncoded / 1024,
  };
}

function jsBundleSize(events) {
  const sends = events.filter(
    (e) =>
      e.name === "ResourceSendRequest" &&
      e.args?.data?.url &&
      /\.(js|mjs)(\?|$)/.test(e.args.data.url) &&
      !shouldExclude(e.args.data.url)
  );
  const finishes = {};
  for (const e of events) {
    if (e.name === "ResourceFinish" && e.args?.data) {
      finishes[e.args.data.requestId] = e.args.data;
    }
  }

  let total = 0,
    firstPartyTotal = 0,
    thirdPartyTotal = 0;
  const bundles = [];
  for (const s of sends) {
    const f = finishes[s.args.data.requestId];
    const size = f?.encodedDataLength || 0;
    const url = s.args.data.url;
    const is3p = isThirdParty(url);
    total += size;
    if (is3p) thirdPartyTotal += size;
    else firstPartyTotal += size;
    bundles.push({
      url,
      kb: size / 1024,
      isThirdParty: is3p,
    });
  }
  bundles.sort((a, b) => b.kb - a.kb);
  return {
    count: sends.length,
    total_kb: total / 1024,
    firstParty_kb: firstPartyTotal / 1024,
    thirdParty_kb: thirdPartyTotal / 1024,
    top: bundles.slice(0, 15),
  };
}

function requestCount(events) {
  return events.filter(
    (e) =>
      e.name === "ResourceSendRequest" &&
      !shouldExclude(e.args?.data?.url || "")
  ).length;
}

function domainBreakdown(events) {
  const domains = {};
  for (const e of events) {
    if (e.name !== "ResourceSendRequest" || !e.args?.data?.url) continue;
    if (shouldExclude(e.args.data.url)) continue;
    try {
      const d = new URL(e.args.data.url).hostname;
      if (d) domains[d] = (domains[d] || 0) + 1;
    } catch {}
  }
  return Object.entries(domains)
    .sort((a, b) => b[1] - a[1])
    .map(([d, c]) => ({ domain: d, count: c }));
}

function lcpCandidate(events, ns) {
  const candidates = events.filter(
    (e) =>
      e.name === "largestContentfulPaint::Candidate" ||
      e.name === "LargestContentfulPaint::Candidate"
  );
  if (!candidates.length) return null;
  const last = candidates[candidates.length - 1];
  return {
    ts_ms: (last.ts - ns) / 1000,
    size: last.args?.data?.size || "?",
    type: last.args?.data?.type || "?",
    url: last.args?.data?.url || "",
  };
}

function parseHTMLStats(events) {
  let count = 0,
    total = 0;
  for (const e of events) {
    if (e.name === "ParseHTML" && e.dur) {
      count++;
      total += e.dur;
    }
  }
  return { count, total_ms: total / 1000 };
}

// ── extract all metrics from a trace ─────────────────────────────────────────

function extract(path) {
  const events = loadTrace(path);
  const ns = navStart(events);
  if (!ns) {
    console.error(`No navigationStart in ${path}`);
    process.exit(1);
  }

  const marks = timingMarks(events, ns);
  const doc = htmlDoc(events);
  const sfn = serverFnPayload(events);
  const imgs = imageStats(events, ns);
  const js = jsBundleSize(events);
  const layout = layoutTree(events);
  const v8 = v8Compile(events);
  const paint = paintEvents(events);
  const lcp = lcpCandidate(events, ns);
  const ph = parseHTMLStats(events);
  const lt = longTasks(events, ns);
  const scripts = scriptEval(events, ns);
  const clsData = cls(events);

  return {
    events: events.length,
    marks,
    doc,
    serverFn: sfn,
    images: imgs,
    js,
    requests: requestCount(events),
    domains: domainBreakdown(events),
    cls: clsData.score,
    clsShifts: clsData.shifts,
    tbt: tbt(events),
    longTasks: lt,
    layout,
    v8,
    paint,
    lcp,
    parseHTML: ph,
    scripts,
  };
}

// ── output buffer ────────────────────────────────────────────────────────────

const output = [];
const log = (s = "") => output.push(s);

// ── shared formatting ────────────────────────────────────────────────────────

function fmt(val, unit) {
  if (val == null || val === "?") return "-";
  const n = typeof val === "number" ? val : parseFloat(val);
  if (isNaN(n)) return "-";
  if (unit === "") return Number.isInteger(n) ? String(n) : n.toFixed(4);
  return n.toFixed(1) + unit;
}

function delta(a, b, lowerBetter = true) {
  if (a == null || b == null) return { text: "-", icon: " ", mdIcon: "" };
  const na = typeof a === "number" ? a : parseFloat(a);
  const nb = typeof b === "number" ? b : parseFloat(b);
  if (isNaN(na) || isNaN(nb)) return { text: "-", icon: " ", mdIcon: "" };
  const diff = na - nb;
  const pct = nb !== 0 ? ((diff / nb) * 100).toFixed(0) : "∞";
  const sign = diff > 0 ? "+" : "";
  const better = lowerBetter ? diff < -0.001 : diff > 0.001;
  const worse = lowerBetter ? diff > 0.001 : diff < -0.001;
  const icon = better ? "✅" : worse ? "❌" : "🟰";
  const mdIcon = better ? "✅" : worse ? "❌" : "🟰";
  return { text: `${sign}${pct}%`, icon, mdIcon };
}

function row(label, valA, valB, unit = "ms", lowerBetter = true) {
  const d = delta(valA, valB, lowerBetter);
  return { label, a: fmt(valA, unit), b: fmt(valB, unit), delta: d.text, icon: d.icon, mdIcon: d.mdIcon };
}

function infoRow(label, valA, valB, unit = "ms") {
  return { label, a: fmt(valA, unit), b: fmt(valB, unit), delta: "-", icon: "ℹ️", mdIcon: "ℹ️" };
}

// ── terminal table ───────────────────────────────────────────────────────────

function printTable(title, rows) {
  if (!rows.length) return;

  const colW = {
    icon: 2,
    label: Math.max(20, ...rows.map((r) => r.label.length)),
    a: Math.max(nameA.length, ...rows.map((r) => r.a.length)),
    b: Math.max(nameB.length, ...rows.map((r) => r.b.length)),
    delta: Math.max(5, ...rows.map((r) => r.delta.length)),
  };

  const topBorder = `┌${"─".repeat(colW.icon + 2)}┬${"─".repeat(colW.label + 2)}┬${"─".repeat(colW.a + 2)}┬${"─".repeat(colW.b + 2)}┬${"─".repeat(colW.delta + 2)}┐`;
  const sep = `├${"─".repeat(colW.icon + 2)}┼${"─".repeat(colW.label + 2)}┼${"─".repeat(colW.a + 2)}┼${"─".repeat(colW.b + 2)}┼${"─".repeat(colW.delta + 2)}┤`;
  const bottomBorder = `└${"─".repeat(colW.icon + 2)}┴${"─".repeat(colW.label + 2)}┴${"─".repeat(colW.a + 2)}┴${"─".repeat(colW.b + 2)}┴${"─".repeat(colW.delta + 2)}┘`;
  const pad = (s, w, align = "right") =>
    align === "left" ? s.padEnd(w) : s.padStart(w);

  log(`\n  ${title}`);
  log(topBorder);
  log(`│ ${pad("", colW.icon, "left")} │ ${pad("Métrica", colW.label, "left")} │ ${pad(nameA, colW.a)} │ ${pad(nameB, colW.b)} │ ${pad("Delta", colW.delta)} │`);
  log(sep);
  for (const r of rows) {
    log(`│ ${pad(r.icon, colW.icon, "left")} │ ${pad(r.label, colW.label, "left")} │ ${pad(r.a, colW.a)} │ ${pad(r.b, colW.b)} │ ${pad(r.delta, colW.delta)} │`);
  }
  log(bottomBorder);
}

function printList(title, items) {
  if (!items.length) return;
  log(`\n  ${title}`);
  for (const item of items) log(`    ${item}`);
}

// ── markdown table ───────────────────────────────────────────────────────────

function mdTable(title, rows) {
  if (!rows.length) return "";
  const lines = [];
  lines.push(`### ${title}\n`);
  lines.push(`| | Métrica | ${nameA} | ${nameB} | Delta |`);
  lines.push(`|---|---|---:|---:|---:|`);
  for (const r of rows) {
    lines.push(`| ${r.mdIcon} | ${r.label} | ${r.a} | ${r.b} | ${r.delta} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function mdList(title, items) {
  if (!items.length) return "";
  const lines = [`**${title}**\n`];
  for (const item of items) lines.push(`- ${item}`);
  lines.push("");
  return lines.join("\n");
}

function mdDetailBlock(title, sections) {
  const lines = [`<details>\n<summary>${title}</summary>\n`];
  for (const [label, items] of sections) {
    lines.push(`**${label}:**\n`);
    lines.push("```");
    for (const item of items) lines.push(item);
    lines.push("```\n");
  }
  lines.push("</details>\n");
  return lines.join("\n");
}

// ── main ─────────────────────────────────────────────────────────────────────

log(`\n  ⚡ Chrome Trace Comparison`);
log(`  ${nameA} vs ${nameB}`);
log(`  Mode: ${modeLabel}`);
if (outputFile) log(`  Output: ${outputFile}`);
log("");

const a = extract(pathA);
const b = extract(pathB);

// ── build rows ───────────────────────────────────────────────────────────────

const cwvRows = [
  row("FCP", a.marks.firstContentfulPaint, b.marks.firstContentfulPaint),
  row("LCP", a.lcp?.ts_ms, b.lcp?.ts_ms),
  row("CLS", a.cls, b.cls, "", true),
  row("TBT", a.tbt, b.tbt),
];

const docRows = [
  row("HTML encoded", a.doc?.encoded_kb, b.doc?.encoded_kb, "KB"),
  row("HTML decoded", a.doc?.decoded_kb, b.doc?.decoded_kb, "KB"),
  row("TTFB", a.doc?.ttfb_ms, b.doc?.ttfb_ms),
  row("Doc download", a.doc?.total_ms, b.doc?.total_ms),
  infoRow("_serverFn payload", a.serverFn.decoded_kb, b.serverFn.decoded_kb, "KB"),
  infoRow("_serverFn calls", a.serverFn.count, b.serverFn.count, ""),
  row("ParseHTML total", a.parseHTML.total_ms, b.parseHTML.total_ms),
];

const domRows = [
  row("domInteractive", a.marks.domInteractive, b.marks.domInteractive),
  row("domContentLoaded", a.marks.domContentLoadedEventEnd, b.marks.domContentLoadedEventEnd),
  row("domComplete", a.marks.domComplete, b.marks.domComplete),
  row("loadEventEnd", a.marks.loadEventEnd, b.marks.loadEventEnd),
];

const imgRows = [
  row("Total images", a.images.total, b.images.total, "", true),
  row("Before deferred", a.images.before_deferred, b.images.before_deferred, "", true),
  row("After deferred", a.images.after_deferred, b.images.after_deferred, "", true),
  row("Images size", a.images.total_kb, b.images.total_kb, "KB", true),
];

const jsRows = [
  row("JS bundles", a.js.count, b.js.count, "", true),
  row("Total JS size", a.js.total_kb, b.js.total_kb, "KB", true),
];
if (!MODE_ALL) {
  jsRows.push(
    row("1st-party JS", a.js.firstParty_kb, b.js.firstParty_kb, "KB", true),
    row("3rd-party JS", a.js.thirdParty_kb, b.js.thirdParty_kb, "KB", true)
  );
}

const layoutRows = [
  row("Long tasks (>50ms)", a.longTasks.length, b.longTasks.length, "", true),
  row("LayoutTree count", a.layout.count, b.layout.count, "", true),
  row("LayoutTree total", a.layout.total_ms, b.layout.total_ms),
  row("Paint events", a.paint.count, b.paint.count, "", true),
  row("Paint total", a.paint.total_ms, b.paint.total_ms),
];

const v8Rows = [
  row("Compile count", a.v8.count, b.v8.count, "", true),
  row("Compile total", a.v8.total_ms, b.v8.total_ms),
];

const netRows = [
  row("Total requests", a.requests, b.requests, "", true),
];

// Domain rows
const allDomains = new Set([
  ...a.domains.map((d) => d.domain),
  ...b.domains.map((d) => d.domain),
]);
const domainData = [...allDomains]
  .map((d) => {
    const ac = a.domains.find((x) => x.domain === d)?.count || 0;
    const bc = b.domains.find((x) => x.domain === d)?.count || 0;
    return { domain: d, a: ac, b: bc, total: ac + bc };
  })
  .sort((x, y) => y.total - x.total)
  .slice(0, 15);
const domainTableRows = domainData.map((d) =>
  row(d.domain.slice(0, 40), d.a, d.b, "", true)
);

const aOnly = a.domains.filter((d) => !b.domains.find((x) => x.domain === d.domain)).map((d) => d.domain);
const bOnly = b.domains.filter((d) => !a.domains.find((x) => x.domain === d.domain)).map((d) => d.domain);

// Score
const scoredMetrics = [
  { label: "LCP", a: a.lcp?.ts_ms, b: b.lcp?.ts_ms, weight: 25 },
  { label: "CLS", a: a.cls, b: b.cls, weight: 25 },
  { label: "TBT", a: a.tbt, b: b.tbt, weight: 30 },
  { label: "Requests", a: a.requests, b: b.requests, weight: 10 },
  { label: "JS Size", a: a.js.total_kb, b: b.js.total_kb, weight: 10 },
];

let wins = 0, losses = 0, ties = 0;
for (const m of scoredMetrics) {
  if (m.a == null || m.b == null) continue;
  if (m.a < m.b - 0.001) wins++;
  else if (m.a > m.b + 0.001) losses++;
  else ties++;
}

const scoreA = scoredMetrics.reduce((sum, m) => {
  if (m.a == null || m.b == null || m.b === 0) return sum;
  const ratio = m.a / m.b;
  return sum + (ratio < 1 ? m.weight : -m.weight * (ratio - 1));
}, 0);

const verdict =
  scoreA > 10 ? `${nameA} is significantly better`
  : scoreA > 0 ? `${nameA} is slightly better`
  : scoreA < -10 ? `${nameB} is significantly better`
  : scoreA < 0 ? `${nameB} is slightly better`
  : "Roughly equal";

// ── terminal output ──────────────────────────────────────────────────────────

printTable("Core Web Vitals", cwvRows);
printTable("Document & SSR", docRows);
printTable("DOM Timing", domRows);
printTable("Images", imgRows);
printTable("JavaScript", jsRows);
printTable("Layout & Rendering", layoutRows);
printTable("V8 Compile", v8Rows);
printTable("Network", netRows);
printTable("Top Domains", domainTableRows);

if (aOnly.length) printList(`Domains ONLY in ${nameA}:`, aOnly);
if (bOnly.length) printList(`Domains ONLY in ${nameB}:`, bOnly);

if (a.scripts.length || b.scripts.length) {
  log(`\n  Top Script Evaluation`);
  for (const [label, scripts] of [[nameA, a.scripts], [nameB, b.scripts]]) {
    log(`  ${label}:`);
    for (const s of scripts.slice(0, 8)) {
      const tag = s.isThirdParty ? " [3P]" : "";
      log(`    ${s.dur_ms.toFixed(1)}ms @${s.ts_ms.toFixed(0)}ms  ${s.url}${tag}`);
    }
  }
}

if (a.v8.top.length || b.v8.top.length) {
  log(`\n  Top V8 Compile`);
  for (const [label, top] of [[nameA, a.v8.top], [nameB, b.v8.top]]) {
    log(`  ${label}:`);
    for (const c of top.slice(0, 5)) {
      log(`    ${c.dur_ms.toFixed(1)}ms  ${c.url}`);
    }
  }
}

if (a.js.top.length || b.js.top.length) {
  log(`\n  Top JS Bundles by Size`);
  for (const [label, top] of [[nameA, a.js.top], [nameB, b.js.top]]) {
    log(`  ${label}:`);
    for (const j of top.slice(0, 10)) {
      const short = j.url.length > 80 ? "..." + j.url.slice(-77) : j.url;
      const tag = j.isThirdParty ? " [3P]" : "";
      log(`    ${j.kb.toFixed(1)}KB  ${short}${tag}`);
    }
  }
}

if (a.longTasks.length || b.longTasks.length) {
  log(`\n  Long Tasks (>50ms)`);
  for (const [label, tasks] of [[nameA, a.longTasks], [nameB, b.longTasks]]) {
    log(`  ${label}: ${tasks.length} tasks`);
    for (const t of tasks.slice(0, 8)) {
      const script = t.script ? `  ${t.script}` : "";
      log(`    ${t.dur_ms.toFixed(1)}ms @${t.ts_ms.toFixed(0)}ms${script}`);
    }
  }
}

log(`\n  ${"═".repeat(50)}`);
log(`  SUMMARY`);
log(`  ${"═".repeat(50)}`);
log(`\n  ${nameA} wins: ${wins}  |  ${nameB} wins: ${losses}  |  ties: ${ties}`);
log(`  Weighted score: ${scoreA.toFixed(1)} → ${verdict}`);
log("");

// Print terminal output
console.log(output.join("\n"));

// ── markdown output ──────────────────────────────────────────────────────────

if (outputFile) {
  const md = [];
  const date = new Date().toISOString().split("T")[0];

  md.push(`# Performance Trace Comparison`);
  md.push(`> **${nameA}** vs **${nameB}** | ${date} | Mode: ${modeLabel}\n`);

  md.push(mdTable("Core Web Vitals", cwvRows));
  md.push(mdTable("Document & SSR", docRows));
  md.push(mdTable("DOM Timing", domRows));
  md.push(mdTable("Images", imgRows));
  md.push(mdTable("JavaScript", jsRows));
  md.push(mdTable("Layout & Rendering", layoutRows));
  md.push(mdTable("V8 Compile", v8Rows));
  md.push(mdTable("Network", netRows));
  md.push(mdTable("Top Domains", domainTableRows));

  if (aOnly.length) md.push(mdList(`Domains only in ${nameA}`, aOnly));
  if (bOnly.length) md.push(mdList(`Domains only in ${nameB}`, bOnly));

  // Detail blocks
  const scriptSections = [];
  for (const [label, scripts] of [[nameA, a.scripts], [nameB, b.scripts]]) {
    if (scripts.length) {
      scriptSections.push([
        label,
        scripts.slice(0, 8).map((s) => {
          const tag = s.isThirdParty ? " [3P]" : "";
          return `${s.dur_ms.toFixed(1)}ms @${s.ts_ms.toFixed(0)}ms  ${s.url}${tag}`;
        }),
      ]);
    }
  }
  if (scriptSections.length) md.push(mdDetailBlock("Top Script Evaluation", scriptSections));

  const jsSections = [];
  for (const [label, top] of [[nameA, a.js.top], [nameB, b.js.top]]) {
    if (top.length) {
      jsSections.push([
        label,
        top.slice(0, 10).map((j) => {
          const short = j.url.length > 80 ? "..." + j.url.slice(-77) : j.url;
          const tag = j.isThirdParty ? " [3P]" : "";
          return `${j.kb.toFixed(1)}KB  ${short}${tag}`;
        }),
      ]);
    }
  }
  if (jsSections.length) md.push(mdDetailBlock("Top JS Bundles by Size", jsSections));

  const taskSections = [];
  for (const [label, tasks] of [[nameA, a.longTasks], [nameB, b.longTasks]]) {
    if (tasks.length) {
      taskSections.push([
        `${label} (${tasks.length} tasks)`,
        tasks.slice(0, 8).map((t) => {
          const script = t.script ? `  ${t.script}` : "";
          return `${t.dur_ms.toFixed(1)}ms @${t.ts_ms.toFixed(0)}ms${script}`;
        }),
      ]);
    }
  }
  if (taskSections.length) md.push(mdDetailBlock("Long Tasks (>50ms)", taskSections));

  md.push(`---\n`);
  md.push(`## Summary\n`);
  md.push(`**${nameA}** wins: ${wins} | **${nameB}** wins: ${losses} | ties: ${ties}\n`);
  md.push(`Weighted score: **${scoreA.toFixed(1)}** → ${verdict}\n`);

  writeFileSync(outputFile, md.join("\n"), "utf-8");
  console.log(`\n  📄 Report saved to ${outputFile}`);
}

// ── AI context output ────────────────────────────────────────────────────────

if (MODE_AI) {
  const aiFile = outputFile
    ? outputFile.replace(/\.md$/, "-ai-context.md")
    : "trace-ai-context.md";

  const date = new Date().toISOString().split("T")[0];
  const ai = [];

  ai.push(`# Performance Trace Analysis Context`);
  ai.push(`> Generated ${date} | ${nameA} vs ${nameB} | Mode: ${modeLabel}\n`);
  ai.push(`## Instructions\n`);
  ai.push(`You are analyzing Chrome Performance traces comparing two versions of a website.`);
  ai.push(`**${nameA}** is the variant being tested. **${nameB}** is the baseline/control.`);
  ai.push(`Use the raw data below to:`);
  ai.push(`1. Identify the top 3-5 performance wins and losses`);
  ai.push(`2. Find root causes for regressions (CLS, TBT, long tasks, large bundles)`);
  ai.push(`3. Suggest concrete, actionable fixes ranked by impact`);
  ai.push(`4. Call out any third-party scripts causing disproportionate impact`);
  ai.push(`5. Note any anomalies in the data (missing metrics, unexpected patterns)\n`);

  // Raw metrics as structured data
  ai.push(`## Raw Metrics\n`);
  ai.push("```json");

  const rawData = {
    date,
    mode: modeLabel,
    traceA: { label: nameA, file: pathA },
    traceB: { label: nameB, file: pathB },
    coreWebVitals: {
      [nameA]: {
        FCP: a.marks.firstContentfulPaint ?? null,
        LCP: a.lcp?.ts_ms ?? null,
        CLS: a.cls,
        TBT: a.tbt,
      },
      [nameB]: {
        FCP: b.marks.firstContentfulPaint ?? null,
        LCP: b.lcp?.ts_ms ?? null,
        CLS: b.cls,
        TBT: b.tbt,
      },
    },
    document: {
      [nameA]: {
        htmlEncoded_kb: a.doc?.encoded_kb ?? null,
        htmlDecoded_kb: a.doc?.decoded_kb ?? null,
        ttfb_ms: a.doc?.ttfb_ms ?? null,
        docDownload_ms: a.doc?.total_ms ?? null,
        serverFnPayload_kb: a.serverFn.decoded_kb,
        serverFnCalls: a.serverFn.count,
        parseHTML_ms: a.parseHTML.total_ms,
      },
      [nameB]: {
        htmlEncoded_kb: b.doc?.encoded_kb ?? null,
        htmlDecoded_kb: b.doc?.decoded_kb ?? null,
        ttfb_ms: b.doc?.ttfb_ms ?? null,
        docDownload_ms: b.doc?.total_ms ?? null,
        serverFnPayload_kb: b.serverFn.decoded_kb,
        serverFnCalls: b.serverFn.count,
        parseHTML_ms: b.parseHTML.total_ms,
      },
    },
    domTiming: {
      [nameA]: {
        domInteractive: a.marks.domInteractive,
        domContentLoaded: a.marks.domContentLoadedEventEnd,
        domComplete: a.marks.domComplete,
        loadEventEnd: a.marks.loadEventEnd,
      },
      [nameB]: {
        domInteractive: b.marks.domInteractive,
        domContentLoaded: b.marks.domContentLoadedEventEnd,
        domComplete: b.marks.domComplete,
        loadEventEnd: b.marks.loadEventEnd,
      },
    },
    images: {
      [nameA]: a.images,
      [nameB]: b.images,
    },
    javascript: {
      [nameA]: {
        bundles: a.js.count,
        total_kb: a.js.total_kb,
        firstParty_kb: a.js.firstParty_kb,
        thirdParty_kb: a.js.thirdParty_kb,
        topBundles: a.js.top.slice(0, 10).map((j) => ({
          url: j.url.length > 120 ? "..." + j.url.slice(-117) : j.url,
          kb: j.kb,
          thirdParty: j.isThirdParty,
        })),
      },
      [nameB]: {
        bundles: b.js.count,
        total_kb: b.js.total_kb,
        firstParty_kb: b.js.firstParty_kb,
        thirdParty_kb: b.js.thirdParty_kb,
        topBundles: b.js.top.slice(0, 10).map((j) => ({
          url: j.url.length > 120 ? "..." + j.url.slice(-117) : j.url,
          kb: j.kb,
          thirdParty: j.isThirdParty,
        })),
      },
    },
    layout: {
      [nameA]: {
        longTasks: a.longTasks.length,
        longTasksDetail: a.longTasks.slice(0, 10).map((t) => ({
          dur_ms: t.dur_ms,
          ts_ms: t.ts_ms,
          script: t.script || null,
        })),
        layoutTreeCount: a.layout.count,
        layoutTreeTotal_ms: a.layout.total_ms,
        paintEvents: a.paint.count,
        paintTotal_ms: a.paint.total_ms,
      },
      [nameB]: {
        longTasks: b.longTasks.length,
        longTasksDetail: b.longTasks.slice(0, 10).map((t) => ({
          dur_ms: t.dur_ms,
          ts_ms: t.ts_ms,
          script: t.script || null,
        })),
        layoutTreeCount: b.layout.count,
        layoutTreeTotal_ms: b.layout.total_ms,
        paintEvents: b.paint.count,
        paintTotal_ms: b.paint.total_ms,
      },
    },
    v8Compile: {
      [nameA]: {
        count: a.v8.count,
        total_ms: a.v8.total_ms,
        top: a.v8.top.slice(0, 8),
      },
      [nameB]: {
        count: b.v8.count,
        total_ms: b.v8.total_ms,
        top: b.v8.top.slice(0, 8),
      },
    },
    scriptEvaluation: {
      [nameA]: a.scripts.slice(0, 10).map((s) => ({
        url: s.url,
        dur_ms: s.dur_ms,
        ts_ms: s.ts_ms,
        thirdParty: s.isThirdParty,
      })),
      [nameB]: b.scripts.slice(0, 10).map((s) => ({
        url: s.url,
        dur_ms: s.dur_ms,
        ts_ms: s.ts_ms,
        thirdParty: s.isThirdParty,
      })),
    },
    network: {
      [nameA]: { totalRequests: a.requests, domains: a.domains.slice(0, 20) },
      [nameB]: { totalRequests: b.requests, domains: b.domains.slice(0, 20) },
      domainsOnlyInA: aOnly,
      domainsOnlyInB: bOnly,
    },
    summary: {
      wins: { [nameA]: wins, [nameB]: losses, ties },
      weightedScore: scoreA,
      verdict,
    },
  };

  ai.push(JSON.stringify(rawData, null, 2));
  ai.push("```\n");

  // Also include the formatted comparison tables for quick reference
  ai.push(`## Formatted Comparison\n`);
  ai.push(`The tables below are the same data formatted for readability.\n`);

  const tables = [
    ["Core Web Vitals", cwvRows],
    ["Document & SSR", docRows],
    ["DOM Timing", domRows],
    ["Images", imgRows],
    ["JavaScript", jsRows],
    ["Layout & Rendering", layoutRows],
    ["V8 Compile", v8Rows],
    ["Network", netRows],
  ];
  for (const [title, rows] of tables) {
    ai.push(mdTable(title, rows));
  }

  ai.push(`## Summary\n`);
  ai.push(`**${nameA}** wins: ${wins} | **${nameB}** wins: ${losses} | ties: ${ties}`);
  ai.push(`Weighted score: **${scoreA.toFixed(1)}** → ${verdict}\n`);

  writeFileSync(aiFile, ai.join("\n"), "utf-8");
  console.log(`\n  🤖 AI context saved to ${aiFile}`);
}
