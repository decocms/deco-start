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
import { generateAppCss } from "./templates/app-css.ts";
import { generateTypeFiles } from "./templates/types-gen.ts";
import { generateUiComponents } from "./templates/ui-components.ts";
import { generateHooks } from "./templates/hooks.ts";
import { generateCommerceLoaders } from "./templates/commerce-loaders.ts";
import { generateSectionLoaders } from "./templates/section-loaders.ts";
import { generateCacheConfig } from "./templates/cache-config.ts";
import { generateSdkFiles } from "./templates/sdk-gen.ts";
import { extractTheme } from "./analyzers/theme-extractor.ts";

function writeFile(ctx: MigrationContext, relPath: string, content: string) {
  const fullPath = path.join(ctx.sourceDir, relPath);

  if (ctx.dryRun) {
    log(ctx, `[DRY] Would create: ${relPath}`);
    ctx.scaffoldedFiles.push(relPath);
    return;
  }

  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(fullPath, content, "utf-8");
  log(ctx, `Created: ${relPath}`);
  ctx.scaffoldedFiles.push(relPath);
}

function writeMultiFile(ctx: MigrationContext, files: Record<string, string>) {
  for (const [filePath, content] of Object.entries(files)) {
    writeFile(ctx, filePath, content);
  }
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

  // Server entry files (server.ts, worker-entry.ts, router.tsx, runtime.ts, context.ts)
  writeMultiFile(ctx, generateServerEntry(ctx));

  // Route files
  writeMultiFile(ctx, generateRoutes(ctx));

  // Setup infrastructure
  writeFile(ctx, "src/setup.ts", generateSetup(ctx));
  writeFile(ctx, "src/cache-config.ts", generateCacheConfig(ctx));
  writeFile(ctx, "src/setup/commerce-loaders.ts", generateCommerceLoaders(ctx));
  writeFile(ctx, "src/setup/section-loaders.ts", generateSectionLoaders(ctx));

  // Theme extraction + Styles
  const theme = extractTheme(ctx);
  writeFile(ctx, "src/styles/app.css", generateAppCss(ctx, theme));

  // Type definitions
  writeMultiFile(ctx, generateTypeFiles(ctx));

  // UI components (Image, Picture, Video)
  writeMultiFile(ctx, generateUiComponents(ctx));

  // Platform hooks (useCart, useUser, useWishlist)
  writeMultiFile(ctx, generateHooks(ctx));

  // SDK shims + generated utilities
  writeFile(ctx, "src/sdk/signal.ts", generateSignalShim());
  writeFile(ctx, "src/sdk/clx.ts", generateClxShim());
  writeFile(ctx, "src/sdk/debounce.ts", generateDebounceShim());
  writeMultiFile(ctx, generateSdkFiles(ctx));

  // Apps
  writeFile(ctx, "src/apps/site.ts", generateSiteApp(ctx));

  // SiteTheme component (replaces apps/website/components/Theme.tsx)
  const usesSiteTheme = ctx.files.some((f) => {
    if (f.action === "delete") return false;
    try {
      const content = fs.readFileSync(f.absPath, "utf-8");
      return content.includes("SiteTheme");
    } catch {
      return false;
    }
  });
  if (usesSiteTheme) {
    writeFile(ctx, "src/components/ui/Theme.tsx", generateSiteThemeComponent());
  }

  // Create public/ directory
  if (!ctx.dryRun) {
    fs.mkdirSync(path.join(ctx.sourceDir, "public"), { recursive: true });
  }

  console.log(`  Scaffolded ${ctx.scaffoldedFiles.length} files`);
}

function generateSiteThemeComponent(): string {
  return `export interface Font {
  family: string;
  styleSheet?: string;
}

export interface Props {
  colorScheme?: "light" | "dark" | "any";
  fonts?: Font[];
  variables?: Array<{ name: string; value: string }>;
}

export default function SiteTheme({ variables, fonts, colorScheme }: Props) {
  const cssVars = variables?.length
    ? \`:root { \${variables.map((v) => \`\${v.name}: \${v.value};\`).join(" ")} }\`
    : "";

  const colorSchemeCss = colorScheme && colorScheme !== "any"
    ? \`:root { color-scheme: \${colorScheme}; }\`
    : "";

  const css = [cssVars, colorSchemeCss].filter(Boolean).join("\\n");

  return (
    <>
      {fonts?.map((font) =>
        font.styleSheet ? (
          <link key={font.family} rel="stylesheet" href={font.styleSheet} />
        ) : null
      )}
      {css && <style dangerouslySetInnerHTML={{ __html: css }} />}
    </>
  );
}

export { type Font as SiteThemeFont };
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

# IDE
.vscode/
.idea/
`;
}

function generateClxShim(): string {
  return `/** Filter out nullable values, join and minify class names */
export const clx = (...args: (string | null | undefined | false)[]) =>
  args.filter(Boolean).join(" ").replace(/\\s\\s+/g, " ");

/** Alias for compat — some files import as clsx */
export const clsx = clx;

export default clx;
`;
}

function generateDebounceShim(): string {
  return `/** Debounce a function call — drop-in replacement for Deno std/async/debounce */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay = 250,
): T & { clear(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const debounced = ((...args: Parameters<T>) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, delay);
  }) as T & { clear(): void };

  debounced.clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return debounced;
}

export default debounce;
`;
}

function generateSignalShim(): string {
  return `export { signal, type ReactiveSignal } from "@decocms/start/sdk/signal";

/** Run a function immediately. Kept for legacy module-level side effects. */
export function effect(fn: () => void | (() => void)): () => void {
  const cleanup = fn();
  return typeof cleanup === "function" ? cleanup : () => {};
}
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
