import * as fs from "node:fs";
import * as path from "node:path";
import type { MigrationContext } from "./types";
import { log, logPhase } from "./types";
import { generatePackageJson } from "./templates/package-json";
import { generateTsconfig } from "./templates/tsconfig";
import { generateViteConfig } from "./templates/vite-config";
import { generateGithubWorkflows } from "./templates/github-workflows";
import { generateKnipConfig } from "./templates/knip-config";
import { generateRoutes } from "./templates/routes";
import { generateSetup } from "./templates/setup";
import { generateServerEntry } from "./templates/server-entry";
import { generateAppCss } from "./templates/app-css";
import { generateTypeFiles } from "./templates/types-gen";
import { generateUiComponents } from "./templates/ui-components";
import { generateHooks } from "./templates/hooks";
import { generateCommerceLoaders } from "./templates/commerce-loaders";
import { generateSectionLoaders } from "./templates/section-loaders";
import { generateCacheConfig } from "./templates/cache-config";
import { generateSdkFiles } from "./templates/sdk-gen";
import { generateMigrationPolicyPointerRule } from "./templates/cursor-rules";
// `lib-utils` is imported lazily — see end of phase-cleanup. Eager
// generation of all 11 shims left every site with dead code that had
// to be cleaned up by hand.
import { extractTheme } from "./analyzers/theme-extractor";

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

  // Root config files. wrangler.jsonc is INTENTIONALLY not generated --
  // per D6.2, the canonical wrangler config lives in decocms/deco-start under
  // deploy/wrangler-template.jsonc; the file is materialized locally by
  // `deco-wrangler gen` and gitignored. Worker name = storefront repo basename
  // by convention; there is no per-site registry.
  writeFile(ctx, "package.json", generatePackageJson(ctx));
  writeFile(ctx, "tsconfig.json", generateTsconfig());
  writeFile(ctx, "vite.config.ts", generateViteConfig(ctx));
  writeFile(ctx, "knip.config.ts", generateKnipConfig());
  writeFile(ctx, ".gitignore", generateGitignore());

  // Caller workflow stubs that delegate to decocms/deco-start's reusable
  // workflows. The customer repo holds no deploy logic of its own.
  writeMultiFile(ctx, generateGithubWorkflows());
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

  // Secrets — extract env vars referenced by source AppContext
  // Must be generated BEFORE commerce-loaders and section-loaders since
  // those templates check for the secrets file to wire `...secrets` spreads.
  writeFile(ctx, "src/utils/secrets.ts", generateSecrets(ctx));

  // Apps
  writeFile(ctx, "src/apps/site.ts", generateSiteApp(ctx));

  // account.json is copied from source (if exists) or generated as fallback
  if (!ctx.files.some((f) => f.path === "account.json" && f.action !== "delete")) {
    const accountName = ctx.vtexAccount || ctx.siteName;
    writeFile(ctx, "src/account.json", JSON.stringify(accountName));
  }

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
  writeFile(ctx, "src/sdk/logger.ts", generateLoggerStub());
  writeMultiFile(ctx, generateSdkFiles(ctx));

  // VTEX utility wrappers (signature-compatible stubs) are no longer
  // generated eagerly here. They're written lazily at end of phase-cleanup,
  // after all import rewrites have run, so that we only emit shims that
  // some file actually imports. See `writeImportedLibShims` in phase-cleanup.

  // Replace Context-based useDevice with SSR-safe useSyncExternalStore version.
  // @decocms/start shell-renders sections in a separate React root without
  // Device.Provider, so the old createContext pattern throws during SSR.
  writeFile(ctx, "src/contexts/device.tsx", generateDeviceContext());

  // Location matcher — server-side geolocation matching
  if (hasLocationMatcher(ctx)) {
    writeFile(ctx, "src/matchers/location.ts", generateLocationMatcher());
  }

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

  // Migration tooling policy pointer rule (D1–D5 + priorities).
  // The canonical rule lives in decocms/deco-start; this is a tiny
  // pointer that loads on every Cursor session in the migrated site
  // so agents working on the site know where the policy is and what
  // it means here. See MIGRATION_TOOLING_PLAN.md (Wave 12-H).
  writeFile(
    ctx,
    ".cursor/rules/migration-tooling-policy.mdc",
    generateMigrationPolicyPointerRule(ctx.siteName),
  );

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
# Generated by \`deco-wrangler\` from @decocms/start's wrangler template.
# Worker name is derived from the git remote / package.json by convention.
wrangler.jsonc

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

function generateLoggerStub(): string {
  return `export const logger = {
  error: console.error,
  warn: console.warn,
  info: console.info,
  debug: console.debug,
  log: console.log,
};
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
  return `import { useState, useRef, useEffect, useMemo, useCallback } from "react";
export { signal, type ReactiveSignal } from "@decocms/start/sdk/signal";

/** Run a function immediately. Kept for legacy module-level side effects. */
export function effect(fn: () => void | (() => void)): () => void {
  const cleanup = fn();
  return typeof cleanup === "function" ? cleanup : () => {};
}

/**
 * React shim for @preact/signals' useSignal.
 * Returns a mutable ref-like object with a .value property that triggers re-renders.
 */
export function useSignal<T>(initialValue: T): { value: T } {
  const [value, setValue] = useState<T>(initialValue);
  const ref = useRef(value);
  ref.current = value;
  return useMemo(
    () => ({
      get value() { return ref.current; },
      set value(v: T) {
        ref.current = v;
        setValue(v);
      },
    }),
    [],
  );
}

/**
 * React shim for @preact/signals' useComputed.
 * Re-evaluates when deps change (but since we don't track signals, it runs every render).
 */
export function useComputed<T>(compute: () => T): { readonly value: T } {
  const [value, setValue] = useState<T>(compute);
  useEffect(() => { setValue(compute()); });
  return useMemo(() => ({ get value() { return value; } }), [value]);
}

/**
 * React shim for @preact/signals' useSignalEffect.
 * Runs the callback as a useEffect (no automatic signal tracking).
 */
export function useSignalEffect(cb: () => void | (() => void)): void {
  useEffect(cb);
}
`;
}

function generateDeviceContext(): string {
  return `import { useSyncExternalStore } from "react";

const MOBILE_QUERY = "(max-width: 767px)";

function subscribe(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getSnapshot(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Reactive mobile detection based on viewport width via matchMedia.
 * SSR defaults to desktop (false); hydrates to the real value on mount.
 *
 * For server-side device detection (UA-based), use the section loader
 * pattern: registerSectionLoaders injects \`isMobile\` as a prop.
 */
export const useDevice = () => {
  const isMobile = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { isMobile };
};
`;
}

function generateSiteApp(ctx: MigrationContext): string {
  // Try to read source site.ts to extract secrets and AppContext shape
  const secretFields = extractSecretFields(ctx);

  let secretImport = "";
  let secretTypes = "";
  if (secretFields.length > 0) {
    secretImport = `\nimport type { Secret } from "~/utils/secrets";\n`;
    secretTypes = secretFields.map((f) => `  ${f}: Secret;`).join("\n");
  }

  const vtexAccount = ctx.vtexAccount || ctx.siteName;

  return `export type Platform =
  | "vtex"
  | "vnda"
  | "shopify"
  | "wake"
  | "linx"
  | "nuvemshop"
  | "custom";

export const _platform: Platform = "${ctx.platform}";
${secretImport}
export type AppContext = {
  device: "mobile" | "desktop" | "tablet";
  platform: Platform;${secretTypes ? `\n${secretTypes}` : ""}${ctx.platform === "vtex" ? `\n  account: string;` : ""}
};
`;
}

function extractSecretFields(ctx: MigrationContext): string[] {
  const siteAppPaths = [
    path.join(ctx.sourceDir, "apps", "site.ts"),
    path.join(ctx.sourceDir, "src", "apps", "site.ts"),
  ];

  for (const p of siteAppPaths) {
    if (!fs.existsSync(p)) continue;
    const content = fs.readFileSync(p, "utf-8");
    const secretRe = /(\w+):\s*Secret\b/g;
    const fields: string[] = [];
    let match;
    while ((match = secretRe.exec(content)) !== null) {
      fields.push(match[1]);
    }
    return fields;
  }
  return [];
}

function generateSecrets(ctx: MigrationContext): string {
  const fields = extractSecretFields(ctx);

  if (fields.length === 0) {
    return `export interface Secret {
  get(): string;
}

function envSecret(envKey: string): Secret {
  return {
    get: () => (process.env[envKey] as string) ?? "",
  };
}

export const secrets = {} as const;
`;
  }

  const envKeyMap: Record<string, string> = {
    GatewayApiKey: "GATEWAY_API_KEY",
    topsortkey: "TOPSORT_KEY",
    yourviewsToken: "YOURVIEWS_TOKEN",
    pickuppointsAppKey: "PICKUPPOINTS_APP_KEY",
    pickuppointsAppToken: "PICKUPPOINTS_APP_TOKEN",
    SAPUser: "SAP_USER",
    SAPPassword: "SAP_PASSWORD",
  };

  const entries = fields.map((f) => {
    const envKey = envKeyMap[f] || f.replace(/([A-Z])/g, "_$1").toUpperCase();
    return `  ${f}: envSecret("${envKey}"),`;
  });

  return `export interface Secret {
  get(): string;
}

function envSecret(envKey: string): Secret {
  return {
    get: () => (process.env[envKey] as string) ?? "",
  };
}

/**
 * All site-level secrets, sourced from Cloudflare Worker env bindings
 * (process.env is polyfilled by nodejs_compat).
 *
 * Local dev: .dev.vars
 * Production: \`wrangler secret put <KEY>\`
 */
export const secrets = {
${entries.join("\n")}
} as const;
`;
}

function hasLocationMatcher(ctx: MigrationContext): boolean {
  const dirs = [
    path.join(ctx.sourceDir, "matchers"),
    path.join(ctx.sourceDir, "src", "matchers"),
  ];
  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      if (files.some((f) => f.includes("location"))) return true;
    }
  }
  // Also check .deco/blocks for location matcher references
  const blocksDir = path.join(ctx.sourceDir, ".deco", "blocks");
  if (fs.existsSync(blocksDir)) {
    for (const file of fs.readdirSync(blocksDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = fs.readFileSync(path.join(blocksDir, file), "utf-8");
        if (content.includes("website/matchers/location")) return true;
      } catch { /* skip */ }
    }
  }
  return false;
}

function generateLocationMatcher(): string {
  return `/**
 * Server-side location matcher for website/matchers/location.ts
 *
 * Reads CF geolocation data injected as internal cookies by worker-entry.ts
 * (__cf_geo_region, __cf_geo_country, __cf_geo_city) to evaluate location
 * rules server-side.
 */

import { registerMatcher } from "@decocms/start/cms";
import type { MatcherContext } from "@decocms/start/cms";

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  Brasil: "BR",
  Brazil: "BR",
  Argentina: "AR",
  Chile: "CL",
  Colombia: "CO",
  Uruguay: "UY",
  Paraguay: "PY",
  Peru: "PE",
  "United States": "US",
  Portugal: "PT",
};

interface LocationRule {
  regionCode?: string;
  country?: string;
  city?: string;
}

function matchesRule(loc: LocationRule, region: string, country: string, city: string): boolean {
  if (loc.country) {
    const code = COUNTRY_NAME_TO_CODE[loc.country] ?? loc.country;
    if (code !== country) return false;
  }
  if (loc.regionCode && loc.regionCode !== region) return false;
  if (loc.city && loc.city.toLowerCase() !== city.toLowerCase()) return false;
  return true;
}

export function registerLocationMatcher(): void {
  registerMatcher(
    "website/matchers/location.ts",
    (rule: Record<string, unknown>, ctx: MatcherContext): boolean => {
      const includeLocations = (rule.includeLocations as LocationRule[] | undefined) ?? [];
      const excludeLocations = (rule.excludeLocations as LocationRule[] | undefined) ?? [];

      const cookies = ctx.cookies ?? {};
      const region = cookies.__cf_geo_region ? decodeURIComponent(cookies.__cf_geo_region) : "";
      const country = cookies.__cf_geo_country ? decodeURIComponent(cookies.__cf_geo_country) : "";
      const city = cookies.__cf_geo_city ? decodeURIComponent(cookies.__cf_geo_city) : "";

      if (excludeLocations.some((loc) => matchesRule(loc, region, country, city))) {
        return false;
      }

      if (includeLocations.length === 0) return true;

      return includeLocations.some((loc) => matchesRule(loc, region, country, city));
    },
  );
}
`;
}
