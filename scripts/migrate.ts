#!/usr/bin/env tsx
/**
 * Migration Script: Fresh/Deno/Preact → TanStack Start/React/Cloudflare Workers
 *
 * Converts a Deco storefront from the old Fresh/Deno stack to the new TanStack Start stack.
 * Part of the @decocms/start framework — run from a site's root directory.
 *
 * Usage (from site root):
 *   npx tsx node_modules/@decocms/start/scripts/migrate.ts [options]
 *
 * Options:
 *   --source <dir>    Source directory (default: current directory)
 *   --dry-run         Preview changes without writing files
 *   --verbose         Show detailed output
 *   --help            Show this help message
 *
 * Phases:
 *   1. Analyze  — Scan source site, categorize files, detect patterns
 *   2. Scaffold — Create target structure (configs, routes, infra files)
 *   3. Transform — Convert source files (imports, JSX, Fresh APIs, Deno-isms, Tailwind)
 *   4. Cleanup  — Delete old artifacts, move static → public
 *   5. Report   — Generate MIGRATION_REPORT.md with findings
 *   6. Verify   — Smoke test the migrated output
 */

import * as path from "node:path";
import { execSync } from "node:child_process";
import { createContext, logPhase } from "./migrate/types.ts";
import { analyze } from "./migrate/phase-analyze.ts";
import { scaffold } from "./migrate/phase-scaffold.ts";
import { transform } from "./migrate/phase-transform.ts";
import { cleanup } from "./migrate/phase-cleanup.ts";
import { report } from "./migrate/phase-report.ts";
import { verify } from "./migrate/phase-verify.ts";
import { banner, stat, red, green, yellow } from "./migrate/colors.ts";

function parseArgs(args: string[]): {
  source: string;
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
} {
  let source = ".";
  let dryRun = false;
  let verbose = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--source":
        source = args[++i];
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--verbose":
        verbose = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
    }
  }

  return { source, dryRun, verbose, help };
}

function showHelp() {
  console.log(`
  @decocms/start — Migration Script: Fresh/Deno → TanStack Start

  Usage:
    npx tsx node_modules/@decocms/start/scripts/migrate.ts [options]

  Options:
    --source <dir>    Source directory (default: .)
    --dry-run         Preview changes without writing files
    --verbose         Show detailed output for every file
    --help, -h        Show this help message

  Examples:
    npx tsx node_modules/@decocms/start/scripts/migrate.ts --dry-run --verbose
    npx tsx node_modules/@decocms/start/scripts/migrate.ts --source ./my-site
    npx tsx node_modules/@decocms/start/scripts/migrate.ts
  `);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    showHelp();
    process.exit(0);
  }

  const sourceDir = path.resolve(opts.source);

  banner("@decocms/start — Migrate: Fresh/Deno → TanStack Start");
  stat("Source", sourceDir);
  stat("Mode", opts.dryRun ? yellow("DRY RUN") : green("EXECUTE"));
  stat("Verbose", opts.verbose ? "yes" : "no");

  const ctx = createContext(sourceDir, {
    dryRun: opts.dryRun,
    verbose: opts.verbose,
  });

  try {
    // Phase 1: Analyze source
    analyze(ctx);

    // Phase 2: Scaffold target structure
    scaffold(ctx);

    // Phase 3: Transform source files
    transform(ctx);

    // Phase 4: Cleanup old artifacts
    cleanup(ctx);

    // Phase 5: Generate report
    report(ctx);

    // Phase 6: Verify (smoke test)
    const ok = verify(ctx);
    if (!ok) {
      process.exit(2);
    }

    // Phase 7: Bootstrap (install + generate)
    if (!ctx.dryRun) {
      bootstrap(ctx);
    }
  } catch (error) {
    console.error(`\n  ${red("Migration failed:")}`, error);
    process.exit(1);
  }
}

function bootstrap(ctx: { sourceDir: string }) {
  logPhase("Bootstrap (install + generate)");

  const run = (cmd: string, label: string) => {
    console.log(`  Running: ${label}...`);
    try {
      execSync(cmd, { cwd: ctx.sourceDir, stdio: "pipe" });
      console.log(`  ${green("✓")} ${label}`);
    } catch (e: any) {
      console.log(`  ${yellow("⚠")} ${label} failed: ${e.message?.split("\n")[0]}`);
    }
  };

  // Detect package manager
  const pm = process.env.npm_execpath?.includes("bun") ? "bun" : "npm";
  run(`${pm} install`, "Install dependencies");
  run("npx tsx node_modules/@decocms/start/scripts/generate-blocks.ts", "Generate CMS blocks");
  run("npx tsr generate", "Generate TanStack routes");

  console.log(`\n  ${green("Ready!")} Run \`${pm} run dev\` to start the dev server.\n`);
}

main();
