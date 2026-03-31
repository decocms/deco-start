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

  // SDK — signal shim (replaces @preact/signals)
  writeFile(ctx, "src/sdk/signal.ts", generateSignalShim());

  // SDK — clx (class name joiner, with default export for compat)
  writeFile(ctx, "src/sdk/clx.ts", generateClxShim());

  // Apps
  writeFile(ctx, "src/apps/site.ts", generateSiteApp(ctx));

  // SiteTheme component (replaces apps/website/components/Theme.tsx)
  // Check if any source file uses SiteTheme
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

/**
 * SiteTheme — injects CSS custom properties and font stylesheets into the page.
 * This replaces the old apps/website/components/Theme.tsx from the Deno stack.
 */
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

function generateAppCss(ctx: MigrationContext): string {
  const c = ctx.themeColors;
  // Map CMS color names to DaisyUI v5 CSS variables
  const colors: Record<string, string> = {
    "--color-primary": c["primary"] || "#6B21A8",
    "--color-secondary": c["secondary"] || "#141414",
    "--color-accent": c["tertiary"] || "#FFF100",
    "--color-neutral": c["neutral"] || "#393939",
    "--color-base-100": c["base-100"] || "#FFFFFF",
    "--color-base-200": c["base-200"] || "#F3F3F3",
    "--color-base-300": c["base-300"] || "#868686",
    "--color-info": c["info"] || "#006CA1",
    "--color-success": c["success"] || "#007552",
    "--color-warning": c["warning"] || "#F8D13A",
    "--color-error": c["error"] || "#CF040A",
  };
  // Add content colors if specified
  if (c["primary-content"]) colors["--color-primary-content"] = c["primary-content"];
  if (c["secondary-content"]) colors["--color-secondary-content"] = c["secondary-content"];
  if (c["base-content"]) colors["--color-base-content"] = c["base-content"];

  const colorLines = Object.entries(colors)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");

  return `@import "tailwindcss";
@plugin "daisyui";
@plugin "daisyui/theme" {
  name: "light";
  default: true;
  color-scheme: light;

${colorLines}
}

@theme {
  --color-*: initial;
  --color-white: #fff;
  --color-black: #000;
  --color-transparent: transparent;
  --color-current: currentColor;
  --color-inherit: inherit;${ctx.fontFamily ? `\n  --font-sans: "${ctx.fontFamily}", ui-sans-serif, system-ui, sans-serif;` : ""}
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

# Bun lock file (if using npm, keep package-lock.json instead)
# package-lock.json

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

function generateSignalShim(): string {
  return `import { Store } from "@tanstack/store";
import { useSyncExternalStore, useMemo } from "react";

export interface Signal<T> {
  readonly store: Store<T>;
  value: T;
  peek(): T;
  subscribe(fn: () => void): () => void;
}

export function signal<T>(initialValue: T): Signal<T> {
  const store = new Store<T>(initialValue);
  return {
    store,
    get value() { return store.state; },
    set value(v: T) { store.setState(() => v); },
    peek() { return store.state; },
    subscribe(fn) {
      // @tanstack/store@0.9.x returns { unsubscribe: Function },
      // NOT a plain function. React's useSyncExternalStore cleanup
      // expects a bare function — unwrap it.
      const sub = store.subscribe(() => fn());
      return typeof sub === "function" ? sub : sub.unsubscribe;
    },
  };
}

export function useSignal<T>(initialValue: T): Signal<T> {
  const sig = useMemo(() => signal(initialValue), []);
  useSyncExternalStore(
    (cb) => sig.subscribe(cb),
    () => sig.value,
    () => sig.value,
  );
  return sig;
}

export function useComputed<T>(fn: () => T): Signal<T> {
  const sig = useMemo(() => signal(fn()), []);
  return sig;
}

export function computed<T>(fn: () => T): Signal<T> {
  return signal(fn());
}

export function effect(fn: () => void | (() => void)): () => void {
  const cleanup = fn();
  return typeof cleanup === "function" ? cleanup : () => {};
}

export function batch(fn: () => void): void {
  fn();
}

export function useSignalEffect(fn: () => void | (() => void)): void {
  fn();
}

export type { Signal as ReadonlySignal };
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
