import * as fs from "node:fs";
import * as path from "node:path";
import type { MigrationContext, TransformResult } from "./types.ts";
import { log, logPhase } from "./types.ts";
import { transformImports } from "./transforms/imports.ts";
import { transformJsx } from "./transforms/jsx.ts";
import { transformFreshApis } from "./transforms/fresh-apis.ts";
import { transformDenoIsms } from "./transforms/deno-isms.ts";
import { transformTailwind } from "./transforms/tailwind.ts";
import { transformDeadCode } from "./transforms/dead-code.ts";

/**
 * Apply all transforms to a file's content in the correct order.
 */
function applyTransforms(content: string, filePath: string): TransformResult {
  const allNotes: string[] = [];
  let currentContent = content;
  let anyChanged = false;

  // Only transform code files
  const ext = path.extname(filePath);
  if (![".ts", ".tsx"].includes(ext)) {
    return { content, changed: false, notes: [] };
  }

  // Pipeline: imports → jsx → fresh-apis → dead-code → deno-isms → tailwind
  const pipeline = [
    { name: "imports", fn: transformImports },
    { name: "jsx", fn: transformJsx },
    { name: "fresh-apis", fn: transformFreshApis },
    { name: "dead-code", fn: transformDeadCode },
    { name: "deno-isms", fn: transformDenoIsms },
    { name: "tailwind", fn: transformTailwind },
  ];

  for (const step of pipeline) {
    const result = step.fn(currentContent);
    if (result.changed) {
      anyChanged = true;
      currentContent = result.content;
      allNotes.push(...result.notes.map((n) => `[${step.name}] ${n}`));
    }
  }

  return { content: currentContent, changed: anyChanged, notes: allNotes };
}

export function transform(ctx: MigrationContext): void {
  logPhase("Transform");

  const toTransform = ctx.files.filter((f) => f.action === "transform");
  console.log(`  Files to transform: ${toTransform.length}`);

  for (const record of toTransform) {
    const { absPath, targetPath } = record;
    if (!targetPath) continue;

    // Read source
    const content = fs.readFileSync(absPath, "utf-8");

    // Apply transforms
    const result = applyTransforms(content, absPath);

    // Add manual review items
    for (const note of result.notes) {
      if (note.startsWith("[") && note.includes("MANUAL:")) {
        ctx.manualReviewItems.push({
          file: targetPath,
          reason: note,
          severity: "warning",
        });
      }
    }

    // Flag files with HTMX patterns for manual React migration
    if (/\bhx-(?:get|post|put|delete|trigger|target|swap|on|indicator|sync|select)\b/.test(result.content)) {
      ctx.manualReviewItems.push({
        file: targetPath,
        reason: "HTMX attributes (hx-*) found — needs manual migration to React state/effects. HTMX server-side rendering (hx-get/hx-post with useSection) must be converted to React components with useState/useEffect or server functions.",
        severity: "warning",
      });
    }

    // Flag files with hx-on:click that use useScript (simpler pattern)
    if (/hx-on:click=\{useScript/.test(result.content)) {
      ctx.manualReviewItems.push({
        file: targetPath,
        reason: "hx-on:click with useScript found — convert to onClick with React event handler. The useScript serialization won't work as onClick value.",
        severity: "warning",
      });
    }

    if (ctx.dryRun) {
      if (result.changed) {
        log(ctx, `[DRY] Would transform: ${record.path} → ${targetPath}`);
        for (const note of result.notes) {
          log(ctx, `       ${note}`);
        }
      }
      ctx.transformedFiles.push(targetPath);
      continue;
    }

    // Write to target path
    const fullTargetPath = path.join(ctx.sourceDir, targetPath);
    const dir = path.dirname(fullTargetPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullTargetPath, result.content, "utf-8");

    ctx.transformedFiles.push(targetPath);
    if (result.changed) {
      log(
        ctx,
        `Transformed: ${record.path} → ${targetPath} (${result.notes.length} changes)`,
      );
    } else {
      log(ctx, `Copied: ${record.path} → ${targetPath}`);
    }
  }

  console.log(`  Transformed ${ctx.transformedFiles.length} files`);

  // Post-transform: resolve ~/islands/ imports to actual file locations.
  // Islands are moved to src/sections/ during migration, but components
  // import them via ~/islands/X which no longer exists. Scan src/ for
  // the actual file and rewrite the import.
  if (!ctx.dryRun) {
    fixIslandImports(ctx);
  }
}

/**
 * Scan all transformed files for ~/islands/ imports and rewrite them
 * to the actual path where the file was placed (sections/, components/, etc.).
 */
function fixIslandImports(ctx: MigrationContext): void {
  const srcDir = path.join(ctx.sourceDir, "src");
  if (!fs.existsSync(srcDir)) return;

  // Build a lookup: filename → relative path from src/
  const fileLookup = new Map<string, string[]>();
  function scanDir(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        scanDir(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
        const relPath = path.relative(srcDir, path.join(dir, entry.name));
        const base = entry.name.replace(/\.tsx?$/, "");
        if (!fileLookup.has(base)) fileLookup.set(base, []);
        fileLookup.get(base)!.push(relPath);
      }
    }
  }
  scanDir(srcDir);

  // Scan all .ts/.tsx files in src/ for ~/islands/ imports
  const islandImportRe = /from\s+["'](~\/islands\/([^"']+))["']/g;
  let fixCount = 0;

  function walkAndFix(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walkAndFix(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
        const filePath = path.join(dir, entry.name);
        let content = fs.readFileSync(filePath, "utf-8");
        let modified = false;

        content = content.replace(islandImportRe, (match, fullImport, islandPath) => {
          // islandPath = "Cart/Indicator" or "SliderJS" or "Searchbar"
          const basename = islandPath.replace(/\.tsx?$/, "").split("/").pop()!;

          // Try to find the file — prefer components/ over sections/
          const candidates = fileLookup.get(basename) || [];
          // Exclude islands/ paths themselves and routes/
          const valid = candidates.filter(
            (c) => !c.startsWith("islands/") && !c.startsWith("routes/"),
          );

          if (valid.length === 0) return match; // can't resolve, leave as-is

          // Prefer components/ over sections/
          const preferred =
            valid.find((c) => c.startsWith("components/")) ??
            valid.find((c) => c.startsWith("sections/")) ??
            valid[0];

          const newPath = "~/" + preferred.replace(/\.tsx?$/, "");
          modified = true;
          return match.replace(fullImport, newPath);
        });

        if (modified) {
          fs.writeFileSync(filePath, content, "utf-8");
          fixCount++;
        }
      }
    }
  }

  walkAndFix(srcDir);
  if (fixCount > 0) {
    console.log(`  Fixed ~/islands/ imports in ${fixCount} files`);
  }
}
