import * as fs from "node:fs";
import * as path from "node:path";
import type {
  DetectedPattern,
  FileRecord,
  MigrationContext,
  Platform,
} from "./types.ts";
import { log, logPhase } from "./types.ts";
import { extractSectionMetadata } from "./analyzers/section-metadata.ts";
import { classifyIslands } from "./analyzers/island-classifier.ts";
import { inventoryLoaders } from "./analyzers/loader-inventory.ts";

const PATTERN_DETECTORS: Array<[DetectedPattern, RegExp]> = [
  ["preact-hooks", /from\s+["']preact\/hooks["']/],
  ["preact-signals", /from\s+["']@preact\/signals/],
  ["fresh-runtime", /from\s+["']\$fresh\/runtime/],
  ["fresh-server", /from\s+["']\$fresh\/server/],
  ["deco-hooks", /from\s+["']@deco\/deco\/hooks["']/],
  ["deco-context", /Context\.active\(\)/],
  ["deco-web", /from\s+["']@deco\/deco\/web["']/],
  ["deco-blocks", /from\s+["']@deco\/deco\/blocks["']/],
  ["apps-imports", /from\s+["']apps\//],
  ["site-imports", /from\s+["']site\//],
  ["class-attr", /<[a-zA-Z][^>]*\sclass\s*=/],
  ["onInput-handler", /onInput\s*=/],
  ["deno-lint-ignore", /deno-lint-ignore/],
  ["npm-prefix", /from\s+["']npm:/],
  ["component-children", /ComponentChildren/],
  ["jsx-types", /JSX\.(?:SVG|HTML|Generic)/],
  ["asset-function", /\basset\(/],
  ["head-component", /<Head[\s>]/],
  ["define-app", /defineApp\(/],
  ["invoke-proxy", /proxy<Manifest/],
];

/** Files/dirs that should be completely skipped during scanning */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".github",
  ".deco",
  ".devcontainer",
  ".vscode",
  ".claude",
  ".cursor",
  "_fresh",
  "static",
  ".context",
  "scripts",
  "src",
  "public",
  ".tanstack",
  "tests",
  "bin",
  "fonts",
  ".pilot",
]);

const SKIP_FILES = new Set([
  "deno.lock",
  ".gitignore",
  "README.md",
  "AGENTS.md",
  "LICENSE",
  "browserslist",
  "bw_stats.json",
  "biome.json",
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "account.json",
]);

/** Files that are generated and should be deleted */
const GENERATED_FILES = new Set([
  "fresh.gen.ts",
  "manifest.gen.ts",
  "fresh.config.ts",
]);

/** SDK files that have framework equivalents or are scaffolded fresh */
const SDK_DELETE = new Set([
  "sdk/clx.ts",
  "sdk/useId.ts",
  "sdk/useOffer.ts",
  "sdk/useVariantPossiblities.ts",
  "sdk/usePlatform.tsx",
  "sdk/signal.ts",
  "sdk/format.ts",
]);

/** Component files that are scaffolded fresh (old versions must not overwrite) */
const COMPONENT_DELETE = new Set([
  "components/ui/Image.tsx",
  "components/ui/Picture.tsx",
  "components/ui/Video.tsx",
]);

/** Loaders that depend on deleted admin tooling */
const LOADER_DELETE = new Set([
  "loaders/availableIcons.ts",
  "loaders/icons.ts",
]);

/** Root config/infra files to delete */
const ROOT_DELETE = new Set([
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
  "islands.ts",
]);

/** Static files that are code/tooling, not assets — should be deleted */
const STATIC_DELETE = new Set([
  "static/adminIcons.ts",
  "static/generate-icons.ts",
  "static/tailwind.css",
]);

/**
 * Scan file content for inline npm: imports and return { name: version } pairs.
 * Matches patterns like: from "npm:fuse.js@7.0.0"
 */
function extractInlineNpmDeps(content: string): Record<string, string> {
  const deps: Record<string, string> = {};
  const regex = /from\s+["']npm:(@?[^@"']+)(?:@([^"']+))?["']/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const name = match[1];
    const version = match[2] || "*";
    // Skip framework deps
    if (name.startsWith("preact") || name.startsWith("@preact/")) continue;
    deps[name] = `^${version}`;
  }
  return deps;
}

function detectPatterns(content: string): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];
  for (const [name, regex] of PATTERN_DETECTORS) {
    if (regex.test(content)) {
      patterns.push(name);
    }
  }
  return patterns;
}

function isReExport(content: string): { is: boolean; target?: string } {
  const match = content.match(
    /^export\s+\{\s*default\s*\}\s+from\s+["']([^"']+)["']/m,
  );
  if (match) return { is: true, target: match[1] };
  return { is: false };
}

function categorizeFile(
  relPath: string,
): FileRecord["category"] {
  if (relPath.startsWith("sections/")) return "section";
  if (relPath.startsWith("islands/")) return "island";
  if (relPath.startsWith("components/")) return "component";
  if (relPath.startsWith("sdk/")) return "sdk";
  if (relPath.startsWith("loaders/")) return "loader";
  if (relPath.startsWith("actions/")) return "action";
  if (relPath.startsWith("routes/")) return "route";
  if (relPath.startsWith("apps/")) return "app";
  if (relPath.startsWith("static/") || relPath.startsWith("static-")) return "static";
  if (GENERATED_FILES.has(relPath)) return "generated";
  if (
    relPath === "deno.json" || relPath === "tsconfig.json" ||
    relPath === "tailwind.config.ts"
  ) {
    return "config";
  }
  return "other";
}

function decideAction(
  record: FileRecord,
): { action: FileRecord["action"]; targetPath?: string; notes?: string } {
  const { path: relPath, category, isReExport: isReExp } = record;

  // Generated files → delete
  if (category === "generated") {
    return { action: "delete" };
  }

  // Root config/infra → delete (will be scaffolded)
  if (ROOT_DELETE.has(relPath)) {
    return { action: "delete", notes: "Replaced by scaffolded config" };
  }

  // Routes → delete (will be scaffolded)
  if (category === "route") {
    return { action: "delete", notes: "Routes are scaffolded fresh" };
  }

  // Apps deco/ dir → delete
  if (relPath.startsWith("apps/deco/")) {
    return { action: "delete", notes: "Deco apps not needed in TanStack" };
  }

  // apps/site.ts → delete (will be scaffolded)
  if (relPath === "apps/site.ts") {
    return { action: "delete", notes: "Rewritten from scratch" };
  }

  // Loaders that depend on deleted admin tooling
  if (LOADER_DELETE.has(relPath)) {
    return {
      action: "delete",
      notes: "Admin icon loader — depends on deleted static/adminIcons.ts",
    };
  }

  // SDK files to delete (replaced by scaffolded or framework equivalents)
  if (SDK_DELETE.has(relPath)) {
    return {
      action: "delete",
      notes: "Use framework equivalent from @decocms/start or @decocms/apps",
    };
  }

  // Component files replaced by scaffolded versions
  if (COMPONENT_DELETE.has(relPath)) {
    return {
      action: "delete",
      notes: "Scaffolded fresh from @decocms/apps re-exports",
    };
  }

  // cart/ directory → delete
  if (relPath.startsWith("sdk/cart/")) {
    return { action: "delete", notes: "Use @decocms/apps cart hooks" };
  }

  // Islands — classify and route to appropriate target
  if (category === "island") {
    const classification = (record as any).__islandClassification;
    if (classification?.type === "wrapper") {
      return { action: "delete", notes: "Island wrapper — imports repointed to component" };
    }
    // Standalone islands go to components/, not sections/
    const componentPath = relPath.replace("islands/", "components/");
    return {
      action: "transform",
      targetPath: `src/${componentPath}`,
      notes: "Standalone island moved to components",
    };
  }

  // Sections that re-export from islands/ → delete (island takes their place)
  // But sections that re-export from components/ or other dirs should be KEPT
  if (category === "section" && isReExp) {
    const target = record.reExportTarget || "";
    const isIslandReExport = target.includes("islands/") ||
      target.includes("islands\\");
    if (isIslandReExport) {
      return { action: "delete", notes: "Re-export wrapper for island, island merged" };
    }
    // Section re-exports from components/ — keep and transform
  }

  // Session component → delete (analytics moves to __root.tsx)
  if (
    relPath === "components/Session.tsx" || relPath === "sections/Session.tsx"
  ) {
    return {
      action: "delete",
      notes: "Analytics SDK moved to __root.tsx scaffold",
    };
  }

  // Static code/tooling files → delete
  if (STATIC_DELETE.has(relPath)) {
    return { action: "delete", notes: "Code/tooling file, not an asset" };
  }

  // Static files → move
  if (category === "static") {
    const publicPath = relPath.replace("static/", "public/");
    return { action: "move", targetPath: publicPath };
  }

  // Non-code root files that shouldn't go into src/
  const ext = path.extname(relPath);
  const nonCodeExts = new Set([".md", ".csv", ".json", ".sh", ".lock", ".yml", ".yaml", ".xml", ".html", ".txt", ".log"]);
  if (!relPath.includes("/") && nonCodeExts.has(ext)) {
    return { action: "delete", notes: "Root-level non-code file" };
  }

  // Root-level loose TS/TSX files that are tooling, not app code
  const rootToolingFiles = new Set(["islands.ts", "order-status.ts", "sync.sh"]);
  if (!relPath.includes("/") && rootToolingFiles.has(relPath)) {
    return { action: "delete", notes: "Root-level tooling file" };
  }

  // Everything else → transform into src/
  return { action: "transform", targetPath: `src/${relPath}` };
}

function scanDir(
  dir: string,
  baseDir: string,
  files: FileRecord[],
) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".") || entry.name.startsWith("static-")) continue;
      scanDir(fullPath, baseDir, files);
      continue;
    }

    // Skip dotfiles and known non-code files
    if (SKIP_FILES.has(entry.name) || entry.name.startsWith(".")) continue;

    // Only process .ts, .tsx, .css, .json files for transforms
    const ext = path.extname(entry.name);
    const isCode = [".ts", ".tsx", ".css", ".json"].includes(ext);

    let content = "";
    let patterns: DetectedPattern[] = [];
    let reExport = { is: false, target: undefined as string | undefined };

    if (isCode) {
      content = fs.readFileSync(fullPath, "utf-8");
      patterns = detectPatterns(content);
      reExport = isReExport(content);
    }

    const record: FileRecord = {
      path: relPath,
      absPath: fullPath,
      category: categorizeFile(relPath),
      isReExport: reExport.is,
      reExportTarget: reExport.target,
      patterns,
      action: "transform", // placeholder
    };

    const decision = decideAction(record);
    record.action = decision.action;
    record.targetPath = decision.targetPath;
    record.notes = decision.notes;

    files.push(record);
  }
}

function extractGtmId(sourceDir: string): string | null {
  const appPath = path.join(sourceDir, "routes", "_app.tsx");
  if (!fs.existsSync(appPath)) return null;

  const content = fs.readFileSync(appPath, "utf-8");
  const match = content.match(/GTM-[A-Z0-9]+/);
  return match ? match[0] : null;
}

function extractPlatform(sourceDir: string): Platform {
  const platforms: Platform[] = ["vtex", "shopify", "wake", "vnda", "linx", "nuvemshop"];

  // Strategy 1: Check deno.json imports for platform-specific app imports
  const denoPath = path.join(sourceDir, "deno.json");
  if (fs.existsSync(denoPath)) {
    try {
      const deno = JSON.parse(fs.readFileSync(denoPath, "utf-8"));
      const imports = deno.imports || {};
      for (const p of platforms) {
        // e.g. "apps/vtex/" or direct app import containing the platform name
        const hasAppImport = Object.keys(imports).some(
          (k) => k === `apps/${p}/` || k.includes(`/${p}/mod.ts`) || k.includes(`deco-apps`) && imports[k].includes(`/${p}/`),
        );
        const hasAppValue = Object.values(imports).some(
          (v) => typeof v === "string" && (v as string).includes(`/${p}/`),
        );
        if (hasAppImport || hasAppValue) return p;
      }
      // Check if the import map value for "apps/" contains a platform hint
      const appsUrl = imports["apps/"];
      if (typeof appsUrl === "string") {
        for (const p of platforms) {
          // The apps/ URL itself doesn't indicate platform, but let's check apps/vtex.ts
          const vtexAppPath = path.join(sourceDir, "apps", `${p}.ts`);
          if (fs.existsSync(vtexAppPath)) return p;
        }
      }
    } catch {}
  }

  // Strategy 2: Check for apps/{platform}.ts file existence
  for (const p of platforms) {
    if (fs.existsSync(path.join(sourceDir, "apps", `${p}.ts`))) return p;
  }

  // Strategy 3: Check apps/site.ts for platform type and default value
  const sitePath = path.join(sourceDir, "apps", "site.ts");
  if (fs.existsSync(sitePath)) {
    const content = fs.readFileSync(sitePath, "utf-8");
    // Look for platform default in state or props: state.platform || "vtex"
    const defaultMatch = content.match(/(?:state\.platform|props\.platform)\s*\|\|\s*["'](\w+)["']/);
    if (defaultMatch) {
      const p = defaultMatch[1] as Platform;
      if (platforms.includes(p)) return p;
    }
    // Look for platform in the Props type
    for (const p of platforms) {
      if (content.includes(`"${p}"`) && (content.includes("Platform") || content.includes("platform"))) {
        return p;
      }
    }
  }

  // Strategy 4: Check .deco/blocks for platform-specific block files
  const blocksDir = path.join(sourceDir, ".deco", "blocks");
  if (fs.existsSync(blocksDir)) {
    const blockFiles = fs.readdirSync(blocksDir);
    for (const p of platforms) {
      if (blockFiles.some((f) => f.includes(`deco-${p}`) || f === `${p}.json`)) return p;
    }
  }

  return "custom";
}

function extractSiteName(sourceDir: string): string {
  // Try to extract from .deco or directory name
  const dirName = path.basename(path.resolve(sourceDir));

  // Try deno.json
  const denoPath = path.join(sourceDir, "deno.json");
  if (fs.existsSync(denoPath)) {
    const deno = JSON.parse(fs.readFileSync(denoPath, "utf-8"));
    if (deno.name) return deno.name;
  }

  return dirName;
}

function extractThemeFromCms(sourceDir: string): { colors: Record<string, string>; fontFamily: string | null } {
  const colors: Record<string, string> = {};
  let fontFamily: string | null = null;

  // Look for Theme config in .deco/blocks/
  const blocksDir = path.join(sourceDir, ".deco", "blocks");
  if (!fs.existsSync(blocksDir)) return { colors, fontFamily };

  const files = fs.readdirSync(blocksDir);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = fs.readFileSync(path.join(blocksDir, file), "utf-8");
      if (!content.includes("mainColors") && !content.includes("Theme")) continue;

      const data = JSON.parse(content);
      // Direct Theme block (e.g. Deco.json with __resolveType: "site/sections/Theme/Theme.tsx")
      if (data.mainColors) {
        Object.assign(colors, data.mainColors);
        if (data.complementaryColors) {
          Object.assign(colors, data.complementaryColors);
        }
      }
      // Font
      if (data.font?.fonts?.[0]?.family) {
        fontFamily = data.font.fonts[0].family;
      }
      // Check sections array (page blocks may contain Theme)
      if (data.sections) {
        for (const section of data.sections) {
          if (section.__resolveType?.includes("Theme") && section.mainColors) {
            Object.assign(colors, section.mainColors);
            if (section.complementaryColors) {
              Object.assign(colors, section.complementaryColors);
            }
            if (section.font?.fonts?.[0]?.family) {
              fontFamily = section.font.fonts[0].family;
            }
          }
        }
      }
    } catch {}
  }

  return { colors, fontFamily };
}

export function analyze(ctx: MigrationContext): void {
  logPhase("Analyze");

  // Parse deno.json for import map
  const denoJsonPath = path.join(ctx.sourceDir, "deno.json");
  if (fs.existsSync(denoJsonPath)) {
    const denoJson = JSON.parse(fs.readFileSync(denoJsonPath, "utf-8"));
    ctx.importMap = denoJson.imports || {};
    log(
      ctx,
      `Found ${Object.keys(ctx.importMap).length} import map entries`,
    );
  }

  // Extract metadata
  ctx.siteName = extractSiteName(ctx.sourceDir);
  ctx.platform = extractPlatform(ctx.sourceDir);
  ctx.gtmId = extractGtmId(ctx.sourceDir);

  // Extract theme colors and font from CMS
  const theme = extractThemeFromCms(ctx.sourceDir);
  ctx.themeColors = theme.colors;
  ctx.fontFamily = theme.fontFamily;

  console.log(`  Site: ${ctx.siteName}`);
  console.log(`  Platform: ${ctx.platform}`);
  console.log(`  GTM ID: ${ctx.gtmId || "none"}`);
  if (Object.keys(ctx.themeColors).length > 0) {
    console.log(`  Theme: ${Object.keys(ctx.themeColors).length} colors from CMS`);
  }
  if (ctx.fontFamily) {
    console.log(`  Font: ${ctx.fontFamily}`);
  }

  // Scan all files
  scanDir(ctx.sourceDir, ctx.sourceDir, ctx.files);

  // Summary
  const byAction = { transform: 0, delete: 0, move: 0, scaffold: 0, "manual-review": 0 };
  const byCategory: Record<string, number> = {};

  for (const f of ctx.files) {
    byAction[f.action]++;
    byCategory[f.category] = (byCategory[f.category] || 0) + 1;
  }

  // Scan all source files for inline npm: imports
  for (const f of ctx.files) {
    if (f.action === "delete") continue;
    const ext = path.extname(f.path);
    if (![".ts", ".tsx"].includes(ext)) continue;
    try {
      const content = fs.readFileSync(f.absPath, "utf-8");
      const deps = extractInlineNpmDeps(content);
      Object.assign(ctx.discoveredNpmDeps, deps);
    } catch {}
  }
  if (Object.keys(ctx.discoveredNpmDeps).length > 0) {
    log(ctx, `Discovered npm deps from source: ${JSON.stringify(ctx.discoveredNpmDeps)}`);
  }

  console.log(`\n  Files found: ${ctx.files.length}`);
  console.log(`  By category: ${JSON.stringify(byCategory)}`);
  console.log(`  By action: ${JSON.stringify(byAction)}`);

  // Run analyzers
  extractSectionMetadata(ctx);
  classifyIslands(ctx);
  inventoryLoaders(ctx);

  // Apply island classifications to file records
  const classMap = new Map(ctx.islandClassifications.map((c) => [c.path, c]));
  for (const f of ctx.files) {
    if (f.category !== "island") continue;
    const classification = classMap.get(f.path);
    if (!classification) continue;

    if (classification.type === "wrapper") {
      f.action = "delete";
      f.notes = "Island wrapper — imports repointed to component";
    } else {
      f.action = "transform";
      f.targetPath = classification.suggestedTarget;
      f.notes = "Standalone island moved to components";
    }
  }
}
