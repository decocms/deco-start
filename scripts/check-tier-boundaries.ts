#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { join } from "node:path";

interface Violation {
  file: string;
  imported: string;
  reason: string;
}

interface Options {
  distDir: string;
}

const FORBIDDEN_IN_CORE = [
  /@tanstack\/react-start/,
  /@tanstack\/react-router/,
  /^next$/,
  /^next\//,
  /node:async_hooks/,
];

const FORBIDDEN_IN_NEXT = [/@tanstack\/react-start/, /@tanstack\/react-router/];

const IMPORT_RE = /(?:from|import\()\s*["']([^"']+)["']/g;

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) yield path;
  }
}

function tierOf(path: string): "core" | "tanstack" | "next" | "other" {
  if (path.includes("/core/") || path.includes("\\core\\")) return "core";
  if (path.includes("/tanstack/") || path.includes("\\tanstack\\")) return "tanstack";
  if (path.includes("/next/") || path.includes("\\next\\")) return "next";
  return "other";
}

export async function checkTierBoundaries(
  opts: Options,
): Promise<{ violations: Violation[] }> {
  const violations: Violation[] = [];
  for await (const path of walk(opts.distDir)) {
    const content = await fs.readFile(path, "utf8");
    const tier = tierOf(path);
    const imports: string[] = [];
    for (const m of content.matchAll(IMPORT_RE)) imports.push(m[1]);

    for (const imp of imports) {
      if (tier === "core") {
        for (const re of FORBIDDEN_IN_CORE) {
          if (re.test(imp)) {
            violations.push({ file: path, imported: imp, reason: `core forbids ${imp}` });
          }
        }
      } else if (tier === "next") {
        for (const re of FORBIDDEN_IN_NEXT) {
          if (re.test(imp)) {
            violations.push({ file: path, imported: imp, reason: `next forbids ${imp}` });
          }
        }
        if (imp.startsWith("../tanstack/") || imp.includes("/tanstack/")) {
          violations.push({
            file: path,
            imported: imp,
            reason: `next must not import from tanstack`,
          });
        }
      } else if (tier === "tanstack") {
        if (imp.startsWith("../next/") || imp.includes("/next/")) {
          violations.push({
            file: path,
            imported: imp,
            reason: `tanstack must not import from next`,
          });
        }
      }
    }
  }
  return { violations };
}

// CLI entrypoint
const isMain = (() => {
  try {
    const argv = process.argv?.[1];
    return Boolean(argv && import.meta.url === `file://${argv}`);
  } catch {
    return false;
  }
})();

if (isMain) {
  const result = await checkTierBoundaries({ distDir: "dist" });
  if (result.violations.length === 0) {
    console.log("✓ tier boundaries clean");
    process.exit(0);
  }
  console.error("✗ tier boundary violations:");
  for (const v of result.violations) console.error(`  ${v.file}: ${v.imported} (${v.reason})`);
  process.exit(1);
}
