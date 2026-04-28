#!/usr/bin/env tsx
/**
 * Scans site loader and action files and generates a registry map
 * for COMMERCE_LOADERS pass-through entries.
 *
 * Each loader/action file that exports a default function gets a generated
 * entry like:
 *   "site/loaders/SAP/getUser": async (props, request) => {
 *     const mod = await import("../../loaders/SAP/getUser");
 *     return mod.default(props, request);
 *   },
 *
 * Both keyed with and without `.ts` suffix for CMS block compatibility.
 *
 * Files listed in --exclude are skipped (they need custom wiring in setup.ts).
 *
 * CMS-aware filtering (`--decofile-dir`): when supplied, the script walks
 * every JSON file in the directory and collects the set of `__resolveType`
 * references. Only loaders whose key appears in that set are emitted —
 * keeping the registry to what the site actually uses and avoiding the
 * "200 dead passthroughs" pattern.
 *
 * Usage (from site root):
 *   npx tsx node_modules/@decocms/start/scripts/generate-loaders.ts
 *   npx tsx node_modules/@decocms/start/scripts/generate-loaders.ts --decofile-dir .deco/blocks
 *
 * CLI:
 *   --loaders-dir   override loaders input    (default: src/loaders)
 *   --actions-dir   override actions input    (default: src/actions)
 *   --out-file      override output           (default: src/server/cms/loaders.gen.ts)
 *   --exclude       comma-separated list of loader keys to skip (they have custom wiring)
 *   --decofile-dir  if provided, only emit entries whose key appears as `__resolveType` in any JSON
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const loadersDir = path.resolve(process.cwd(), arg("loaders-dir", "src/loaders"));
const actionsDir = path.resolve(process.cwd(), arg("actions-dir", "src/actions"));
const outFile = path.resolve(process.cwd(), arg("out-file", "src/server/cms/loaders.gen.ts"));
const excludeRaw = arg("exclude", "");
const excludeSet = new Set(excludeRaw.split(",").map((s) => s.trim()).filter(Boolean));
const decofileDirRaw = arg("decofile-dir", "");
const decofileDir = decofileDirRaw ? path.resolve(process.cwd(), decofileDirRaw) : null;

function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      results.push(fullPath);
    }
  }
  return results;
}

function fileToKey(filePath: string, baseDir: string, prefix: string): string {
  const rel = path.relative(baseDir, filePath).replace(/\\/g, "/").replace(/\.tsx?$/, "");
  return `${prefix}/${rel}`;
}

function relativeImportPath(from: string, to: string): string {
  let rel = path.relative(path.dirname(from), to).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel.replace(/\.tsx?$/, "");
}

function hasDefaultExport(content: string): boolean {
  return /export\s+default\b/.test(content) || /export\s*\{[^}]*\bdefault\b/.test(content);
}

// ---------------------------------------------------------------------------
// CMS-referenced loader discovery
//
// Walk every JSON file under decofileDir and collect the set of strings that
// appear as `__resolveType` values. The migration script + generators emit
// pass-throughs for every loader/action file on disk; without this filter,
// 90%+ of those entries are dead code (the CMS never references them) and
// they pollute the type system and bundle.
// ---------------------------------------------------------------------------

function collectResolveTypes(dir: string): Set<string> {
  const found = new Set<string>();
  if (!fs.existsSync(dir)) return found;

  const RESOLVE_RE = /"__resolveType"\s*:\s*"([^"]+)"/g;

  function visit(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.name.endsWith(".json")) {
        const content = fs.readFileSync(fullPath, "utf-8");
        let m: RegExpExecArray | null;
        while ((m = RESOLVE_RE.exec(content)) !== null) {
          found.add(m[1]);
        }
      }
    }
  }

  visit(dir);
  return found;
}

const cmsReferences = decofileDir ? collectResolveTypes(decofileDir) : null;

function isReferenced(key: string): boolean {
  if (!cmsReferences) return true;
  return cmsReferences.has(key) || cmsReferences.has(`${key}.ts`);
}

// ---------------------------------------------------------------------------

interface LoaderEntry {
  key: string;
  importPath: string;
}

const entries: LoaderEntry[] = [];
let prunedCount = 0;

for (const filePath of walkDir(loadersDir)) {
  const content = fs.readFileSync(filePath, "utf-8");
  if (!hasDefaultExport(content)) continue;
  const key = fileToKey(filePath, loadersDir, "site/loaders");
  if (excludeSet.has(key) || excludeSet.has(`${key}.ts`)) continue;
  if (!isReferenced(key)) {
    prunedCount++;
    continue;
  }
  entries.push({
    key,
    importPath: relativeImportPath(outFile, filePath),
  });
}

for (const filePath of walkDir(actionsDir)) {
  const content = fs.readFileSync(filePath, "utf-8");
  if (!hasDefaultExport(content)) continue;
  const key = fileToKey(filePath, actionsDir, "site/actions");
  if (excludeSet.has(key) || excludeSet.has(`${key}.ts`)) continue;
  if (!isReferenced(key)) {
    prunedCount++;
    continue;
  }
  entries.push({
    key,
    importPath: relativeImportPath(outFile, filePath),
  });
}

entries.sort((a, b) => a.key.localeCompare(b.key));

const lines: string[] = [
  "// Auto-generated by @decocms/start/scripts/generate-loaders.ts",
  "// Do not edit manually. Run `npm run generate:loaders` to update.",
  "//",
  "// Pass-through loader/action entries for COMMERCE_LOADERS.",
  "// Custom-wired entries should be excluded via --exclude and added manually in setup.ts.",
  "",
  "export const siteLoaders: Record<string, (props: any, request?: Request) => Promise<any>> = {",
];

// Cast the dynamic-import default to `any` so legacy 3-arg
// `(props, req, ctx)` Fresh/Deno loaders still type-check. Any ctx-dependent
// path in the loader body throws at runtime and must be refactored.
for (const entry of entries) {
  lines.push(`  "${entry.key}": async (props: any, request?: Request) => {`);
  lines.push(`    const mod = await import("${entry.importPath}");`);
  lines.push("    return (mod.default as any)(props, request);");
  lines.push("  },");
  lines.push(`  "${entry.key}.ts": async (props: any, request?: Request) => {`);
  lines.push(`    const mod = await import("${entry.importPath}");`);
  lines.push("    return (mod.default as any)(props, request);");
  lines.push("  },");
}

lines.push("};");
lines.push("");

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, lines.join("\n"));

const filterNote = cmsReferences
  ? ` (filtered against ${cmsReferences.size} CMS __resolveType references; pruned ${prunedCount} dead entries)`
  : "";
console.log(
  `Generated ${entries.length} loader entries (${entries.length * 2} with .ts aliases) → ${path.relative(process.cwd(), outFile)}${filterNote}`,
);
