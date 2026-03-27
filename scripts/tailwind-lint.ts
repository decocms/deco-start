#!/usr/bin/env tsx
/**
 * Tailwind Lint Script — @decocms/start
 *
 * Detects and auto-fixes Tailwind v3 → v4 migration issues:
 *
 * 1. Responsive classes in wrong order (v4 CSS cascade issue)
 * 2. Arbitrary values with native Tailwind equivalents (px-[16px] → px-4)
 * 3. Deprecated/renamed classes (v3→v4 + DaisyUI v4→v5)
 *
 * Usage (from site root):
 *   npx tsx node_modules/@decocms/start/scripts/tailwind-lint.ts             # scan src/
 *   npx tsx node_modules/@decocms/start/scripts/tailwind-lint.ts --fix        # auto-fix
 *   npx tsx node_modules/@decocms/start/scripts/tailwind-lint.ts src/sections # scan specific dir
 *
 * Also works on pre-migration code (detects class= in addition to className=)
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ── Breakpoint order (mobile-first) ─────────────────────────────
const BREAKPOINT_ORDER = ["sm", "md", "lg", "xl", "2xl"] as const;
const BP_INDEX: Record<string, number> = {};
BREAKPOINT_ORDER.forEach((bp, i) => {
  BP_INDEX[bp] = i + 1;
});

// ── Tailwind v3 → v4 class renames ──────────────────────────────
const CLASS_RENAMES: Record<string, string> = {
  "flex-grow-0": "grow-0",
  "flex-grow": "grow",
  "flex-shrink-0": "shrink-0",
  "flex-shrink": "shrink",
  "overflow-ellipsis": "text-ellipsis",
  "decoration-clone": "box-decoration-clone",
  "decoration-slice": "box-decoration-slice",
  "transform": "",
  "transform-gpu": "",
  "filter": "",
  "backdrop-filter": "",
  "ring": "ring-3",
};

// ── DaisyUI v4 → v5 class renames ──────────────────────────────
const DAISYUI_RENAMES: Record<string, string> = {
  "badge-ghost": "badge-soft",
  "card-compact": "card-sm",
};

// ── Spacing scale ───────────────────────────────────────────────
const PX_TO_SPACING: Record<number, string> = {};
for (let i = 0; i <= 96; i++) {
  PX_TO_SPACING[i * 4] = String(i);
}
PX_TO_SPACING[2] = "0.5";
PX_TO_SPACING[6] = "1.5";
PX_TO_SPACING[10] = "2.5";
PX_TO_SPACING[14] = "3.5";

const TEXT_SIZE_MAP: Record<string, string> = {
  "12": "xs", "14": "sm", "16": "base", "18": "lg", "20": "xl",
  "24": "2xl", "30": "3xl", "36": "4xl", "48": "5xl", "60": "6xl",
  "72": "7xl", "96": "8xl", "128": "9xl",
};

const SPACING_PROPS = new Set([
  "p", "px", "py", "pt", "pb", "pl", "pr",
  "m", "mx", "my", "mt", "mb", "ml", "mr",
  "gap", "gap-x", "gap-y", "space-x", "space-y",
  "w", "h", "min-w", "min-h", "max-w", "max-h",
  "top", "right", "bottom", "left", "inset", "inset-x", "inset-y",
  "rounded", "rounded-t", "rounded-b", "rounded-l", "rounded-r",
  "rounded-tl", "rounded-tr", "rounded-bl", "rounded-br",
  "border", "border-t", "border-b", "border-l", "border-r",
  "text",
]);

// ── CSS category ────────────────────────────────────────────────
const TEXT_SIZE_VALUES = new Set([
  "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl",
  "7xl", "8xl", "9xl",
]);
const TEXT_ALIGN_VALUES = new Set([
  "left", "center", "right", "justify", "start", "end",
]);

function getCssCategory(prop: string, value: string): string {
  if (prop === "text" || prop === "-text") {
    if (TEXT_SIZE_VALUES.has(value) || /^\[\d/.test(value)) return "text-size";
    if (TEXT_ALIGN_VALUES.has(value)) return "text-align";
    return "text-color";
  }
  if (prop === "flex") {
    if (value === "") return "display";
    if (["1", "auto", "initial", "none"].includes(value)) return "flex-grow";
    if (["row", "col", "row-reverse", "col-reverse"].includes(value)) return "flex-direction";
    if (["wrap", "nowrap", "wrap-reverse"].includes(value)) return "flex-wrap";
    return "flex";
  }
  if (prop === "font") {
    if (["bold", "semibold", "medium", "normal", "light", "thin", "extrabold", "black", "extralight"].includes(value)) return "font-weight";
    return "font-family";
  }
  return prop;
}

// ── Types ────────────────────────────────────────────────────────
interface Issue {
  file: string;
  line: number;
  type: "order" | "arbitrary" | "rename";
  message: string;
  original: string;
  suggestion?: string;
}

interface ParsedClass {
  raw: string;
  modifiers: string[];
  bpIndex: number;
  property: string;
  value: string;
  cssCategory: string;
}

function parseClass(cls: string): ParsedClass {
  const parts = cls.split(":");
  const utility = parts.pop()!;
  const modifiers = parts;
  let bpIndex = 0;
  for (const mod of modifiers) {
    if (BP_INDEX[mod] !== undefined && BP_INDEX[mod] > bpIndex) {
      bpIndex = BP_INDEX[mod];
    }
  }
  const negMatch = utility.match(/^(-?)(.+)-(.+)$/);
  let property = utility;
  let value = "";
  if (negMatch) {
    property = negMatch[1] + negMatch[2];
    value = negMatch[3];
  }
  return { raw: cls, modifiers, bpIndex, property, value, cssCategory: getCssCategory(property, value) };
}

function extractClassStrings(source: string): { classes: string; line: number }[] {
  const results: { classes: string; line: number }[] = [];
  const patterns = [
    /className\s*=\s*"([^"]+)"/g,
    /className\s*=\s*{`([^`]+)`}/g,
    /className\s*=\s*{\s*"([^"]+)"\s*}/g,
    /class\s*=\s*"([^"]+)"/g,
  ];
  const lines = source.split("\n");
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const offset = match.index;
      let line = 1;
      let counted = 0;
      for (let i = 0; i < lines.length; i++) {
        counted += lines[i].length + 1;
        if (counted > offset) { line = i + 1; break; }
      }
      results.push({ classes: match[1], line });
    }
  }
  return results;
}

function checkResponsiveOrder(classes: string): Issue[] {
  const issues: Issue[] = [];
  const classList = classes.split(/\s+/).filter(Boolean);
  const propGroups: Record<string, (ParsedClass & { idx: number })[]> = {};
  for (let i = 0; i < classList.length; i++) {
    const parsed = parseClass(classList[i]);
    const key = parsed.cssCategory;
    if (!propGroups[key]) propGroups[key] = [];
    propGroups[key].push({ ...parsed, idx: i });
  }
  for (const group of Object.values(propGroups)) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a.idx < b.idx && a.bpIndex > b.bpIndex) {
          issues.push({
            file: "", line: 0, type: "order",
            message: `Order: \`${a.raw}\` (bp=${a.bpIndex}) before \`${b.raw}\` (bp=${b.bpIndex}) — ${b.raw} will override in v4`,
            original: classes,
          });
        }
        if (b.idx < a.idx && b.bpIndex > a.bpIndex) {
          issues.push({
            file: "", line: 0, type: "order",
            message: `Order: \`${b.raw}\` (bp=${b.bpIndex}) before \`${a.raw}\` (bp=${a.bpIndex}) — ${a.raw} will override in v4`,
            original: classes,
          });
        }
      }
    }
  }
  return issues;
}

function scanFile(filePath: string): Issue[] {
  const issues: Issue[] = [];
  const source = readFileSync(filePath, "utf-8");
  const classStrings = extractClassStrings(source);
  for (const { classes, line } of classStrings) {
    const classList = classes.split(/\s+/).filter(Boolean);

    const orderIssues = checkResponsiveOrder(classes);
    for (const oi of orderIssues) {
      issues.push({ ...oi, file: filePath, line });
    }

    for (const cls of classList) {
      if (!cls.includes("[")) continue;
      const parsed = parseClass(cls);
      const arbMatch = parsed.value.match(/^\[(-?\d+(?:\.\d+)?)(px|rem|%)?\]$/);
      if (!arbMatch) continue;
      const num = parseFloat(arbMatch[1]);
      const unit = arbMatch[2] || "px";
      const baseProp = parsed.property.replace(/^-/, "");

      let suggestion: string | null = null;
      if (baseProp === "text" && unit === "px" && TEXT_SIZE_MAP[String(num)]) {
        suggestion = `text-${TEXT_SIZE_MAP[String(num)]}`;
      } else if (SPACING_PROPS.has(baseProp)) {
        const pxVal = unit === "px" ? num : unit === "rem" ? num * 16 : null;
        if (pxVal !== null && PX_TO_SPACING[pxVal] !== undefined) {
          suggestion = `${baseProp}-${PX_TO_SPACING[pxVal]}`;
        }
      }
      if (suggestion) {
        issues.push({
          file: filePath, line, type: "arbitrary",
          message: `${cls} → ${suggestion}`,
          original: cls, suggestion,
        });
      }
    }

    for (const cls of classList) {
      const parts = cls.split(":");
      const utility = parts[parts.length - 1];
      if (CLASS_RENAMES[utility] !== undefined) {
        const renamed = CLASS_RENAMES[utility];
        issues.push({
          file: filePath, line, type: "rename",
          message: renamed === "" ? `Remove deprecated: ${cls}` : `Rename: ${cls} → ${renamed}`,
          original: cls, suggestion: renamed || undefined,
        });
      }
      if (DAISYUI_RENAMES[utility] && DAISYUI_RENAMES[utility] !== utility) {
        issues.push({
          file: filePath, line, type: "rename",
          message: `DaisyUI: ${cls} → ${DAISYUI_RENAMES[utility]}`,
          original: cls, suggestion: DAISYUI_RENAMES[utility],
        });
      }
    }
  }
  return issues;
}

// ── Fix functions ───────────────────────────────────────────────
function fixClassOrder(classes: string): string {
  const classList = classes.split(/\s+/).filter(Boolean);
  const parsed = classList.map((cls, i) => ({ ...parseClass(cls), idx: i }));
  const groups: Record<string, typeof parsed> = {};
  for (const p of parsed) {
    if (!groups[p.cssCategory]) groups[p.cssCategory] = [];
    groups[p.cssCategory].push(p);
  }
  const result = [...classList];
  for (const group of Object.values(groups)) {
    if (group.length < 2) continue;
    const positions = group.map((g) => g.idx).sort((a, b) => a - b);
    const sorted = [...group].sort((a, b) => a.bpIndex - b.bpIndex);
    for (let i = 0; i < positions.length; i++) {
      result[positions[i]] = sorted[i].raw;
    }
  }
  return result.join(" ");
}

function fixClassName(classes: string): string {
  let classList = classes.split(/\s+/).filter(Boolean);

  classList = classList.map((cls) => {
    const parts = cls.split(":");
    const utility = parts.pop()!;
    if (CLASS_RENAMES[utility] !== undefined) {
      const renamed = CLASS_RENAMES[utility];
      if (renamed === "") return "";
      parts.push(renamed);
      return parts.join(":");
    }
    if (DAISYUI_RENAMES[utility] && DAISYUI_RENAMES[utility] !== utility) {
      parts.push(DAISYUI_RENAMES[utility]);
      return parts.join(":");
    }
    return cls;
  }).filter(Boolean);

  classList = classList.map((cls) => {
    if (!cls.includes("[")) return cls;
    const parsed = parseClass(cls);
    const arbMatch = parsed.value.match(/^\[(-?\d+(?:\.\d+)?)(px|rem|%)?\]$/);
    if (!arbMatch) {
      if (parsed.value === "[100%]" && (parsed.property === "w" || parsed.property === "h")) {
        const prefix = parsed.modifiers.length ? parsed.modifiers.join(":") + ":" : "";
        return `${prefix}${parsed.property}-full`;
      }
      if (parsed.value === "[auto]" && (parsed.property === "w" || parsed.property === "h")) {
        const prefix = parsed.modifiers.length ? parsed.modifiers.join(":") + ":" : "";
        return `${prefix}${parsed.property}-auto`;
      }
      return cls;
    }
    const num = parseFloat(arbMatch[1]);
    const unit = arbMatch[2] || "px";
    const baseProp = parsed.property.replace(/^-/, "");
    const isNeg = parsed.property.startsWith("-");
    const prefix = parsed.modifiers.length ? parsed.modifiers.join(":") + ":" : "";
    const negPrefix = isNeg ? "-" : "";

    if (baseProp === "text" && unit === "px" && TEXT_SIZE_MAP[String(num)]) {
      return `${prefix}text-${TEXT_SIZE_MAP[String(num)]}`;
    }
    if (SPACING_PROPS.has(baseProp)) {
      const pxVal = unit === "px" ? num : unit === "rem" ? num * 16 : null;
      if (pxVal !== null && PX_TO_SPACING[pxVal] !== undefined) {
        return `${prefix}${negPrefix}${baseProp}-${PX_TO_SPACING[pxVal]}`;
      }
    }
    return cls;
  });

  return fixClassOrder(classList.join(" "));
}

function fixFile(filePath: string): { changed: boolean; fixes: number } {
  let source = readFileSync(filePath, "utf-8");
  let fixes = 0;
  const patterns = [
    /(?<=className\s*=\s*")([^"]+)(?=")/g,
    /(?<=className\s*=\s*{`)([^`]+)(?=`})/g,
    /(?<=className\s*=\s*{\s*")([^"]+)(?="\s*})/g,
    /(?<=class\s*=\s*")([^"]+)(?=")/g,
  ];
  for (const pattern of patterns) {
    source = source.replace(pattern, (match) => {
      if (match.includes("\n")) {
        const lines = match.split("\n");
        const fixedLines = lines.map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          const indent = line.match(/^(\s*)/)?.[1] ?? "";
          const fixed = fixClassName(trimmed);
          if (fixed !== trimmed) fixes++;
          return indent + fixed;
        });
        return fixedLines.join("\n");
      }
      const fixed = fixClassName(match);
      if (fixed !== match) fixes++;
      return fixed;
    });
  }
  if (fixes > 0) writeFileSync(filePath, source, "utf-8");
  return { changed: fixes > 0, fixes };
}

function walkDir(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walkDir(full));
    else if (/\.(tsx|jsx|ts|js)$/.test(full)) files.push(full);
  }
  return files;
}

// ── Main ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const doFix = args.includes("--fix");
const scanPaths = args.filter((a) => !a.startsWith("--"));
const root = process.cwd();

const dirs = scanPaths.length > 0
  ? scanPaths.map((p) => join(root, p))
  : [join(root, "src"), join(root, "sections"), join(root, "islands"), join(root, "components")];

const allFiles: string[] = [];
for (const dir of dirs) {
  try {
    const stat = statSync(dir);
    if (stat.isDirectory()) allFiles.push(...walkDir(dir));
    else allFiles.push(dir);
  } catch {
    // dir doesn't exist, skip
  }
}

if (allFiles.length === 0) {
  console.log("No files found to scan.");
  process.exit(0);
}

if (doFix) {
  let totalFixes = 0;
  let totalFiles = 0;
  for (const file of allFiles) {
    const { changed, fixes } = fixFile(file);
    if (changed) {
      totalFiles++;
      totalFixes += fixes;
      console.log(`  ✅ ${relative(root, file)} (${fixes} fixes)`);
    }
  }
  if (totalFixes === 0) {
    console.log("\n✅ Nothing to fix!");
  } else {
    console.log(`\n🔧 Fixed ${totalFixes} classNames across ${totalFiles} files`);
    console.log("   Run without --fix to verify.\n");
  }
  process.exit(0);
}

let allIssues: Issue[] = [];
for (const file of allFiles) {
  allIssues.push(...scanFile(file));
}

if (allIssues.length === 0) {
  console.log("✅ No Tailwind issues found!");
  process.exit(0);
}

const orderIssues = allIssues.filter((i) => i.type === "order");
const arbIssues = allIssues.filter((i) => i.type === "arbitrary");
const renameIssues = allIssues.filter((i) => i.type === "rename");

console.log(`\n🔍 Found ${allIssues.length} issues (${orderIssues.length} order, ${arbIssues.length} arbitrary, ${renameIssues.length} rename)\n`);

if (orderIssues.length > 0) {
  console.log("━".repeat(80));
  console.log("📐 RESPONSIVE ORDER ISSUES (will cause wrong CSS in Tailwind v4)");
  console.log("━".repeat(80));
  console.log("   In v4, base classes MUST come before responsive modifiers:");
  console.log("   ✅ px-4 md:px-6 xl:px-0");
  console.log("   ❌ md:px-6 px-4  (px-4 will override md:px-6)\n");
  const seen = new Set<string>();
  for (const issue of orderIssues) {
    const key = `${issue.file}:${issue.line}:${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${relative(root, issue.file)}:${issue.line}`);
    console.log(`    ❌ ${issue.message}\n`);
  }
}

if (renameIssues.length > 0) {
  console.log("━".repeat(80));
  console.log("🔄 RENAMED/DEPRECATED CLASSES (v3→v4 + DaisyUI v4→v5)");
  console.log("━".repeat(80) + "\n");
  const seen = new Set<string>();
  for (const issue of renameIssues) {
    const key = `${issue.file}:${issue.line}:${issue.original}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${relative(root, issue.file)}:${issue.line}`);
    console.log(`    🔄 ${issue.message}\n`);
  }
}

if (arbIssues.length > 0) {
  console.log("━".repeat(80));
  console.log("💡 ARBITRARY VALUES WITH NATIVE EQUIVALENTS");
  console.log("━".repeat(80) + "\n");
  const seen = new Set<string>();
  for (const issue of arbIssues) {
    const key = `${issue.file}:${issue.line}:${issue.original}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${relative(root, issue.file)}:${issue.line}`);
    console.log(`    💡 ${issue.message}\n`);
  }
}

console.log("━".repeat(80));
console.log("📊 SUMMARY");
console.log("━".repeat(80));
const fileStats: Record<string, { order: number; arbitrary: number; rename: number }> = {};
for (const issue of allIssues) {
  const rel = relative(root, issue.file);
  if (!fileStats[rel]) fileStats[rel] = { order: 0, arbitrary: 0, rename: 0 };
  fileStats[rel][issue.type]++;
}
console.log(`\n  ${"File".padEnd(50)} ${"Order".padStart(6)} ${"Arb.".padStart(6)} ${"Rename".padStart(7)}`);
console.log(`  ${"─".repeat(50)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(7)}`);
for (const [file, stats] of Object.entries(fileStats).sort()) {
  const o = stats.order > 0 ? `${stats.order}` : "-";
  const a = stats.arbitrary > 0 ? `${stats.arbitrary}` : "-";
  const r = stats.rename > 0 ? `${stats.rename}` : "-";
  console.log(`  ${file.padEnd(50)} ${o.padStart(6)} ${a.padStart(6)} ${r.padStart(7)}`);
}
console.log(`\n  Total: ${orderIssues.length} order, ${arbIssues.length} arbitrary, ${renameIssues.length} rename`);
console.log(`  Run with --fix to auto-fix all issues.\n`);

process.exit(1);
