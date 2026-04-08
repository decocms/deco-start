import * as fs from "node:fs";
import * as path from "node:path";
import type { MigrationContext, TransformResult, SectionMeta } from "./types.ts";
import { log, logPhase } from "./types.ts";
import { transformImports } from "./transforms/imports.ts";
import { transformJsx } from "./transforms/jsx.ts";
import { transformFreshApis } from "./transforms/fresh-apis.ts";
import { transformDenoIsms } from "./transforms/deno-isms.ts";
import { transformTailwind } from "./transforms/tailwind.ts";
import { transformDeadCode } from "./transforms/dead-code.ts";
import { transformSectionConventions } from "./transforms/section-conventions.ts";

/** Map of section path → metadata, populated per-run */
let sectionMetaMap: Map<string, SectionMeta> | null = null;

function getSectionMeta(ctx: MigrationContext, relPath: string): SectionMeta | undefined {
  if (!sectionMetaMap) {
    sectionMetaMap = new Map();
    for (const m of ctx.sectionMetas) {
      sectionMetaMap.set(m.path, m);
    }
  }
  return sectionMetaMap.get(relPath);
}

/**
 * Apply all transforms to a file's content in the correct order.
 */
function applyTransforms(content: string, filePath: string, ctx?: MigrationContext, relPath?: string): TransformResult {
  const allNotes: string[] = [];
  let currentContent = content;
  let anyChanged = false;

  // Only transform code files
  const ext = path.extname(filePath);
  if (![".ts", ".tsx"].includes(ext)) {
    return { content, changed: false, notes: [] };
  }

  // Pipeline: imports → jsx → fresh-apis → dead-code → deno-isms → tailwind
  const pipeline: Array<{ name: string; fn: (content: string) => TransformResult }> = [
    { name: "imports", fn: (c) => transformImports(c, ctx?.islandWrapperTargets) },
    { name: "jsx", fn: transformJsx },
    { name: "fresh-apis", fn: transformFreshApis },
    { name: "dead-code", fn: (c) => transformDeadCode(c, ctx?.platform) },
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

  // Section conventions (sync/eager/layout/cache) — only for section files
  if (ctx && relPath && relPath.startsWith("sections/")) {
    const meta = getSectionMeta(ctx, relPath);
    const result = transformSectionConventions(currentContent, meta);
    if (result.changed) {
      anyChanged = true;
      currentContent = result.content;
      allNotes.push(...result.notes.map((n) => `[section-conventions] ${n}`));
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
    const result = applyTransforms(content, absPath, ctx, record.path);

    // Fix section re-exports from wrapper islands — point to the wrapped component
    const resolvedTarget = (record as any).__resolvedReExportTarget;
    if (resolvedTarget && result.content.includes("~/components/")) {
      // The import transform rewrote $store/islands/X → ~/components/X
      // but for wrapper islands, the actual component is at a different path
      const reExportRe = /from\s+"~\/components\/[^"]+"/g;
      result.content = result.content.replace(reExportRe, `from "${resolvedTarget}"`);
      result.notes.push(`Re-export resolved to wrapper target: ${resolvedTarget}`);
      result.changed = true;
    }

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
        const relPath = path.relative(srcDir, path.join(dir, entry.name)).replace(/\\/g, "/");
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
