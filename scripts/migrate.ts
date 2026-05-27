#!/usr/bin/env tsx

/**
 * Migration Script: Fresh/Deno/Preact → TanStack Start/React/Cloudflare Workers
 *
 * Converts a Deco storefront from the old Fresh/Deno stack to the new TanStack Start stack.
 * Part of the @decocms/start framework — run from a site's root directory.
 *
 * Usage (from your Fresh site directory):
 *   npx -p @decocms/start deco-migrate [options]
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

import { execSync } from "node:child_process";
import * as path from "node:path";
import { banner, green, red, stat, yellow } from "./migrate/colors";
import { loadConfig, validateConfig } from "./migrate/config";
import { analyze } from "./migrate/phase-analyze";
import { cleanup } from "./migrate/phase-cleanup";
import { cleanupAudit } from "./migrate/phase-cleanup-audit";
import { compile } from "./migrate/phase-compile";
import { report } from "./migrate/phase-report";
import { scaffold } from "./migrate/phase-scaffold";
import { transform } from "./migrate/phase-transform";
import { verify } from "./migrate/phase-verify";
import { detectSourceLayout, explainNonClassicLayout } from "./migrate/source-layout";
import { createContext, logPhase } from "./migrate/types";

function parseArgs(args: string[]): {
  source: string;
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
  strict: boolean;
  withBuild: boolean;
  noCompile: boolean;
  noCleanupAudit: boolean;
} {
  let source = ".";
  let dryRun = false;
  let verbose = false;
  let help = false;
  let strict = false;
  let withBuild = false;
  let noCompile = false;
  let noCleanupAudit = false;

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
      case "--strict":
        strict = true;
        break;
      case "--with-build":
        withBuild = true;
        break;
      case "--no-compile":
        noCompile = true;
        break;
      case "--no-cleanup-audit":
        noCleanupAudit = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
    }
  }

  return {
    source,
    dryRun,
    verbose,
    help,
    strict,
    withBuild,
    noCompile,
    noCleanupAudit,
  };
}

function showHelp() {
  console.log(`
  @decocms/start — Migration Script: Fresh/Deno → TanStack Start

  Usage:
    npx -p @decocms/start deco-migrate [options]

  Options:
    --source <dir>        Source directory (default: .)
    --dry-run             Preview changes without writing files
    --verbose             Show detailed output for every file
    --strict              Fail (exit 2) when typecheck/build report errors
    --with-build          Also run \`vite build\` after typecheck (slower)
    --no-compile          Skip the post-bootstrap compile phase entirely
    --no-cleanup-audit    Skip the post-migration cleanup audit (run separately
                          via \`deco-post-cleanup\` if needed)
    --help, -h            Show this help message

  Examples:
    npx -p @decocms/start deco-migrate --dry-run --verbose
    npx -p @decocms/start deco-migrate --source ./my-site
    npx -p @decocms/start deco-migrate --strict --with-build
    npx -p @decocms/start deco-migrate
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

  // Load optional per-site config from `.deco-migrate.config.json`. Drives
  // section-conventions hardcoded lists today; future fields will tune
  // import rewrites, scaffolding, etc.
  const siteConfig = loadConfig(sourceDir);
  if (siteConfig) {
    validateConfig(siteConfig);
    stat("Config", green(".deco-migrate.config.json (loaded)"));
  }

  const ctx = createContext(sourceDir, {
    dryRun: opts.dryRun,
    verbose: opts.verbose,
    config: siteConfig,
  });

  // Phase 0: Source-layout detection (early-abort for unsupported layouts).
  // The analyzer assumes a classic root layout (sections/, islands/, ...);
  // running it on a modern src/ layout silently yields a near-empty
  // migration. Detect-and-abort here so the user gets an actionable error
  // before we touch any files.
  const layout = detectSourceLayout(sourceDir);
  if (layout !== "classic") {
    console.error(red(`Error: ${layout} source layout`));
    console.error("");
    console.error(explainNonClassicLayout(layout, sourceDir));
    process.exit(2);
  }

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

    // Phase 8: Compile (typecheck + optional build)
    // Skipped in dry-run, when --no-compile is passed, or when bootstrap
    // didn't install dependencies (handled inside `compile`).
    if (!opts.noCompile) {
      const compileResult = compile(ctx, {
        strict: opts.strict,
        withBuild: opts.withBuild,
      });
      if (compileResult.shouldFail) {
        process.exit(2);
      }
    }

    // Phase 9: Post-migration cleanup audit
    // Read-only scan that catches residual debt the migration script
    // can't (or won't) fix. Always informational unless --strict is on,
    // in which case warning-severity findings exit 2.
    if (!opts.noCleanupAudit) {
      const auditFailed = cleanupAudit(ctx, { strict: opts.strict });
      if (auditFailed) {
        process.exit(2);
      }
    }
  } catch (error) {
    console.error(`\n  ${red("Migration failed:")}`, error);
    process.exit(1);
  }
}

function bootstrap(ctx: { sourceDir: string }) {
  logPhase("Bootstrap (install + generate)");

  let failures = 0;
  const run = (cmd: string, label: string, critical = false) => {
    console.log(`  Running: ${label}...`);
    try {
      execSync(cmd, { cwd: ctx.sourceDir, stdio: "pipe" });
      console.log(`  ${green("✓")} ${label}`);
    } catch (e: any) {
      failures++;
      const icon = critical ? red("✗") : yellow("⚠");
      console.log(`  ${icon} ${label} failed: ${e.message?.split("\n")[0]}`);
      if (critical) {
        console.log(`\n  ${red("Bootstrap aborted.")} Fix the error above and run manually.\n`);
        return false;
      }
    }
    return true;
  };

  // bun is the fleet-wide canonical package manager for decocms storefronts.
  // We hardcode it here (instead of sniffing process.env.npm_execpath) so a
  // freshly-migrated site always commits a bun.lock and never accidentally
  // ships a package-lock.json that drifts vs bun.lock under CF Workers Builds.
  // See MIGRATION_TOOLING_PLAN.md and the package-json template for the
  // matching `packageManager` field that pins the version.
  const pm = "bun";
  if (!run(`${pm} install`, "Install dependencies", true)) return;
  run("bunx tsx node_modules/@decocms/start/scripts/generate-blocks.ts", "Generate CMS blocks");
  // generate-invoke emits src/server/invoke.gen.ts with top-level
  // createServerFn declarations + the forwardResponseCookies bridge that
  // propagates VTEX Set-Cookie headers (orderFormId, segment, sc…) to the
  // browser. Without this file, the site falls back to the proxy
  // `~/runtime.ts` route which hits /deco/invoke and used to drop cookies,
  // making the cart appear empty at /checkout after addItemToCart. The
  // upstream invoke handler now also forwards cookies correctly, but
  // running the generator gives every freshly-migrated site the canonical
  // RPC path so VTEX hooks (useCart, useUser, useWishlist) work end-to-end.
  run(
    "bunx tsx node_modules/@decocms/start/scripts/generate-invoke.ts",
    "Generate VTEX invoke server functions",
  );
  run("bunx tsr generate", "Generate TanStack routes");

  if (failures > 0) {
    console.log(
      `\n  ${yellow("Bootstrap completed with warnings.")} Check errors above before running dev.\n`,
    );
  } else {
    console.log(`\n  ${green("Ready!")} Run \`${pm} run dev\` to start the dev server.\n`);
  }
}

main();
