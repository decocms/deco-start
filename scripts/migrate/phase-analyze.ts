import * as fs from "node:fs";
import * as path from "node:path";
import type {
  DetectedPattern,
  FileRecord,
  MigrationContext,
  Platform,
} from "./types.ts";
import { log, logPhase } from "./types.ts";

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
  "_fresh",
  "static",
  ".context",
  "scripts",
  "src",
  "public",
  ".tanstack",
]);

const SKIP_FILES = new Set([
  "deno.lock",
  ".gitignore",
  "README.md",
  "LICENSE",
  "browserslist",
  "bw_stats.json",
  "package.json",
  "package-lock.json",
]);

/** Files that are generated and should be deleted */
const GENERATED_FILES = new Set([
  "fresh.gen.ts",
  "manifest.gen.ts",
  "fresh.config.ts",
]);

/** SDK files that have framework equivalents */
const SDK_DELETE = new Set([
  "sdk/clx.ts",
  "sdk/useId.ts",
  "sdk/useOffer.ts",
  "sdk/useVariantPossiblities.ts",
  "sdk/usePlatform.tsx",
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
  if (relPath.startsWith("static/")) return "static";
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

  // SDK files to delete
  if (SDK_DELETE.has(relPath)) {
    return {
      action: "delete",
      notes: "Use framework equivalent from @decocms/start or @decocms/apps",
    };
  }

  // cart/ directory → delete
  if (relPath.startsWith("sdk/cart/")) {
    return { action: "delete", notes: "Use @decocms/apps cart hooks" };
  }

  // Islands — if the section is a re-export of this island, island becomes section
  if (category === "island") {
    const sectionPath = relPath.replace("islands/", "sections/");
    return {
      action: "transform",
      targetPath: `src/${sectionPath}`,
      notes: "Island merged into section",
    };
  }

  // Sections that are re-exports of islands → delete (island takes their place)
  if (category === "section" && isReExp) {
    return { action: "delete", notes: "Re-export wrapper, island merged" };
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
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
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
  const sitePath = path.join(sourceDir, "apps", "site.ts");
  if (!fs.existsSync(sitePath)) return "custom";

  const content = fs.readFileSync(sitePath, "utf-8");

  // Check for platform in Props or default
  for (const p of ["vtex", "shopify", "wake", "vnda", "linx", "nuvemshop"] as const) {
    if (content.includes(`"${p}"`) && content.includes("_platform")) {
      // This is just detecting what's available, default is usually "custom"
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

  console.log(`  Site: ${ctx.siteName}`);
  console.log(`  Platform: ${ctx.platform}`);
  console.log(`  GTM ID: ${ctx.gtmId || "none"}`);

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
}
