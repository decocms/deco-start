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

/** Metadata extracted from a section file during analysis */
export interface SectionMeta {
  /** Relative path from source root (e.g. "sections/Header/Header.tsx") */
  path: string;
  /** Has export const loader or export function loader */
  hasLoader: boolean;
  /** Loader is async */
  loaderIsAsync: boolean;
  /** Has export function LoadingFallback */
  hasLoadingFallback: boolean;
  /** Is a header section (by filename) */
  isHeader: boolean;
  /** Is a footer section (by filename) */
  isFooter: boolean;
  /** Is a theme section (by filename) */
  isTheme: boolean;
  /** Is a shelf/carousel/listing section (by filename or content) */
  isListing: boolean;
  /** Has JSDoc @title */
  hasTitle: boolean;
  /** Has JSDoc @description */
  hasDescription: boolean;
  /** Loader uses ctx.device or similar device detection */
  loaderUsesDevice: boolean;
  /** Loader uses request URL / search params */
  loaderUsesUrl: boolean;
  /** Loader is an Account section (sections/Account/*) */
  isAccountSection: boolean;
  /** Loader only sets ctx.response.status (no real prop enrichment) */
  isStatusOnly: boolean;
  /** Loader sets isMobile (boolean) rather than device (string) */
  usesMobileBoolean: boolean;
}

/** Classification of an island file */
export interface IslandClassification {
  /** Relative path from source root */
  path: string;
  /** "wrapper" = thin re-export/bridge, "standalone" = has real logic */
  type: "wrapper" | "standalone";
  /** If wrapper, the target component path */
  wrapsComponent?: string;
  /** If standalone, the suggested target path under src/ */
  suggestedTarget: string;
  /** Line count (used as heuristic) */
  lineCount: number;
}

/** Information about a loader file */
export interface LoaderInfo {
  /** Relative path from source root */
  path: string;
  /** Has export const cache (SWR) */
  hasCache: boolean;
  /** Has export const cacheKey */
  hasCacheKey: boolean;
  /** Maps to a known @decocms/apps equivalent */
  appsEquivalent: string | null;
  /** Is a custom loader that needs dynamic import in commerce-loaders */
  isCustom: boolean;
  /** Detected platform relevance (vtex, shopify, etc.) */
  platformRelevance: Platform | null;
}

export interface MigrationContext {
  sourceDir: string;
  siteName: string;
  platform: Platform;
  gtmId: string | null;

  /** deno.json import map entries */
  importMap: Record<string, string>;

  /** npm dependencies discovered from inline npm: imports in source files */
  discoveredNpmDeps: Record<string, string>;

  /** Theme colors extracted from .deco/blocks CMS config */
  themeColors: Record<string, string>;
  /** Font family from CMS config */
  fontFamily: string | null;

  /** All categorized source files */
  files: FileRecord[];

  /** Section metadata extracted during analysis */
  sectionMetas: SectionMeta[];
  /** Island classifications */
  islandClassifications: IslandClassification[];
  /** Loader inventory */
  loaderInventory: LoaderInfo[];

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
    themeColors: {},
    fontFamily: null,
    files: [],
    sectionMetas: [],
    islandClassifications: [],
    loaderInventory: [],
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
