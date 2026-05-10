#!/usr/bin/env tsx
/**
 * Reads .deco/blocks/*.json and emits:
 *   1. blocks.gen.json  — compact JSON data (the source of truth)
 *   2. blocks.gen.ts    — thin TypeScript re-export for editor tooling
 *
 * At runtime the Vite plugin (src/tanstack/vite/plugin.js) intercepts `blocks.gen.ts`
 * imports and replaces them with `JSON.parse(...)` of the .json file. This
 * avoids Vite's SSR module runner hanging on large (13MB+) JS object literals
 * and lets V8 use its fast JSON parser instead of the full JS parser.
 *
 * Usage (from site root):
 *   npx tsx node_modules/@decocms/start/scripts/generate-blocks.ts
 *
 * Env / CLI:
 *   --blocks-dir  override input  (default: .deco/blocks)
 *   --out-file    override output (default: src/server/cms/blocks.gen.ts)
 */
import fs from "node:fs";
import path from "node:path";
import {
  blockHasPath,
  type Candidate,
  decodeBlockNameWithPasses,
  mergeCandidates,
} from "./lib/blocks-dedupe";

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const blocksDir = path.resolve(process.cwd(), arg("blocks-dir", ".deco/blocks"));
const outFile = path.resolve(process.cwd(), arg("out-file", "src/server/cms/blocks.gen.ts"));
const jsonFile = outFile.replace(/\.ts$/, ".json");

const TS_STUB = [
  "// Auto-generated — thin wrapper around blocks.gen.json.",
  "// The Vite plugin replaces this at load time with JSON.parse(...).",
  "// Do not edit manually.",
  "",
  "export const blocks: Record<string, any> = {};",
  "",
].join("\n");

if (!fs.existsSync(blocksDir)) {
  console.warn(`Blocks directory not found: ${blocksDir} — generating empty barrel.`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(jsonFile, "{}");
  fs.writeFileSync(outFile, TS_STUB);
  process.exit(0);
}

const files = fs.readdirSync(blocksDir).filter((f) => f.endsWith(".json"));

// Read each file into a Candidate, then let the dedupe lib pick the winner
// per decoded key and report any collisions. See `lib/blocks-dedupe.ts` for
// the priority order and the rationale behind it (TL;DR: never use file size,
// don't trust mtime alone in CI clones).
const candidatesWithKeys: Array<{ candidate: Candidate; key: string }> = [];
for (const file of files) {
  const { name, passes } = decodeBlockNameWithPasses(file);
  const fp = path.join(blocksDir, file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch (e) {
    console.warn(`Failed to parse ${file}:`, e);
    continue;
  }
  candidatesWithKeys.push({
    key: name,
    candidate: {
      file,
      passes,
      mtimeMs: fs.statSync(fp).mtimeMs,
      hasPath: blockHasPath(parsed),
      parsed,
    },
  });
}

const { winners, collisions } = mergeCandidates(candidatesWithKeys);

if (collisions.length > 0) {
  console.warn(
    `Detected ${collisions.length} filename collision(s) in ${path.relative(process.cwd(), blocksDir)}:`,
  );
  for (const c of collisions) {
    const losers = c.files.filter((f) => f !== c.winner);
    console.warn(`  - ${c.key}`);
    console.warn(`      winner: ${c.winner}`);
    for (const l of losers) console.warn(`      ignore: ${l}`);
  }
  console.warn("    Cause: multiple writers (manual sync vs deco-sync-bot) producing");
  console.warn("    different filename encodings for the same logical key. Delete the");
  console.warn("    stale file(s) listed under 'ignore' to silence this warning.");
}

const blocks: Record<string, unknown> = {};
for (const [name, c] of Object.entries(winners)) {
  blocks[name] = c.parsed;
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });

// 1. Compact JSON — the real data (no pretty-printing to save ~40% size)
const jsonStr = JSON.stringify(blocks);
fs.writeFileSync(jsonFile, jsonStr);

// 2. Thin TS wrapper — just for TypeScript tooling and as a Vite load target
fs.writeFileSync(outFile, TS_STUB);

const jsonSizeMB = (Buffer.byteLength(jsonStr) / 1_048_576).toFixed(1);
console.log(
  `Generated ${Object.keys(blocks).length} blocks → ${path.relative(process.cwd(), jsonFile)} (${jsonSizeMB} MB)`,
);
