import * as fs from "node:fs";
import * as path from "node:path";
import type { MigrationContext } from "./types.ts";
import { log, logPhase } from "./types.ts";
import { generatePackageJson } from "./templates/package-json.ts";
import { generateTsconfig } from "./templates/tsconfig.ts";
import { generateViteConfig } from "./templates/vite-config.ts";
import { generateWrangler } from "./templates/wrangler.ts";
import { generateKnipConfig } from "./templates/knip-config.ts";
import { generateRoutes } from "./templates/routes.ts";
import { generateSetup } from "./templates/setup.ts";
import { generateServerEntry } from "./templates/server-entry.ts";

function writeFile(ctx: MigrationContext, relPath: string, content: string) {
  const fullPath = path.join(ctx.sourceDir, relPath);

  if (ctx.dryRun) {
    log(ctx, `[DRY] Would create: ${relPath}`);
    ctx.scaffoldedFiles.push(relPath);
    return;
  }

  // Ensure directory exists
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(fullPath, content, "utf-8");
  log(ctx, `Created: ${relPath}`);
  ctx.scaffoldedFiles.push(relPath);
}

export function scaffold(ctx: MigrationContext): void {
  logPhase("Scaffold");

  // Root config files
  writeFile(ctx, "package.json", generatePackageJson(ctx));
  writeFile(ctx, "tsconfig.json", generateTsconfig());
  writeFile(ctx, "vite.config.ts", generateViteConfig(ctx));
  writeFile(ctx, "wrangler.jsonc", generateWrangler(ctx));
  writeFile(ctx, "knip.config.ts", generateKnipConfig());
  writeFile(ctx, ".gitignore", generateGitignore());
  writeFile(ctx, ".prettierrc", JSON.stringify({
    semi: true,
    singleQuote: false,
    trailingComma: "all" as const,
    printWidth: 100,
    tabWidth: 2,
  }, null, 2) + "\n");

  // Server entry files
  const serverEntryFiles = generateServerEntry(ctx);
  for (const [filePath, content] of Object.entries(serverEntryFiles)) {
    writeFile(ctx, filePath, content);
  }

  // Route files
  const routeFiles = generateRoutes(ctx);
  for (const [filePath, content] of Object.entries(routeFiles)) {
    writeFile(ctx, filePath, content);
  }

  // Setup
  writeFile(ctx, "src/setup.ts", generateSetup(ctx));

  // Styles
  writeFile(ctx, "src/styles/app.css", generateAppCss(ctx));

  // Apps
  writeFile(ctx, "src/apps/site.ts", generateSiteApp(ctx));

  // Create public/ directory
  if (!ctx.dryRun) {
    fs.mkdirSync(path.join(ctx.sourceDir, "public"), { recursive: true });
  }

  console.log(`  Scaffolded ${ctx.scaffoldedFiles.length} files`);
}

function generateAppCss(_ctx: MigrationContext): string {
  return `@import "tailwindcss";
@plugin "daisyui";
@plugin "daisyui/theme" {
  name: "light";
  default: true;
  color-scheme: light;

  /* TODO: Extract theme colors from the old Theme section's CMS config */
  --color-primary: #6B21A8;
  --color-secondary: #141414;
  --color-accent: #FFF100;
  --color-neutral: #393939;
  --color-base-100: #FFFFFF;
  --color-base-200: #F3F3F3;
  --color-base-300: #868686;
  --color-info: #006CA1;
  --color-success: #007552;
  --color-warning: #F8D13A;
  --color-error: #CF040A;
}

@theme {
  --color-*: initial;
  --color-white: #fff;
  --color-black: #000;
  --color-transparent: transparent;
  --color-current: currentColor;
  --color-inherit: inherit;
}

/* View transitions */
@view-transition {
  navigation: auto;
}
`;
}

function generateGitignore(): string {
  return `# Dependencies
node_modules/

# Build output
dist/
.cache/

# Cloudflare Workers
.wrangler/
.dev.vars

# TanStack Router (auto-generated)
src/routeTree.gen.ts
.tanstack/

# Vite
vite.config.timestamp_*
*.local

# Environment
.env
.env.*

# OS
.DS_Store

# Deco CMS
.deco/metadata/*

# Lock files (use bun.lock)
package-lock.json

# IDE
.vscode/
.idea/
`;
}

function generateSiteApp(ctx: MigrationContext): string {
  return `export type Platform =
  | "vtex"
  | "vnda"
  | "shopify"
  | "wake"
  | "linx"
  | "nuvemshop"
  | "custom";

export const _platform: Platform = "${ctx.platform}";

export type AppContext = {
  device: "mobile" | "desktop" | "tablet";
  platform: Platform;
};
`;
}
