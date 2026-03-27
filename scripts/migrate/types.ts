export type Platform =
  | "vtex"
  | "vnda"
  | "shopify"
  | "wake"
  | "linx"
  | "nuvemshop"
  | "custom";

export interface FileRecord {
  /** Relative path from source root */
  path: string;
  /** Absolute path */
  absPath: string;
  /** File category */
  category:
    | "section"
    | "island"
    | "component"
    | "sdk"
    | "loader"
    | "action"
    | "route"
    | "app"
    | "static"
    | "config"
    | "generated"
    | "other";
  /** Whether this file is a re-export wrapper */
  isReExport?: boolean;
  /** The target of the re-export if applicable */
  reExportTarget?: string;
  /** Detected patterns in this file */
  patterns: DetectedPattern[];
  /** Action to take */
  action: "transform" | "delete" | "move" | "scaffold" | "manual-review";
  /** Target path in new structure (relative to project root) */
  targetPath?: string;
  /** Notes for the report */
  notes?: string;
}

export type DetectedPattern =
  | "preact-hooks"
  | "preact-signals"
  | "fresh-runtime"
  | "fresh-server"
  | "deco-hooks"
  | "deco-context"
  | "deco-web"
  | "deco-blocks"
  | "apps-imports"
  | "site-imports"
  | "class-attr"
  | "onInput-handler"
  | "deno-lint-ignore"
  | "npm-prefix"
  | "ts-extension-import"
  | "component-children"
  | "jsx-types"
  | "asset-function"
  | "head-component"
  | "define-app"
  | "invoke-proxy";

export interface MigrationContext {
  sourceDir: string;
  siteName: string;
  platform: Platform;
  gtmId: string | null;

  /** deno.json import map entries */
  importMap: Record<string, string>;

  /** npm dependencies discovered from inline npm: imports in source files */
  discoveredNpmDeps: Record<string, string>;

  /** All categorized source files */
  files: FileRecord[];

  /** Files created by scaffold phase */
  scaffoldedFiles: string[];
  /** Files transformed */
  transformedFiles: string[];
  /** Files deleted */
  deletedFiles: string[];
  /** Files moved */
  movedFiles: Array<{ from: string; to: string }>;
  /** Items requiring manual review */
  manualReviewItems: ReviewItem[];
  /** Framework findings */
  frameworkFindings: string[];

  dryRun: boolean;
  verbose: boolean;
}

export interface ReviewItem {
  file: string;
  reason: string;
  severity: "info" | "warning" | "error";
}

export interface TransformResult {
  content: string;
  changed: boolean;
  notes: string[];
}

export function createContext(
  sourceDir: string,
  opts: { dryRun?: boolean; verbose?: boolean } = {},
): MigrationContext {
  return {
    sourceDir,
    siteName: "",
    platform: "custom",
    gtmId: null,
    importMap: {},
    discoveredNpmDeps: {},
    files: [],
    scaffoldedFiles: [],
    transformedFiles: [],
    deletedFiles: [],
    movedFiles: [],
    manualReviewItems: [],
    frameworkFindings: [],
    dryRun: opts.dryRun ?? false,
    verbose: opts.verbose ?? false,
  };
}

export function log(ctx: MigrationContext, msg: string) {
  if (ctx.verbose) console.log(`  ${msg}`);
}

export function logPhase(phase: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Phase: ${phase}`);
  console.log(`${"=".repeat(60)}\n`);
}
