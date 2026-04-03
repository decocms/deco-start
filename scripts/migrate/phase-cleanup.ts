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

/** Loaders that depend on deleted admin tooling */
const LOADER_FILES_TO_DELETE = [
  "loaders/availableIcons.ts",
  "loaders/icons.ts",
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

/**
 * Handle multi-brand static directories (static-cv/, static-lb/, etc.).
 * The "primary" brand's assets go to public/.
 */
function moveMultiBrandStaticFiles(ctx: MigrationContext) {
  const entries = fs.readdirSync(ctx.sourceDir, { withFileTypes: true });
  const staticDirs = entries.filter(
    (e) => e.isDirectory() && e.name.startsWith("static-"),
  );

  if (staticDirs.length === 0) return;

  // Use the first one as primary (or match by site name)
  const primaryDir = staticDirs[0];
  const primaryPath = path.join(ctx.sourceDir, primaryDir.name);
  const publicDir = path.join(ctx.sourceDir, "public");

  log(ctx, `Found multi-brand static dirs: ${staticDirs.map((d) => d.name).join(", ")}`);
  log(ctx, `Using ${primaryDir.name} as primary → public/`);

  function copyRecursive(dir: string, base: string) {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const srcPath = path.join(dir, item.name);
      const relFromBase = path.relative(base, srcPath);
      const destPath = path.join(publicDir, relFromBase);

      if (item.name === "tailwind.css" || item.name === "adminIcons.ts") continue;
      // Skip partytown (not needed in Workers)
      if (item.name === "~partytown" || item.name === "partytown") continue;

      if (item.isDirectory()) {
        copyRecursive(srcPath, base);
        continue;
      }

      if (ctx.dryRun) {
        log(ctx, `[DRY] Would copy: ${primaryDir.name}/${relFromBase} → public/${relFromBase}`);
        ctx.movedFiles.push({ from: `${primaryDir.name}/${relFromBase}`, to: `public/${relFromBase}` });
        continue;
      }

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      ctx.movedFiles.push({ from: `${primaryDir.name}/${relFromBase}`, to: `public/${relFromBase}` });
    }
  }

  copyRecursive(primaryPath, primaryPath);

  // Clean up all static-* dirs (both root and src/)
  if (!ctx.dryRun) {
    for (const d of staticDirs) {
      const rootDir = path.join(ctx.sourceDir, d.name);
      if (fs.existsSync(rootDir)) {
        fs.rmSync(rootDir, { recursive: true, force: true });
        log(ctx, `Deleted: ${d.name}/`);
      }
      const srcDir = path.join(ctx.sourceDir, "src", d.name);
      if (fs.existsSync(srcDir)) {
        fs.rmSync(srcDir, { recursive: true, force: true });
        log(ctx, `Deleted: src/${d.name}/`);
      }
    }
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

/** Remove non-code files and directories that shouldn't be under src/ */
function cleanupJunkFromSrc(ctx: MigrationContext) {
  const srcDir = path.join(ctx.sourceDir, "src");
  if (!fs.existsSync(srcDir)) return;

  // Remove dirs that don't belong in src/
  const junkDirs = ["bin", "fonts", "tests", ".pilot", ".deco"];
  for (const dir of junkDirs) {
    const dirPath = path.join(srcDir, dir);
    if (fs.existsSync(dirPath)) {
      if (ctx.dryRun) {
        log(ctx, `[DRY] Would delete junk dir: src/${dir}/`);
      } else {
        fs.rmSync(dirPath, { recursive: true, force: true });
        log(ctx, `Deleted junk from src/: ${dir}/`);
      }
    }
  }

  // Remove static-* dirs from src/
  if (fs.existsSync(srcDir)) {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("static-")) {
        const dirPath = path.join(srcDir, entry.name);
        if (ctx.dryRun) {
          log(ctx, `[DRY] Would delete: src/${entry.name}/`);
        } else {
          fs.rmSync(dirPath, { recursive: true, force: true });
          log(ctx, `Deleted from src/: ${entry.name}/`);
        }
      }
    }
  }

  // Remove non-code root files from src/
  const junkFiles = [
    "AGENTS.md", "account.json", "biome.json", "blockedQs.ts", "islands.ts",
    "lint-changed.sh", "redirects-vtex.csv", "search-urls-cvlb.csv",
    "search.csv", "sync.sh", "yarn.lock",
  ];
  for (const file of junkFiles) {
    const filePath = path.join(srcDir, file);
    if (fs.existsSync(filePath)) {
      if (ctx.dryRun) {
        log(ctx, `[DRY] Would delete: src/${file}`);
      } else {
        fs.unlinkSync(filePath);
        log(ctx, `Deleted from src/: ${file}`);
      }
    }
  }
}

export function cleanup(ctx: MigrationContext): void {
  logPhase("Cleanup");

  // 1. Move static → public (handles static/, static-cv/, static-lb/, etc.)
  console.log("  Moving static assets → public/...");
  moveStaticFiles(ctx);
  moveMultiBrandStaticFiles(ctx);

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
  for (const file of LOADER_FILES_TO_DELETE) {
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
  cleanupJunkFromSrc(ctx);

  console.log(
    `  Deleted ${ctx.deletedFiles.length} files/dirs, moved ${ctx.movedFiles.length} files`,
  );
}
