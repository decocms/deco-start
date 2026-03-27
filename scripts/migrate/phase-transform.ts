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
}
