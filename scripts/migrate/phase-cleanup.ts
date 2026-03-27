import * as fs from "node:fs";
import * as path from "node:path";
import type { MigrationContext } from "./types.ts";
import { log, logPhase } from "./types.ts";

/** Directories to remove entirely after migration */
const DIRS_TO_DELETE = [
  "islands",
  "routes",
  "apps/deco",
  "sdk/cart",
];

/** Individual root files to delete */
const ROOT_FILES_TO_DELETE = [
  "main.ts",
  "dev.ts",
  "deno.json",
  "deno.lock",
  "tailwind.css",
  "tailwind.config.ts",
  "runtime.ts",
  "constants.ts",
  "fresh.gen.ts",
  "manifest.gen.ts",
  "fresh.config.ts",
  "browserslist",
  "bw_stats.json",
];

/** SDK files that have framework equivalents */
const SDK_FILES_TO_DELETE = [
  "sdk/clx.ts",
  "sdk/useId.ts",
  "sdk/useOffer.ts",
  "sdk/useVariantPossiblities.ts",
  "sdk/usePlatform.tsx",
];

/** Section/component wrappers that are no longer needed */
const WRAPPER_FILES_TO_DELETE = [
  "components/Session.tsx",
  "sections/Session.tsx",
];

function deleteFileIfExists(ctx: MigrationContext, relPath: string) {
  const fullPath = path.join(ctx.sourceDir, relPath);
  if (!fs.existsSync(fullPath)) return;

  if (ctx.dryRun) {
    log(ctx, `[DRY] Would delete: ${relPath}`);
    ctx.deletedFiles.push(relPath);
    return;
  }

  fs.unlinkSync(fullPath);
  ctx.deletedFiles.push(relPath);
  log(ctx, `Deleted: ${relPath}`);
}

function deleteDirIfExists(ctx: MigrationContext, relPath: string) {
  const fullPath = path.join(ctx.sourceDir, relPath);
  if (!fs.existsSync(fullPath)) return;

  if (ctx.dryRun) {
    log(ctx, `[DRY] Would delete dir: ${relPath}/`);
    ctx.deletedFiles.push(`${relPath}/`);
    return;
  }

  fs.rmSync(fullPath, { recursive: true, force: true });
  ctx.deletedFiles.push(`${relPath}/`);
  log(ctx, `Deleted dir: ${relPath}/`);
}

function moveStaticFiles(ctx: MigrationContext) {
  const staticDir = path.join(ctx.sourceDir, "static");
  if (!fs.existsSync(staticDir)) return;

  const publicDir = path.join(ctx.sourceDir, "public");

  function moveRecursive(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(dir, entry.name);
      const relFromStatic = path.relative(staticDir, srcPath);
      const destPath = path.join(publicDir, relFromStatic);

      // Skip generated files
      if (
        entry.name === "tailwind.css" || entry.name === "adminIcons.ts" ||
        entry.name === "generate-icons.ts"
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        moveRecursive(srcPath);
        continue;
      }

      if (ctx.dryRun) {
        log(ctx, `[DRY] Would move: static/${relFromStatic} → public/${relFromStatic}`);
        ctx.movedFiles.push({
          from: `static/${relFromStatic}`,
          to: `public/${relFromStatic}`,
        });
        continue;
      }

      // Ensure dest dir exists
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      ctx.movedFiles.push({
        from: `static/${relFromStatic}`,
        to: `public/${relFromStatic}`,
      });
      log(ctx, `Moved: static/${relFromStatic} → public/${relFromStatic}`);
    }
  }

  moveRecursive(staticDir);

  // Now delete static/ dir
  if (!ctx.dryRun) {
    fs.rmSync(staticDir, { recursive: true, force: true });
    log(ctx, "Deleted dir: static/");
  }
}

function cleanupOldSourceDirs(ctx: MigrationContext) {
  // After transforms, the original top-level dirs have been copied to src/.
  // Delete the old top-level copies if they still exist and src/ has them.
  const dirsToClean = [
    "sections",
    "components",
    "sdk",
    "loaders",
    "actions",
    "apps",
  ];

  for (const dir of dirsToClean) {
    const oldDir = path.join(ctx.sourceDir, dir);
    const newDir = path.join(ctx.sourceDir, "src", dir);
    if (fs.existsSync(oldDir) && fs.existsSync(newDir)) {
      if (ctx.dryRun) {
        log(ctx, `[DRY] Would delete old dir: ${dir}/ (moved to src/${dir}/)`);
        ctx.deletedFiles.push(`${dir}/`);
      } else {
        fs.rmSync(oldDir, { recursive: true, force: true });
        ctx.deletedFiles.push(`${dir}/`);
        log(ctx, `Deleted old dir: ${dir}/ (now at src/${dir}/)`);
      }
    }
  }
}

/** Delete sections that were re-export wrappers (their islands are now sections) */
function cleanupReExportSections(ctx: MigrationContext) {
  const reExports = ctx.files.filter(
    (f) => f.category === "section" && f.isReExport && f.action === "delete",
  );
  for (const f of reExports) {
    // These were already not transformed, just make sure we note them
    log(ctx, `Skipped re-export wrapper: ${f.path}`);
  }
}

export function cleanup(ctx: MigrationContext): void {
  logPhase("Cleanup");

  // 1. Move static → public
  console.log("  Moving static/ → public/...");
  moveStaticFiles(ctx);

  // 2. Delete specific files
  console.log("  Deleting old files...");
  for (const file of ROOT_FILES_TO_DELETE) {
    deleteFileIfExists(ctx, file);
  }
  for (const file of SDK_FILES_TO_DELETE) {
    deleteFileIfExists(ctx, file);
  }
  for (const file of WRAPPER_FILES_TO_DELETE) {
    deleteFileIfExists(ctx, file);
  }

  // 3. Delete directories
  console.log("  Deleting old directories...");
  for (const dir of DIRS_TO_DELETE) {
    deleteDirIfExists(ctx, dir);
  }

  // 4. Clean up old source directories
  console.log("  Cleaning up old source dirs...");
  cleanupOldSourceDirs(ctx);
  cleanupReExportSections(ctx);

  console.log(
    `  Deleted ${ctx.deletedFiles.length} files/dirs, moved ${ctx.movedFiles.length} files`,
  );
}
