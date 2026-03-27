import * as fs from "node:fs";
import * as path from "node:path";
import type { MigrationContext } from "./types.ts";
import { logPhase } from "./types.ts";

interface Check {
  name: string;
  fn: (ctx: MigrationContext) => boolean;
  severity: "error" | "warning";
}

const REQUIRED_FILES = [
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "wrangler.jsonc",
  "knip.config.ts",
  ".prettierrc",
  "src/server.ts",
  "src/worker-entry.ts",
  "src/router.tsx",
  "src/runtime.ts",
  "src/context.ts",
  "src/setup.ts",
  "src/styles/app.css",
  "src/apps/site.ts",
  "src/routes/__root.tsx",
  "src/routes/index.tsx",
  "src/routes/$.tsx",
  "src/routes/deco/meta.ts",
  "src/routes/deco/invoke.$.ts",
  "src/routes/deco/render.ts",
];

const MUST_NOT_EXIST = [
  "deno.json",
  "fresh.gen.ts",
  "manifest.gen.ts",
  "dev.ts",
  "main.ts",
  "islands/BlogFeed.tsx",
  "routes/_app.tsx",
];

const checks: Check[] = [
  {
    name: "All scaffolded files exist",
    severity: "error",
    fn: (ctx) => {
      const missing = REQUIRED_FILES.filter(
        (f) => !fs.existsSync(path.join(ctx.sourceDir, f)),
      );
      if (missing.length > 0) {
        console.log(`    Missing: ${missing.join(", ")}`);
        return false;
      }
      return true;
    },
  },
  {
    name: "Old artifacts removed",
    severity: "error",
    fn: (ctx) => {
      const remaining = MUST_NOT_EXIST.filter(
        (f) => fs.existsSync(path.join(ctx.sourceDir, f)),
      );
      if (remaining.length > 0) {
        console.log(`    Still exists: ${remaining.join(", ")}`);
        return false;
      }
      return true;
    },
  },
  {
    name: "No preact imports in src/",
    severity: "error",
    fn: (ctx) => {
      const srcDir = path.join(ctx.sourceDir, "src");
      if (!fs.existsSync(srcDir)) return true;
      const bad = findFilesWithPattern(srcDir, /from\s+["']preact/);
      if (bad.length > 0) {
        console.log(`    Still has preact imports: ${bad.join(", ")}`);
        return false;
      }
      return true;
    },
  },
  {
    name: "No $fresh imports in src/",
    severity: "error",
    fn: (ctx) => {
      const srcDir = path.join(ctx.sourceDir, "src");
      if (!fs.existsSync(srcDir)) return true;
      const bad = findFilesWithPattern(srcDir, /from\s+["']\$fresh/);
      if (bad.length > 0) {
        console.log(`    Still has $fresh imports: ${bad.join(", ")}`);
        return false;
      }
      return true;
    },
  },
  {
    name: "No deno-lint-ignore in src/",
    severity: "warning",
    fn: (ctx) => {
      const srcDir = path.join(ctx.sourceDir, "src");
      if (!fs.existsSync(srcDir)) return true;
      const bad = findFilesWithPattern(srcDir, /deno-lint-ignore/);
      if (bad.length > 0) {
        console.log(`    Still has deno-lint-ignore: ${bad.join(", ")}`);
        return false;
      }
      return true;
    },
  },
  {
    name: 'No class= in JSX (should be className=)',
    severity: "warning",
    fn: (ctx) => {
      const srcDir = path.join(ctx.sourceDir, "src");
      if (!fs.existsSync(srcDir)) return true;
      const bad = findFilesWithPattern(srcDir, /<[a-zA-Z][^>]*\sclass\s*=/);
      if (bad.length > 0) {
        console.log(`    Still has class= in JSX: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ` (+${bad.length - 5} more)` : ""}`);
        return false;
      }
      return true;
    },
  },
  {
    name: "public/ has static assets",
    severity: "warning",
    fn: (ctx) => {
      const publicDir = path.join(ctx.sourceDir, "public");
      if (!fs.existsSync(publicDir)) {
        console.log("    public/ directory missing");
        return false;
      }
      const hasSprites = fs.existsSync(
        path.join(publicDir, "sprites.svg"),
      );
      const hasFavicon = fs.existsSync(
        path.join(publicDir, "favicon.ico"),
      );
      if (!hasSprites) console.log("    Missing: public/sprites.svg");
      if (!hasFavicon) console.log("    Missing: public/favicon.ico");
      return hasSprites && hasFavicon;
    },
  },
  {
    name: "package.json has correct dependencies",
    severity: "error",
    fn: (ctx) => {
      const pkgPath = path.join(ctx.sourceDir, "package.json");
      if (!fs.existsSync(pkgPath)) return false;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const required = [
        "@decocms/start",
        "@decocms/apps",
        "react",
        "react-dom",
        "@tanstack/react-start",
        "vite",
        "knip",
      ];
      const missing = required.filter((d) => !deps[d]);
      if (missing.length > 0) {
        console.log(`    Missing deps: ${missing.join(", ")}`);
        return false;
      }
      return true;
    },
  },
  {
    name: "No site/ imports (should be ~/)",
    severity: "warning",
    fn: (ctx) => {
      const srcDir = path.join(ctx.sourceDir, "src");
      if (!fs.existsSync(srcDir)) return true;
      const bad = findFilesWithPattern(srcDir, /from\s+["']site\//);
      if (bad.length > 0) {
        console.log(`    Still has site/ imports: ${bad.join(", ")}`);
        return false;
      }
      return true;
    },
  },
];

function findFilesWithPattern(
  dir: string,
  pattern: RegExp,
  results: string[] = [],
): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      findFilesWithPattern(fullPath, pattern, results);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      const content = fs.readFileSync(fullPath, "utf-8");
      if (pattern.test(content)) {
        results.push(path.relative(dir, fullPath));
      }
    }
  }
  return results;
}

export function verify(ctx: MigrationContext): boolean {
  logPhase("Verify (Smoke Test)");

  if (ctx.dryRun) {
    console.log("  Skipping verify in dry-run mode\n");
    return true;
  }

  let errors = 0;
  let warnings = 0;

  for (const check of checks) {
    const pass = check.fn(ctx);
    const icon = pass ? "\x1b[32m✓\x1b[0m" : check.severity === "error" ? "\x1b[31m✗\x1b[0m" : "\x1b[33m⚠\x1b[0m";
    console.log(`  ${icon} ${check.name}`);
    if (!pass) {
      if (check.severity === "error") errors++;
      else warnings++;
    }
  }

  console.log(
    `\n  Result: ${checks.length - errors - warnings} passed, ${errors} errors, ${warnings} warnings`,
  );

  if (errors > 0) {
    console.log("  \x1b[31mVerification FAILED — migration has issues that must be fixed\x1b[0m");
    return false;
  }
  if (warnings > 0) {
    console.log("  \x1b[33mVerification passed with warnings\x1b[0m");
  } else {
    console.log("  \x1b[32mVerification PASSED\x1b[0m");
  }

  return true;
}
