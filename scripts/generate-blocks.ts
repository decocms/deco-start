#!/usr/bin/env tsx
/**
 * Reads .deco/blocks/*.json and emits:
 *   1. blocks.gen.json  — compact JSON data (the source of truth)
 *   2. blocks.gen.ts    — thin TypeScript re-export for editor tooling
 *
 * At runtime the Vite plugin (src/vite/plugin.js) intercepts `blocks.gen.ts`
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

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const blocksDir = path.resolve(process.cwd(), arg("blocks-dir", ".deco/blocks"));
const outFile = path.resolve(process.cwd(), arg("out-file", "src/server/cms/blocks.gen.ts"));
const jsonFile = outFile.replace(/\.ts$/, ".json");

function decodeBlockName(filename: string): string {
  let name = filename.replace(/\.json$/, "");
  while (name.includes("%")) {
    try {
      const next = decodeURIComponent(name);
      if (next === name) break;
      name = next;
    } catch {
      break; // literal % in the decoded name — nothing left to decode
    }
  }
  return name;
}

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

// Deduplicate: when multiple files decode to the same key, prefer the one
// with actual content (largest file size wins over empty {} stubs).
const blockFiles: Record<string, string> = {};
for (const file of files) {
  const name = decodeBlockName(file);
  if (blockFiles[name]) {
    const existingSize = fs.statSync(path.join(blocksDir, blockFiles[name])).size;
    const newSize = fs.statSync(path.join(blocksDir, file)).size;
    if (newSize > existingSize) {
      blockFiles[name] = file;
    }
    continue;
  }
  blockFiles[name] = file;
}

const blocks: Record<string, unknown> = {};
for (const [name, file] of Object.entries(blockFiles)) {
  try {
    const content = fs.readFileSync(path.join(blocksDir, file), "utf-8");
    blocks[name] = JSON.parse(content);
  } catch (e) {
    console.warn(`Failed to parse ${file}:`, e);
  }
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
