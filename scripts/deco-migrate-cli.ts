#!/usr/bin/env tsx
/**
 * deco-migrate CLI — one command to clone, migrate, and verify a Deco site.
 *
 * Usage:
 *   npx tsx scripts/deco-migrate-cli.ts <repo-or-dir> [options]
 *
 * Examples:
 *   # Clone from GitHub, migrate, compare against golden reference:
 *   npx tsx scripts/deco-migrate-cli.ts https://github.com/org/my-site \
 *     --output ~/work/my-site-migrated \
 *     --ref ~/work/my-site-storefront
 *
 *   # Migrate from local directory:
 *   npx tsx scripts/deco-migrate-cli.ts ./old-site --output ./migrated-site
 *
 *   # Quick re-run (wipe + re-migrate):
 *   npx tsx scripts/deco-migrate-cli.ts ./old-site --output ./migrated-site --clean
 *
 *   # Dry run:
 *   npx tsx scripts/deco-migrate-cli.ts ./old-site --dry-run --verbose
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";
import { banner, stat, red, green, yellow, cyan, bold, dim, icons } from "./migrate/colors.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CliOpts {
  source: string;
  output: string | null;
  ref: string | null;
  dryRun: boolean;
  verbose: boolean;
  clean: boolean;
  skipBootstrap: boolean;
  help: boolean;
  branch: string | null;
}

function parseArgs(args: string[]): CliOpts {
  const opts: CliOpts = {
    source: "",
    output: null,
    ref: null,
    dryRun: false,
    verbose: false,
    clean: false,
    skipBootstrap: false,
    help: false,
    branch: null,
  };

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--output":
      case "-o":
        opts.output = args[++i];
        break;
      case "--ref":
      case "--reference":
        opts.ref = args[++i];
        break;
      case "--branch":
      case "-b":
        opts.branch = args[++i];
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--verbose":
      case "-v":
        opts.verbose = true;
        break;
      case "--clean":
        opts.clean = true;
        break;
      case "--skip-bootstrap":
        opts.skipBootstrap = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        if (!arg.startsWith("-")) positional.push(arg);
    }
  }

  if (positional.length > 0) opts.source = positional[0];
  return opts;
}

function showHelp() {
  console.log(`
  ${bold("deco-migrate")} — Clone, migrate, and verify a Deco storefront

  ${bold("Usage:")}
    npx tsx scripts/deco-migrate-cli.ts <repo-url-or-dir> [options]

  ${bold("Arguments:")}
    <repo-url-or-dir>     Git repo URL or local directory path

  ${bold("Options:")}
    -o, --output <dir>    Output directory (default: <name>-migrated)
    --ref <dir>           Golden reference directory to diff against
    -b, --branch <name>   Git branch to clone (default: main)
    --dry-run             Preview changes without writing files
    -v, --verbose         Show detailed output for every file
    --clean               Wipe output dir before migrating (for re-runs)
    --skip-bootstrap      Skip npm install + codegen after migration
    -h, --help            Show this help message

  ${bold("Examples:")}
    ${dim("# Clone from GitHub and migrate:")}
    npx tsx scripts/deco-migrate-cli.ts https://github.com/org/my-site

    ${dim("# Migrate local dir, compare against golden reference:")}
    npx tsx scripts/deco-migrate-cli.ts ./casaevideo \\
      --ref ./casaevideo-storefront

    ${dim("# Quick re-run (wipe previous output first):")}
    npx tsx scripts/deco-migrate-cli.ts ./casaevideo \\
      -o ./casaevideo-migrated --clean

    ${dim("# Dry run to preview what would change:")}
    npx tsx scripts/deco-migrate-cli.ts ./casaevideo --dry-run -v
`);
}

function isGitUrl(source: string): boolean {
  return (
    source.startsWith("https://") ||
    source.startsWith("git@") ||
    source.startsWith("http://") ||
    source.endsWith(".git")
  );
}

function extractRepoName(source: string): string {
  // https://github.com/org/my-site.git → my-site
  // https://github.com/org/my-site → my-site
  // ./path/to/my-site → my-site
  const base = path.basename(source.replace(/\.git$/, ""));
  return base || "site";
}

function run(cmd: string, cwd?: string, label?: string): boolean {
  if (label) console.log(`  ${dim("$")} ${dim(cmd)}`);
  try {
    execSync(cmd, {
      cwd,
      stdio: label ? "pipe" : "inherit",
      timeout: 120_000,
    });
    if (label) console.log(`  ${icons.success} ${label}`);
    return true;
  } catch (e: any) {
    if (label) {
      console.log(`  ${icons.error} ${label}: ${e.message?.split("\n")[0] || "failed"}`);
    }
    return false;
  }
}

function cloneRepo(source: string, dest: string, branch: string | null): boolean {
  console.log(`\n  Cloning ${cyan(source)}...`);
  const branchArg = branch ? ` --branch ${branch}` : "";
  const depthArg = " --depth 1";
  const ok = run(
    `git clone${depthArg}${branchArg} "${source}" "${dest}"`,
    undefined,
    "Clone repository",
  );
  if (!ok) return false;

  // Strip remote to prevent accidental pushes
  run(`git remote remove origin`, dest, "Remove git remote");
  return true;
}

function copyLocal(source: string, dest: string): boolean {
  console.log(`\n  Copying ${cyan(source)} → ${cyan(dest)}...`);
  try {
    // Use cp -r, excluding .git and node_modules
    execSync(
      `rsync -a --exclude='.git' --exclude='node_modules' --exclude='_fresh' --exclude='.wrangler' "${source}/" "${dest}/"`,
      { stdio: "pipe", timeout: 120_000 },
    );
    console.log(`  ${icons.success} Copied source directory`);

    // Init fresh git so the migration has a clean baseline
    run(`git init`, dest);
    run(`git add -A && git commit -m "pre-migration snapshot" --allow-empty`, dest);
    return true;
  } catch (e: any) {
    console.log(`  ${icons.error} Copy failed: ${e.message?.split("\n")[0]}`);
    return false;
  }
}

function runMigration(
  dest: string,
  scriptDir: string,
  opts: { dryRun: boolean; verbose: boolean; skipBootstrap: boolean },
): boolean {
  const migrateScript = path.join(scriptDir, "migrate.ts");
  const args = ["tsx", migrateScript, "--source", dest];
  if (opts.dryRun) args.push("--dry-run");
  if (opts.verbose) args.push("--verbose");

  console.log("");
  const result = spawnSync("npx", args, {
    cwd: scriptDir.replace(/\/scripts$/, ""),
    stdio: "inherit",
    env: {
      ...process.env,
      SKIP_BOOTSTRAP: opts.skipBootstrap ? "1" : "",
    },
    timeout: 300_000,
  });

  return result.status === 0;
}

function diffAgainstRef(migrated: string, ref: string): void {
  banner("Comparing against golden reference");
  stat("Migrated", migrated);
  stat("Reference", ref);

  if (!fs.existsSync(ref)) {
    console.log(`\n  ${icons.error} Reference dir does not exist: ${ref}`);
    return;
  }

  const migratedSrc = path.join(migrated, "src");
  const refSrc = path.join(ref, "src");

  if (!fs.existsSync(migratedSrc) || !fs.existsSync(refSrc)) {
    console.log(`\n  ${icons.error} One or both src/ directories missing`);
    return;
  }

  // 1. File count comparison
  console.log(`\n  ${bold("File counts:")}`);
  const countFiles = (dir: string, ext: string): number => {
    try {
      const result = execSync(
        `find "${dir}" -name "*${ext}" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/server/*" | wc -l`,
        { encoding: "utf-8" },
      );
      return parseInt(result.trim(), 10);
    } catch {
      return 0;
    }
  };

  for (const [label, subdir] of [
    ["sections", "sections"],
    ["components", "components"],
    ["loaders", "loaders"],
    ["hooks", "hooks"],
    ["sdk", "sdk"],
    ["types", "types"],
  ] as const) {
    const mDir = path.join(migratedSrc, subdir);
    const rDir = path.join(refSrc, subdir);
    const mCount = fs.existsSync(mDir) ? countFiles(mDir, ".tsx") + countFiles(mDir, ".ts") : 0;
    const rCount = fs.existsSync(rDir) ? countFiles(rDir, ".tsx") + countFiles(rDir, ".ts") : 0;
    const delta = mCount - rCount;
    const deltaStr = delta === 0 ? green("=") : delta > 0 ? yellow(`+${delta}`) : red(`${delta}`);
    console.log(`    ${label.padEnd(14)} migrated: ${String(mCount).padStart(4)}  ref: ${String(rCount).padStart(4)}  (${deltaStr})`);
  }

  // 2. Key import pattern checks
  console.log(`\n  ${bold("Remaining old imports (migrated):")}`);
  const grepCount = (dir: string, pattern: string): number => {
    try {
      const result = execSync(
        `grep -rl '${pattern}' "${dir}" --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules | grep -v '/server/' | wc -l`,
        { encoding: "utf-8" },
      );
      return parseInt(result.trim(), 10);
    } catch {
      return 0;
    }
  };

  const patterns = [
    ["from \"preact", "preact imports"],
    ["from \"@preact/", "@preact/* imports"],
    ["from \"@deco/deco", "@deco/deco imports"],
    ["from \"$fresh/", "$fresh imports"],
    ['from "apps/', "apps/* imports"],
    ['from "site/', "site/* imports"],
    ['from "$store/', "$store/* imports"],
    ["export const cache", "old cache exports"],
  ];

  for (const [pattern, label] of patterns) {
    const count = grepCount(migratedSrc, pattern);
    const icon = count === 0 ? icons.success : icons.warning;
    console.log(`    ${icon} ${label}: ${count} files`);
  }

  // 3. Missing scaffolded files
  console.log(`\n  ${bold("Scaffolded file parity:")}`);
  const checkFiles = [
    "setup.ts",
    "cache-config.ts",
    "worker-entry.ts",
    "server.ts",
    "router.tsx",
    "runtime.ts",
    "setup/commerce-loaders.ts",
    "setup/section-loaders.ts",
    "hooks/useCart.ts",
    "hooks/useUser.ts",
    "hooks/useWishlist.ts",
    "types/widgets.ts",
    "types/deco.ts",
    "components/ui/Image.tsx",
    "components/ui/Picture.tsx",
    "styles/app.css",
    "routes/__root.tsx",
    "routes/$.tsx",
    "routes/index.tsx",
  ];

  for (const file of checkFiles) {
    const mExists = fs.existsSync(path.join(migratedSrc, file));
    const rExists = fs.existsSync(path.join(refSrc, file));
    if (mExists && rExists) {
      console.log(`    ${icons.success} ${file}`);
    } else if (!mExists && rExists) {
      console.log(`    ${icons.error} ${file} — ${red("missing in migrated")}`);
    } else if (mExists && !rExists) {
      console.log(`    ${icons.info} ${file} — ${dim("extra in migrated (not in ref)")}`);
    }
  }

  // 4. public/ assets
  console.log(`\n  ${bold("public/ assets:")}`);
  const mPublic = path.join(migrated, "public");
  const rPublic = path.join(ref, "public");
  const mPubCount = fs.existsSync(mPublic) ? countFiles(mPublic, "") : 0;
  const rPubCount = fs.existsSync(rPublic) ? countFiles(rPublic, "") : 0;
  console.log(`    migrated: ${mPubCount} files, ref: ${rPubCount} files`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || !opts.source) {
    showHelp();
    process.exit(opts.help ? 0 : 1);
  }

  const scriptDir = path.resolve(__dirname, ".");
  const repoName = extractRepoName(opts.source);
  const outputDir = path.resolve(opts.output || `${repoName}-migrated`);

  banner("deco-migrate CLI");
  stat("Source", opts.source);
  stat("Output", outputDir);
  if (opts.ref) stat("Reference", path.resolve(opts.ref));
  stat("Mode", opts.dryRun ? yellow("DRY RUN") : green("EXECUTE"));

  // Clean output dir if requested
  if (opts.clean && fs.existsSync(outputDir)) {
    console.log(`\n  Cleaning ${outputDir}...`);
    fs.rmSync(outputDir, { recursive: true, force: true });
    console.log(`  ${icons.success} Cleaned output directory`);
  }

  // Check if output already exists
  if (fs.existsSync(outputDir) && !opts.dryRun) {
    const srcDir = path.join(outputDir, "src");
    if (fs.existsSync(srcDir)) {
      console.log(`\n  ${icons.error} Output directory already exists and has src/: ${outputDir}`);
      console.log(`  ${dim("Use --clean to wipe it first, or choose a different --output")}`);
      process.exit(1);
    }
  }

  // Step 1: Get the source code
  let acquired = false;
  if (isGitUrl(opts.source)) {
    acquired = cloneRepo(opts.source, outputDir, opts.branch);
  } else {
    const sourceDir = path.resolve(opts.source);
    if (!fs.existsSync(sourceDir)) {
      console.log(`\n  ${icons.error} Source directory not found: ${sourceDir}`);
      process.exit(1);
    }
    acquired = copyLocal(sourceDir, outputDir);
  }

  if (!acquired) {
    console.log(`\n  ${red("Failed to acquire source. Aborting.")}`);
    process.exit(1);
  }

  // Step 2: Run migration
  const migrationOk = runMigration(outputDir, scriptDir, {
    dryRun: opts.dryRun,
    verbose: opts.verbose,
    skipBootstrap: opts.skipBootstrap || opts.dryRun,
  });

  // Step 3: Compare against reference (if provided)
  if (opts.ref && !opts.dryRun) {
    diffAgainstRef(outputDir, path.resolve(opts.ref));
  }

  // Final status
  console.log("");
  if (migrationOk) {
    banner("Migration complete");
    console.log(`\n  ${green("Output:")} ${outputDir}`);
    if (!opts.dryRun) {
      console.log(`\n  ${bold("Next steps:")}`);
      console.log(`    cd ${outputDir}`);
      console.log(`    npm install`);
      console.log(`    npm run generate:blocks`);
      console.log(`    npm run generate:schema`);
      console.log(`    npx tsr generate`);
      console.log(`    npm run dev`);
    }
  } else {
    console.log(`  ${yellow("Migration completed with issues.")} Check the report above.`);
    console.log(`  ${dim("Output:")} ${outputDir}`);
  }
  console.log("");
}

main();
