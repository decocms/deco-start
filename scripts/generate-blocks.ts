import fs from "node:fs";
import path from "node:path";

const blocksDir = path.resolve(process.cwd(), ".deco/blocks");
const outFile = path.resolve(process.cwd(), "src/server/cms/blocks.gen.ts");

function decodeBlockName(filename: string): string {
  return decodeURIComponent(decodeURIComponent(filename)).replace(
    /\.json$/,
    ""
  );
}

const blocks: Record<string, unknown> = {};
const files = fs.readdirSync(blocksDir).filter((f) => f.endsWith(".json"));

for (const file of files) {
  const name = decodeBlockName(file);
  try {
    const content = fs.readFileSync(path.join(blocksDir, file), "utf-8");
    blocks[name] = JSON.parse(content);
  } catch (e) {
    console.warn(`Failed to parse ${file}:`, e);
  }
}

const output = `// Auto-generated from .deco/blocks/*.json
// Do not edit manually. Run: npm run generate:blocks

export const blocks: Record<string, any> = ${JSON.stringify(blocks, null, 2)};
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, output);
console.log(
  `Generated ${Object.keys(blocks).length} blocks → ${path.relative(process.cwd(), outFile)}`
);
