#!/usr/bin/env tsx
/**
 * Reads .deco/blocks/*.json and emits a TypeScript barrel.
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

if (!fs.existsSync(blocksDir)) {
  console.warn(`Blocks directory not found: ${blocksDir} — generating empty barrel.`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(
    outFile,
    `// Auto-generated — no blocks found\nexport const blocks: Record<string, any> = {};\n`,
  );
  process.exit(0);
}

const files = fs.readdirSync(blocksDir).filter((f) => f.endsWith(".json"));

// Deduplicate: prefer the non-URL-encoded filename when both exist
const blockFiles: Record<string, string> = {};
for (const file of files) {
  const name = decodeBlockName(file);
  const isEncoded = file !== `${name}.json`;
  if (blockFiles[name] && !isEncoded) {
    // Plain filename wins over URL-encoded variant
  } else if (blockFiles[name] && isEncoded) {
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

const output = `// Auto-generated from .deco/blocks/*.json\n// Do not edit manually.\n\nexport const blocks: Record<string, any> = ${JSON.stringify(blocks, null, 2)};\n`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, output);
console.log(
  `Generated ${Object.keys(blocks).length} blocks → ${path.relative(process.cwd(), outFile)}`,
);
