import * as fs from "node:fs";
import * as path from "node:path";
import type { MigrationContext } from "./types.ts";
import { log, logPhase } from "./types.ts";

/** Directories to remove entirely after migration */
const DIRS_TO_DELETE = [
  "islands",
  "routes",
  "apps/deco",
  "sdk/cart",
];

/** Individual root files to delete */
const ROOT_FILES_TO_DELETE = [
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
];

/** SDK files that have framework equivalents */
const SDK_FILES_TO_DELETE = [
  "sdk/clx.ts",
  "sdk/useId.ts",
  "sdk/usePlatform.tsx",
];

/** Section/component wrappers that are no longer needed */
const WRAPPER_FILES_TO_DELETE = [
  "components/Session.tsx",
  "sections/Session.tsx",
];

/** Loaders that depend on deleted admin tooling or are replaced by commerce-loaders wrappers */
const LOADER_FILES_TO_DELETE = [
  "loaders/availableIcons.ts",
  "loaders/icons.ts",
  "loaders/getUserGeolocation.ts",
  "loaders/smartShelfForYou.ts",
  // NOTE: intelligenseSearch.ts is intentionally KEPT — it's the autocomplete
  // loader referenced by Searchbar, useSuggestions, and CMS blocks.
];

function deleteFileIfExists(ctx: MigrationContext, relPath: string) {
  const fullPath = path.join(ctx.sourceDir, relPath);
  if (!fs.existsSync(fullPath)) return;

  if (ctx.dryRun) {
    log(ctx, `[DRY] Would delete: ${relPath}`);
    ctx.deletedFiles.push(relPath);
    return;
  }

  fs.unlinkSync(fullPath);
  ctx.deletedFiles.push(relPath);
  log(ctx, `Deleted: ${relPath}`);
}

function deleteDirIfExists(ctx: MigrationContext, relPath: string) {
  const fullPath = path.join(ctx.sourceDir, relPath);
  if (!fs.existsSync(fullPath)) return;

  if (ctx.dryRun) {
    log(ctx, `[DRY] Would delete dir: ${relPath}/`);
    ctx.deletedFiles.push(`${relPath}/`);
    return;
  }

  fs.rmSync(fullPath, { recursive: true, force: true });
  ctx.deletedFiles.push(`${relPath}/`);
  log(ctx, `Deleted dir: ${relPath}/`);
}

function moveStaticFiles(ctx: MigrationContext) {
  const staticDir = path.join(ctx.sourceDir, "static");
  if (!fs.existsSync(staticDir)) return;

  const publicDir = path.join(ctx.sourceDir, "public");

  function moveRecursive(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(dir, entry.name);
      const relFromStatic = path.relative(staticDir, srcPath);
      const destPath = path.join(publicDir, relFromStatic);

      // Skip generated files
      if (
        entry.name === "tailwind.css" || entry.name === "adminIcons.ts" ||
        entry.name === "generate-icons.ts"
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        moveRecursive(srcPath);
        continue;
      }

      if (ctx.dryRun) {
        log(ctx, `[DRY] Would move: static/${relFromStatic} → public/${relFromStatic}`);
        ctx.movedFiles.push({
          from: `static/${relFromStatic}`,
          to: `public/${relFromStatic}`,
        });
        continue;
      }

      // Ensure dest dir exists
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      ctx.movedFiles.push({
        from: `static/${relFromStatic}`,
        to: `public/${relFromStatic}`,
      });
      log(ctx, `Moved: static/${relFromStatic} → public/${relFromStatic}`);
    }
  }

  moveRecursive(staticDir);

  // Now delete static/ dir
  if (!ctx.dryRun) {
    fs.rmSync(staticDir, { recursive: true, force: true });
    log(ctx, "Deleted dir: static/");
  }
}

/**
 * Handle multi-brand static directories (static-cv/, static-lb/, etc.).
 * The "primary" brand's assets go to public/.
 */
function moveMultiBrandStaticFiles(ctx: MigrationContext) {
  const entries = fs.readdirSync(ctx.sourceDir, { withFileTypes: true });
  const staticDirs = entries.filter(
    (e) => e.isDirectory() && e.name.startsWith("static-"),
  );

  if (staticDirs.length === 0) return;

  // Use the first one as primary (or match by site name)
  const primaryDir = staticDirs[0];
  const primaryPath = path.join(ctx.sourceDir, primaryDir.name);
  const publicDir = path.join(ctx.sourceDir, "public");

  log(ctx, `Found multi-brand static dirs: ${staticDirs.map((d) => d.name).join(", ")}`);
  log(ctx, `Using ${primaryDir.name} as primary → public/`);

  function copyRecursive(dir: string, base: string) {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const srcPath = path.join(dir, item.name);
      const relFromBase = path.relative(base, srcPath);
      const destPath = path.join(publicDir, relFromBase);

      if (item.name === "tailwind.css" || item.name === "adminIcons.ts") continue;
      // Skip partytown (not needed in Workers)
      if (item.name === "~partytown" || item.name === "partytown") continue;

      if (item.isDirectory()) {
        copyRecursive(srcPath, base);
        continue;
      }

      if (ctx.dryRun) {
        log(ctx, `[DRY] Would copy: ${primaryDir.name}/${relFromBase} → public/${relFromBase}`);
        ctx.movedFiles.push({ from: `${primaryDir.name}/${relFromBase}`, to: `public/${relFromBase}` });
        continue;
      }

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      ctx.movedFiles.push({ from: `${primaryDir.name}/${relFromBase}`, to: `public/${relFromBase}` });
    }
  }

  copyRecursive(primaryPath, primaryPath);

  // Clean up all static-* dirs (both root and src/)
  if (!ctx.dryRun) {
    for (const d of staticDirs) {
      const rootDir = path.join(ctx.sourceDir, d.name);
      if (fs.existsSync(rootDir)) {
        fs.rmSync(rootDir, { recursive: true, force: true });
        log(ctx, `Deleted: ${d.name}/`);
      }
      const srcDir = path.join(ctx.sourceDir, "src", d.name);
      if (fs.existsSync(srcDir)) {
        fs.rmSync(srcDir, { recursive: true, force: true });
        log(ctx, `Deleted: src/${d.name}/`);
      }
    }
  }
}

function moveRootDirToSrc(ctx: MigrationContext, dir: string) {
  const oldDir = path.join(ctx.sourceDir, dir);
  const newDir = path.join(ctx.sourceDir, "src", dir);
  if (!fs.existsSync(oldDir)) return;

  if (ctx.dryRun) {
    log(ctx, `[DRY] Would move: ${dir}/ → src/${dir}/`);
    ctx.movedFiles.push({ from: `${dir}/`, to: `src/${dir}/` });
    return;
  }

  if (fs.existsSync(newDir)) {
    // Merge: copy files from old into new (don't overwrite existing)
    copyRecursiveNoOverwrite(oldDir, newDir);
  } else {
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.cpSync(oldDir, newDir, { recursive: true });
  }
  fs.rmSync(oldDir, { recursive: true, force: true });
  ctx.deletedFiles.push(`${dir}/`);
  log(ctx, `Moved: ${dir}/ → src/${dir}/`);
}

function copyRecursiveNoOverwrite(src: string, dest: string) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyRecursiveNoOverwrite(srcPath, destPath);
    } else if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function cleanupOldSourceDirs(ctx: MigrationContext) {
  // Dirs that the scaffold/transform phases already created under src/.
  // Delete root copies when both exist.
  const dirsToClean = [
    "sections",
    "components",
    "sdk",
    "loaders",
    "actions",
    "apps",
  ];

  for (const dir of dirsToClean) {
    const oldDir = path.join(ctx.sourceDir, dir);
    const newDir = path.join(ctx.sourceDir, "src", dir);
    if (fs.existsSync(oldDir) && fs.existsSync(newDir)) {
      if (ctx.dryRun) {
        log(ctx, `[DRY] Would delete old dir: ${dir}/ (moved to src/${dir}/)`);
        ctx.deletedFiles.push(`${dir}/`);
      } else {
        fs.rmSync(oldDir, { recursive: true, force: true });
        ctx.deletedFiles.push(`${dir}/`);
        log(ctx, `Deleted old dir: ${dir}/ (now at src/${dir}/)`);
      }
    }
  }

  // Dirs that need to be MOVED (not just deleted) because scaffold doesn't
  // create them under src/ but code references them via ~/utils, ~/types, etc.
  const dirsToMove = ["utils", "types", "hooks", "contexts"];
  for (const dir of dirsToMove) {
    moveRootDirToSrc(ctx, dir);
  }
}

/** Delete sections that were re-export wrappers (their islands are now sections) */
function cleanupReExportSections(ctx: MigrationContext) {
  const reExports = ctx.files.filter(
    (f) => f.category === "section" && f.isReExport && f.action === "delete",
  );
  for (const f of reExports) {
    // These were already not transformed, just make sure we note them
    log(ctx, `Skipped re-export wrapper: ${f.path}`);
  }
}

/** Remove non-code files and directories that shouldn't be under src/ */
function cleanupJunkFromSrc(ctx: MigrationContext) {
  const srcDir = path.join(ctx.sourceDir, "src");
  if (!fs.existsSync(srcDir)) return;

  // Remove dirs that don't belong in src/
  const junkDirs = ["bin", "fonts", "tests", ".pilot", ".deco"];
  for (const dir of junkDirs) {
    const dirPath = path.join(srcDir, dir);
    if (fs.existsSync(dirPath)) {
      if (ctx.dryRun) {
        log(ctx, `[DRY] Would delete junk dir: src/${dir}/`);
      } else {
        fs.rmSync(dirPath, { recursive: true, force: true });
        log(ctx, `Deleted junk from src/: ${dir}/`);
      }
    }
  }

  // Remove static-* dirs from src/
  if (fs.existsSync(srcDir)) {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("static-")) {
        const dirPath = path.join(srcDir, entry.name);
        if (ctx.dryRun) {
          log(ctx, `[DRY] Would delete: src/${entry.name}/`);
        } else {
          fs.rmSync(dirPath, { recursive: true, force: true });
          log(ctx, `Deleted from src/: ${entry.name}/`);
        }
      }
    }
  }

  // Remove non-code root files from src/
  const junkFiles = [
    "AGENTS.md", "biome.json", "blockedQs.ts", "islands.ts",
    "lint-changed.sh", "redirects-vtex.csv", "search-urls-cvlb.csv",
    "search.csv", "sync.sh", "yarn.lock",
  ];
  for (const file of junkFiles) {
    const filePath = path.join(srcDir, file);
    if (fs.existsSync(filePath)) {
      if (ctx.dryRun) {
        log(ctx, `[DRY] Would delete: src/${file}`);
      } else {
        fs.unlinkSync(filePath);
        log(ctx, `Deleted from src/: ${file}`);
      }
    }
  }
}

/**
 * Remove empty ({}) block stubs from .deco/blocks/.
 * Some source repos have both `pages-Foo%20bar.json` (empty) and
 * `pages-Foo%2520bar.json` (real data).  generate-blocks.ts deduplicates
 * by decoded key, and the empty stub can shadow the real file.
 */
function removeEmptyBlockStubs(ctx: MigrationContext) {
  const blocksDir = path.join(ctx.sourceDir, ".deco", "blocks");
  if (!fs.existsSync(blocksDir)) return;

  const files = fs.readdirSync(blocksDir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const fullPath = path.join(blocksDir, file);
    const stat = fs.statSync(fullPath);
    if (stat.size > 4) continue; // only target tiny files
    const content = fs.readFileSync(fullPath, "utf-8").trim();
    if (content === "{}" || content === "") {
      if (ctx.dryRun) {
        log(ctx, `[DRY] Would delete empty block stub: .deco/blocks/${file}`);
      } else {
        fs.unlinkSync(fullPath);
        log(ctx, `Deleted empty block stub: .deco/blocks/${file}`);
      }
    }
  }
}

function overrideDeviceContext(ctx: MigrationContext) {
  const target = path.join(ctx.sourceDir, "src", "contexts", "device.tsx");
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const content = `import { useSyncExternalStore } from "react";

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
  if (ctx.dryRun) {
    log(ctx, "[DRY] Would override: src/contexts/device.tsx");
  } else {
    fs.writeFileSync(target, content);
    log(ctx, "Overrode src/contexts/device.tsx with useSyncExternalStore implementation");
  }
}

function rewriteRetryUtil(ctx: MigrationContext) {
  const target = path.join(ctx.sourceDir, "src", "utils", "retry.ts");
  if (!fs.existsSync(target)) return;

  const content = `export const CONNECTION_CLOSED_MESSAGE = "connection closed before message completed";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simple retry utility — replaces cockatiel to avoid module-level AbortController
 * (cockatiel's abort.js creates new AbortController() at module scope, which is
 * forbidden in Cloudflare Workers global scope).
 *
 * Retries up to maxAttempts when the error matches the predicate.
 * Uses exponential backoff: delay = min(initialDelay * exponent^attempt, maxDelay).
 */
export function retryExceptionOr500() {
  return {
    execute: async <T>(fn: () => Promise<T>): Promise<T> => {
      const maxAttempts = 3;
      const initialDelay = 100;
      const maxDelay = 5000;
      const exponent = 2;

      let lastErr: unknown;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          return await fn();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!message.includes(CONNECTION_CLOSED_MESSAGE)) {
            throw err;
          }
          lastErr = err;
          try {
            console.error("retrying...", err);
          } catch (_) {}
          if (attempt < maxAttempts - 1) {
            const delay = Math.min(initialDelay * Math.pow(exponent, attempt), maxDelay);
            await sleep(delay);
          }
        }
      }
      throw lastErr;
    },
  };
}
`;
  if (ctx.dryRun) {
    log(ctx, "[DRY] Would rewrite: src/utils/retry.ts");
  } else {
    fs.writeFileSync(target, content);
    log(ctx, "Rewrote src/utils/retry.ts (replaced cockatiel with Workers-safe version)");
  }
}

/**
 * Add safety guards for common runtime patterns that crash in React strict mode
 * or in Cloudflare Workers but worked silently in the old Deno/Preact stack.
 *
 * These are useEffect-level errors that React error boundaries catch and
 * propagate, killing the entire section (e.g. the Header).
 */
function addRuntimeSafetyGuards(ctx: MigrationContext) {
  rewriteFilesRecursive(ctx, path.join(ctx.sourceDir, "src"), (content, relPath) => {
    let result = content;
    let changed = false;

    // 1. Guard: `event.params.X = Y` → `if (event.params) event.params.X = Y`
    const paramsAssignRe = /^(\s*)(event\.params\.(\w+)\s*=\s*.+;)$/gm;
    const paramsRepl = result.replace(paramsAssignRe, (_m, indent, assignment) => {
      return `${indent}if (event.params) ${assignment}`;
    });
    if (paramsRepl !== result) {
      result = paramsRepl;
      changed = true;
      log(ctx, `  Added event.params guard: src/${relPath}`);
    }

    // 2. Guard: `.find(...).params` → `.find(...)?.params`
    //    Uses paren-counting to handle nested parens in callbacks like
    //    `.find((item) => item?.name === "deco").params`
    result = addOptionalChainAfterFind(result, (msg) => {
      changed = true;
      log(ctx, `  ${msg}: src/${relPath}`);
    });

    // 3. Guard: undeclared variables used in if-conditions (ReferenceError).
    //    In the old Preact stack, some global signals/variables silently
    //    resolved to undefined. In React strict mode, bare references to
    //    undeclared variables throw ReferenceError which error boundaries catch.
    //    We detect variables referenced in the file that are never declared
    //    (const/let/var/param/import) and add typeof guards.
    result = guardUndeclaredVariables(result, (msg) => {
      changed = true;
      log(ctx, `  ${msg}: src/${relPath}`);
    });

    if (!changed) return null;
    return result;
  });
}

/**
 * Find `.find(...)` calls followed by `.params` (without `?.`) and insert
 * optional chaining. Handles nested parentheses correctly.
 */
function addOptionalChainAfterFind(src: string, onFix: (msg: string) => void): string {
  let result = src;
  let searchFrom = 0;

  while (true) {
    const findIdx = result.indexOf(".find(", searchFrom);
    if (findIdx === -1) break;

    // Walk forward from the opening paren, counting depth
    let depth = 1;
    let i = findIdx + 6; // past ".find("
    while (i < result.length && depth > 0) {
      if (result[i] === "(") depth++;
      if (result[i] === ")") depth--;
      i++;
    }
    // i is now right after the matching ")"
    // Check for `.params` without `?.`
    if (result.slice(i, i + 7) === ".params" && result.slice(i - 1, i + 8) !== ")?.params") {
      result = result.slice(0, i) + "?" + result.slice(i);
      onFix("Added optional chain after .find()");
      searchFrom = i + 8; // skip past the inserted "?.params"
    } else {
      searchFrom = i;
    }
  }

  return result;
}

/**
 * Detect variables used in `if (varName ...` or `if (varName && ...` that are
 * never declared with const/let/var/function/import/param in the file, and
 * wrap with `typeof varName !== "undefined"`.
 *
 * This prevents ReferenceError in React strict mode — the old Preact/Deno
 * stack had more lenient scoping or these variables were injected by the runtime.
 */
function guardUndeclaredVariables(src: string, onFix: (msg: string) => void): string {
  let result = src;

  // Find all `if (someVar &&` or `if (someVar)` patterns where someVar
  // is a bare identifier (not a property access, not a function call)
  const ifBareVarRe = /\bif\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:&&|\))/g;
  const candidates = new Set<string>();
  let match;

  while ((match = ifBareVarRe.exec(result)) !== null) {
    candidates.add(match[1]);
  }

  // Filter to only truly undeclared variables
  const reserved = new Set([
    "true", "false", "null", "undefined", "this", "window", "document",
    "globalThis", "console", "navigator", "location", "localStorage",
    "sessionStorage", "fetch", "JSON", "Array", "Object", "Math",
    "Date", "Error", "Promise", "Map", "Set", "RegExp", "Symbol",
    "parseInt", "parseFloat", "isNaN", "isFinite", "NaN", "Infinity",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "requestAnimationFrame", "cancelAnimationFrame", "event",
  ]);

  for (const varName of candidates) {
    if (reserved.has(varName)) continue;

    // Check if the variable is declared anywhere in the file
    const declPatterns = [
      new RegExp(`\\b(?:const|let|var|function)\\s+${varName}\\b`),
      new RegExp(`\\bimport\\b[^;]*\\b${varName}\\b`),
      // Function parameter: `function foo(varName)` or `(varName) =>`
      new RegExp(`\\(\\s*(?:[^)]*,\\s*)?${varName}\\s*(?:[:,][^)]*)?\\)\\s*(?:=>|\\{)`),
      // Destructuring declaration: `const { varName }` or `let { x: varName }`
      new RegExp(`(?:const|let|var)\\s+\\{[^}]*\\b${varName}\\b[^}]*\\}\\s*=`),
      // For-of/for-in: `for (const varName of/in ...)`
      new RegExp(`for\\s*\\(\\s*(?:const|let|var)\\s+${varName}\\b`),
    ];

    const isDeclared = declPatterns.some((p) => p.test(result));
    if (isDeclared) continue;

    // This variable is used in an if-condition but never declared — wrap with typeof
    const unsafePat = new RegExp(
      `\\bif\\s*\\(\\s*${varName}\\b`,
      "g",
    );
    const guardedResult = result.replace(
      unsafePat,
      `if (typeof ${varName} !== "undefined"`,
    );

    if (guardedResult !== result) {
      result = guardedResult;
      onFix(`Added typeof guard for undeclared variable "${varName}"`);
    }
  }

  return result;
}

/**
 * Migrate account.json → src/constants/account.ts and rewrite imports.
 *
 * Old stack: root-level `account.json` containing e.g. `"casaevideo"`
 * New stack: `src/constants/account.ts` exporting `accountName`
 *
 * Also rewrites every file that imports from `account.json` (via
 * `$store/account.json`, `site/account.json`, or `~/account.json`)
 * to use `import { accountName } from "~/constants/account"` instead.
 */
function migrateAccountJson(ctx: MigrationContext) {
  // 1. Read the site name from account.json (check root, then src/)
  let siteName: string | null = null;
  for (const candidate of ["account.json", "src/account.json"]) {
    const fullPath = path.join(ctx.sourceDir, candidate);
    if (fs.existsSync(fullPath)) {
      try {
        const raw = fs.readFileSync(fullPath, "utf-8").trim();
        siteName = JSON.parse(raw);
        if (typeof siteName !== "string") siteName = null;
      } catch { /* ignore parse errors */ }
      // Delete the old JSON file
      if (!ctx.dryRun) {
        fs.unlinkSync(fullPath);
      }
      log(ctx, `Deleted: ${candidate}`);
      break;
    }
  }

  if (!siteName) {
    // Fallback: try to infer from deco blocks or directory name
    const decofilePath = path.join(ctx.sourceDir, ".deco", "blocks", "vtex.json");
    if (fs.existsSync(decofilePath)) {
      try {
        const vtexBlock = JSON.parse(fs.readFileSync(decofilePath, "utf-8"));
        if (vtexBlock.account && typeof vtexBlock.account === "string") {
          siteName = vtexBlock.account.replace(/newio$/, "").replace(/io$/, "");
        }
      } catch { /* ignore */ }
    }
    if (!siteName) {
      siteName = path.basename(ctx.sourceDir).replace(/-migrated$/, "");
    }
    log(ctx, `Inferred site name: "${siteName}" (no account.json found)`);
  }

  // 2. Create src/constants/account.ts
  const constantsDir = path.join(ctx.sourceDir, "src", "constants");
  const accountTsPath = path.join(constantsDir, "account.ts");

  if (ctx.dryRun) {
    log(ctx, `[DRY] Would create: src/constants/account.ts with accountName="${siteName}"`);
  } else {
    fs.mkdirSync(constantsDir, { recursive: true });
    fs.writeFileSync(
      accountTsPath,
      `export const accountName = "${siteName}" as const;\nexport type AccountName = typeof accountName;\n`,
    );
    log(ctx, `Created: src/constants/account.ts (accountName="${siteName}")`);
  }

  // 3. Rewrite all files that import from account.json or ~/constants/account
  //    The transform phase may have already rewritten the specifier from
  //    `$store/account.json` → `~/constants/account`, but it only changes the
  //    specifier, not the binding style (default → named). We must fix both.
  const accountJsonPattern =
    /import\s+([\w{},\s*]+)\s+from\s+["'](?:\$store|site|~)\/account\.json["']\s*(?:(?:with|assert)\s*\{[^}]*\}\s*)?;?/g;
  const accountTsDefaultPattern =
    /import\s+(\w+)\s+from\s+["']~\/constants\/account["']\s*(?:(?:with|assert)\s*\{[^}]*\}\s*)?;?/g;

  rewriteFilesRecursive(ctx, path.join(ctx.sourceDir, "src"), (content, relPath) => {
    if (!content.includes("account.json") && !content.includes("constants/account")) return null;

    let changed = false;
    let result = content;

    // Capture old variable name before any replacements
    const defaultImportMatch = content.match(
      /import\s+(\w+)\s+from\s+["'](?:\$store|site|~)\/account\.json["']/,
    ) || content.match(
      /import\s+(\w+)\s+from\s+["']~\/constants\/account["']/,
    );
    const oldVarName = defaultImportMatch?.[1];

    // Fix account.json imports (pre-transform)
    result = result.replace(accountJsonPattern, (_match, importName) => {
      changed = true;
      const trimmed = importName.trim();
      if (trimmed.startsWith("{")) {
        return `import ${trimmed} from "~/constants/account";`;
      }
      return `import { accountName } from "~/constants/account";`;
    });

    // Fix default imports from ~/constants/account (post-transform)
    result = result.replace(accountTsDefaultPattern, (_match, varName) => {
      if (varName.startsWith("{")) return _match; // already named
      changed = true;
      return `import { accountName } from "~/constants/account";`;
    });

    if (!changed) return null;

    // Rename old variable references if the import used a different name
    if (oldVarName && oldVarName !== "accountName" && oldVarName !== "{") {
      result = result.replace(
        new RegExp(`\\b${oldVarName}\\b`, "g"),
        "accountName",
      );
    }

    log(ctx, `  Rewrote account import: src/${relPath}`);
    return result;
  });
}

function rewriteFilesRecursive(
  ctx: MigrationContext,
  dir: string,
  transformer: (content: string, relPath: string) => string | null,
) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".deco") continue;
      rewriteFilesRecursive(ctx, fullPath, transformer);
    } else if (/\.(tsx?|jsx?|mts|mjs)$/.test(entry.name)) {
      const content = fs.readFileSync(fullPath, "utf-8");
      const relPath = path.relative(path.join(ctx.sourceDir, "src"), fullPath);
      const newContent = transformer(content, relPath);
      if (newContent !== null && newContent !== content) {
        if (!ctx.dryRun) {
          fs.writeFileSync(fullPath, newContent);
        }
      }
    }
  }
}

/**
 * Auto-fix section barrel files that re-export `default` but miss `LoadingFallback`.
 * If the target component defines `LoadingFallback`, the section file should re-export it.
 */
function fixLoadingFallbackReExports(ctx: MigrationContext) {
  const sectionsDir = path.join(ctx.sourceDir, "src", "sections");
  if (!fs.existsSync(sectionsDir)) return;

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) continue;

      const filePath = path.join(dir, entry.name);
      const content = fs.readFileSync(filePath, "utf-8");

      // Match: `export { default } from "../../some/path"`  (no LoadingFallback)
      const reExportMatch = content.match(
        /^export\s*\{\s*default\s*\}\s*from\s*["']([^"']+)["']\s*;?\s*$/m,
      );
      if (!reExportMatch) continue;
      if (content.includes("LoadingFallback")) continue; // already has it

      // Resolve the target module and check if it exports LoadingFallback
      const targetRelPath = reExportMatch[1];
      const resolved = path.resolve(path.dirname(filePath), targetRelPath);
      const candidates = [
        resolved + ".tsx", resolved + ".ts",
        path.join(resolved, "index.tsx"), path.join(resolved, "index.ts"),
      ];

      for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        const targetContent = fs.readFileSync(candidate, "utf-8");
        if (/export\s+(?:function|const)\s+LoadingFallback\b/.test(targetContent)) {
          // Add LoadingFallback to the re-export
          const newContent = content.replace(
            /export\s*\{\s*default\s*\}\s*from/,
            "export { default, LoadingFallback } from",
          );
          if (newContent !== content) {
            if (!ctx.dryRun) fs.writeFileSync(filePath, newContent);
            const rel = path.relative(ctx.sourceDir, filePath);
            log(ctx, `  Added LoadingFallback re-export: ${rel}`);
          }
          break;
        }
      }
    }
  }

  walk(sectionsDir);
}

/**
 * Find the end index of a self-closing JSX tag starting from a position
 * inside the tag body. Handles nested braces, brackets, and parens.
 * Returns the index of `>` in `/>`, or -1 if not found.
 */
function findSelfClosingEnd(src: string, startIdx: number): number {
  let i = startIdx;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "{" || ch === "[" || ch === "(") {
      const close = ch === "{" ? "}" : ch === "[" ? "]" : ")";
      let depth = 1;
      i++;
      while (i < src.length && depth > 0) {
        if (src[i] === ch) depth++;
        if (src[i] === close) depth--;
        if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
          const q = src[i];
          i++;
          while (i < src.length && src[i] !== q) {
            if (src[i] === "\\" && q !== "`") i++;
            i++;
          }
        }
        i++;
      }
      continue;
    }
    if (ch === "/" && i + 1 < src.length && src[i + 1] === ">") {
      return i + 1;
    }
    i++;
  }
  return -1;
}

/**
 * Extract JSX prop assignments from a string like:
 *   items={[...]} offers={product.offers}
 * Returns an array of { name, value } with balanced brace extraction.
 */
function extractJsxProps(src: string): Array<{ name: string; value: string }> {
  const props: Array<{ name: string; value: string }> = [];
  const propRe = /(\w+)\s*=\s*\{/g;
  let match;
  while ((match = propRe.exec(src)) !== null) {
    const name = match[1];
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      if (src[i] === "}") depth--;
      if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
        const q = src[i];
        i++;
        while (i < src.length && src[i] !== q) {
          if (src[i] === "\\" && q !== "`") i++;
          i++;
        }
      }
      if (depth > 0) i++;
    }
    // i is at the closing }
    const value = src.slice(match.index + match[0].length, i);
    props.push({ name, value });
    propRe.lastIndex = i + 1;
  }
  return props;
}

/**
 * Convert `<varName.Component {...varName?.props} prop1={val1} />` patterns
 * to `<RenderSection section={{...varName, prop1: val1}} />`.
 *
 * Handles multi-line JSX with nested braces (e.g. items={[{...}]}).
 */
function convertDirectComponentCalls(src: string, onFix: (msg: string) => void): string {
  const componentCallRe = /<(\w+)\.Component\b/g;
  let result = src;
  let offset = 0;
  let match;

  // Reset lastIndex
  componentCallRe.lastIndex = 0;
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  while ((match = componentCallRe.exec(src)) !== null) {
    const varName = match[1];
    const tagStart = match.index;

    // Find the self-closing end
    const bodyStart = tagStart + match[0].length;
    const endIdx = findSelfClosingEnd(src, bodyStart);
    if (endIdx === -1) continue;

    const fullTag = src.slice(tagStart, endIdx + 1);
    const body = src.slice(bodyStart, endIdx - 1).trim(); // between <X.Component and />

    // Verify there's a spread: {...varName?.props} or {...varName.props}
    const spreadRe = new RegExp(`\\{\\.\\.\\.${varName}\\??\\.(props)\\}`, "g");
    if (!spreadRe.test(body)) continue;

    // Remove the spread from body and extract remaining props
    const bodyWithoutSpread = body.replace(spreadRe, "").trim();
    const additionalProps = extractJsxProps(bodyWithoutSpread);

    let sectionExpr: string;
    if (additionalProps.length === 0) {
      sectionExpr = varName;
    } else {
      const propEntries = additionalProps
        .map((p) => `${p.name}: ${p.value}`)
        .join(", ");
      sectionExpr = `{...${varName}, ${propEntries}}`;
    }

    const replacement = `<RenderSection section={${sectionExpr}} />`;
    replacements.push({ start: tagStart, end: endIdx + 1, replacement });
  }

  // Apply replacements in reverse order to preserve indices
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
    onFix(`Converted .Component direct call → RenderSection`);
  }

  return result;
}

/**
 * Replace SectionRenderer with RenderSection in components.
 *
 * SectionRenderer (from DecoPageRenderer) requires section.Component to be a
 * resolved function/string. RenderSection also handles bare { __resolveType }
 * objects, which is how CMS blocks pass nested sections.
 *
 * Also converts direct `<section.Component {...props}/>` patterns to use
 * RenderSection for robustness.
 */
function upgradeSectionRenderer(ctx: MigrationContext) {
  rewriteFilesRecursive(ctx, path.join(ctx.sourceDir, "src"), (content, relPath) => {
    if (!relPath.endsWith(".tsx") && !relPath.endsWith(".ts")) return null;

    let result = content;
    let changed = false;

    // 1. Replace `import { SectionRenderer } from "@decocms/start/hooks"`
    //    with `import { RenderSection } from "@decocms/start/hooks"`
    const sectionRendererImport =
      /import\s*\{([^}]*)\bSectionRenderer\b([^}]*)\}\s*from\s*["']@decocms\/start\/hooks["']/g;
    const newContent = result.replace(sectionRendererImport, (_m, before, after) => {
      changed = true;
      return `import {${before}RenderSection${after}} from "@decocms/start/hooks"`;
    });
    if (newContent !== result) {
      result = newContent;
      log(ctx, `  Replaced SectionRenderer import → RenderSection: src/${relPath}`);
    }

    // 2. Replace JSX: <SectionRenderer section={x} /> → <RenderSection section={x} />
    const sectionRendererJsx = /<SectionRenderer\b/g;
    if (sectionRendererJsx.test(result)) {
      result = result.replace(/<SectionRenderer\b/g, "<RenderSection");
      changed = true;
      log(ctx, `  Replaced <SectionRenderer → <RenderSection: src/${relPath}`);
    }

    // 3. Convert <varName.Component {...varName?.props} additionalProp={value} ... />
    //    to <RenderSection section={{...varName, additionalProp: value, ...}} />
    result = convertDirectComponentCalls(result, (msg) => {
      changed = true;
      log(ctx, `  ${msg}: src/${relPath}`);
    });

    // 4. Add RenderSection import if we introduced usages but no import exists
    if (changed && result.includes("<RenderSection") && !result.includes("RenderSection")) {
      result = `import { RenderSection } from "@decocms/start/hooks";\n` + result;
    }

    if (!changed) return null;
    return result;
  });
}

/**
 * Rewrite imports from @decocms/apps/vtex/utils/* and other non-existent modules
 * to use the simplified ~/lib/ wrappers generated during scaffold.
 *
 * This handles:
 * - @decocms/apps/vtex/utils/transform → ~/lib/vtex-transform
 * - @decocms/apps/vtex/utils/intelligentSearch → ~/lib/vtex-intelligent-search
 * - @decocms/apps/vtex/utils/segment → ~/lib/vtex-segment
 * - @decocms/apps/vtex/client (VTEXCommerceStable) → ~/lib/vtex-client
 * - @decocms/apps/vtex/loaders/intelligentSearch/* → inline stubs
 * - createHttpClient from various sources → ~/lib/http-utils
 * - STALE constant → ~/lib/fetch-utils
 * - Typed HTTP client patterns → simplified fetch
 */
function rewriteVtexUtilImports(ctx: MigrationContext) {
  const importRewrites: Array<{ pattern: RegExp; replacement: string; desc: string }> = [
    {
      pattern: /from\s+["']@decocms\/apps\/vtex\/utils\/transform["']/g,
      replacement: 'from "~/lib/vtex-transform"',
      desc: "vtex/utils/transform → ~/lib/vtex-transform",
    },
    {
      pattern: /from\s+["']@decocms\/apps\/vtex\/utils\/intelligentSearch["']/g,
      replacement: 'from "~/lib/vtex-intelligent-search"',
      desc: "vtex/utils/intelligentSearch → ~/lib/vtex-intelligent-search",
    },
    {
      pattern: /from\s+["']@decocms\/apps\/vtex\/utils\/segment["']/g,
      replacement: 'from "~/lib/vtex-segment"',
      desc: "vtex/utils/segment → ~/lib/vtex-segment",
    },
    {
      pattern: /from\s+["']@decocms\/apps\/vtex\/client["']/g,
      replacement: 'from "~/lib/vtex-client"',
      desc: "vtex/client → ~/lib/vtex-client",
    },
  ];

  rewriteFilesRecursive(ctx, path.join(ctx.sourceDir, "src"), (content, relPath) => {
    if (!relPath.endsWith(".tsx") && !relPath.endsWith(".ts")) return null;

    let result = content;
    let changed = false;

    for (const rw of importRewrites) {
      if (rw.pattern.test(result)) {
        result = result.replace(rw.pattern, rw.replacement);
        changed = true;
        log(ctx, `  Import rewrite (${rw.desc}): src/${relPath}`);
      }
    }

    // Replace entire import from productListingPage (module doesn't exist in @decocms/apps)
    const plpImport = /import\s*\{[^}]*\}\s*from\s*["'][^"']*intelligentSearch\/productListingPage["'];?\s*\n?/g;
    if (plpImport.test(result)) {
      result = result.replace(plpImport, `type LabelledFuzzy = "disabled" | "automatic" | "always";\nfunction mapLabelledFuzzyToFuzzy(fuzzy: LabelledFuzzy): string {\n  const mapping: Record<LabelledFuzzy, string> = { disabled: "0", automatic: "auto", always: "1" };\n  return mapping[fuzzy] ?? "0";\n}\n`);
      changed = true;
      log(ctx, `  Inlined LabelledFuzzy + mapLabelledFuzzyToFuzzy: src/${relPath}`);
    }

    // Strip generic type params from createHttpClient<Type>(...) → createHttpClient(...)
    // The Proxy-based createHttpClient handles all patterns at runtime.
    const typedClient = /\bcreateHttpClient<[^>]+>/g;
    if (typedClient.test(result)) {
      result = result.replace(typedClient, "createHttpClient");
      changed = true;
      log(ctx, `  Stripped generic type param from createHttpClient: src/${relPath}`);
    }

    // Remove `fetcher: fetchSafe,` from createHttpClient options (Proxy uses native fetch)
    const fetcherParam = /,?\s*fetcher:\s*fetchSafe\s*,?/g;
    if (fetcherParam.test(result)) {
      result = result.replace(fetcherParam, (match) => {
        // If the fetcher was between two other params, keep one comma
        if (match.startsWith(",") && match.endsWith(",")) return ",";
        return "";
      });
      changed = true;
    }

    // Replace inline getSegmentFromBag stub with import from ~/lib/vtex-segment
    const segmentStub = /^const getSegmentFromBag = \(_ctx: any\) => \(\{ value: \{\} as any \}\);\s*\n?/gm;
    if (segmentStub.test(result)) {
      result = result.replace(segmentStub, "");
      if (!result.includes("from \"~/lib/vtex-segment\"")) {
        result = `import { getSegmentFromBag } from "~/lib/vtex-segment";\n` + result;
      }
      changed = true;
      log(ctx, `  Replaced inline getSegmentFromBag stub → ~/lib/vtex-segment: src/${relPath}`);
    }

    // Replace inline fetchSafe stub with import from ~/lib/fetch-utils
    const fetchSafeStub = /^const fetchSafe = async \(url:.*?\n/gm;
    if (fetchSafeStub.test(result)) {
      result = result.replace(fetchSafeStub, "");
      if (!result.includes("from \"~/lib/fetch-utils\"")) {
        result = `import { fetchSafe } from "~/lib/fetch-utils";\n` + result;
      }
      changed = true;
      log(ctx, `  Replaced inline fetchSafe stub → ~/lib/fetch-utils: src/${relPath}`);
    }

    // Replace inline getISCookiesFromBag stub with import from ~/lib/vtex-intelligent-search
    const isCookiesStub = /^const getISCookiesFromBag = \(_ctx: any\) => \(\{\}\);\s*\n?/gm;
    if (isCookiesStub.test(result)) {
      result = result.replace(isCookiesStub, "");
      if (!result.includes("from \"~/lib/vtex-intelligent-search\"")) {
        result = `import { getISCookiesFromBag } from "~/lib/vtex-intelligent-search";\n` + result;
      }
      changed = true;
      log(ctx, `  Replaced inline getISCookiesFromBag stub → ~/lib/vtex-intelligent-search: src/${relPath}`);
    }

    // Rewrite ~/utils/retry → @decocms/start/sdk/retry
    const retryImport = /from\s+["']~\/utils\/retry["']/g;
    if (retryImport.test(result)) {
      result = result.replace(retryImport, 'from "@decocms/start/sdk/retry"');
      changed = true;
      log(ctx, `  Rewrote retry import → @decocms/start/sdk/retry: src/${relPath}`);
    }

    // Rewrite type-only imports from productListingPage (Props type)
    const plpTypeImport = /import\s+type\s*\{[^}]*\}\s*from\s*["'][^"']*intelligentSearch\/productListingPage["'];?\s*\n?/g;
    if (plpTypeImport.test(result)) {
      result = result.replace(plpTypeImport, `import type { PLPProps as Props } from "~/types/vtex-loaders";\n`);
      changed = true;
      log(ctx, `  Rewrote type import from productListingPage → ~/types/vtex-loaders: src/${relPath}`);
    }

    if (!changed) return null;
    return result;
  });
}

/**
 * Ensure useVariantPossiblities omit set includes "modalType" and "Modal Type".
 * These VTEX variant dimensions cause broken variant selectors on PDP if not omitted.
 */
function fixVariantOmitSet(ctx: MigrationContext) {
  const candidates = [
    path.join(ctx.sourceDir, "src", "sdk", "useVariantPossiblities.ts"),
    path.join(ctx.sourceDir, "src", "sdk", "useVariantPossibilities.ts"),
  ];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;

    let content = fs.readFileSync(filePath, "utf-8");
    // Check if the omit set already has modalType
    if (content.includes('"modalType"')) continue;

    // Add "modalType" and "Modal Type" to the Set constructor
    const omitSetRe = /new Set\(\[([^\]]*)\]\)/;
    const match = content.match(omitSetRe);
    if (!match) continue;

    const existingItems = match[1].trim();
    const newItems = existingItems
      ? `${existingItems}, "modalType", "Modal Type"`
      : `"modalType", "Modal Type"`;

    const newContent = content.replace(omitSetRe, `new Set([${newItems}])`);
    if (newContent !== content) {
      if (!ctx.dryRun) fs.writeFileSync(filePath, newContent);
      const rel = path.relative(ctx.sourceDir, filePath);
      log(ctx, `  Added modalType/Modal Type to omit set: ${rel}`);
    }
  }
}

/**
 * Normalize import path casing to match the actual filesystem.
 * On macOS (case-insensitive), `~/components/Header/` and `~/components/header/`
 * resolve to the same directory. But on Linux (CI, production builds), mismatched
 * casing causes "module not found" errors.
 *
 * This function scans all source files for `~/` imports and checks whether the
 * referenced path actually exists with the correct casing. If not, it tries to
 * find the correct-cased path on the filesystem.
 */
function normalizeImportCasing(ctx: MigrationContext) {
  const srcDir = path.join(ctx.sourceDir, "src");
  if (!fs.existsSync(srcDir)) return;

  // Build a map of all actual paths (with their real casing) under src/
  const realPaths = new Map<string, string>(); // lowercase → actual
  function indexDir(dir: string, prefix: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".deco") continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        realPaths.set(rel.toLowerCase(), rel);
        if (entry.isDirectory()) {
          indexDir(path.join(dir, entry.name), rel);
        }
      }
    } catch {}
  }
  indexDir(srcDir, "");

  rewriteFilesRecursive(ctx, srcDir, (content, relPath) => {
    if (!content.includes("~/")) return null;

    let result = content;
    let changed = false;

    // Match imports/exports from "~/" paths
    const importRe = /(?:from|import\()\s*["'](~\/[^"']+)["']/g;
    let match;
    while ((match = importRe.exec(content)) !== null) {
      const importPath = match[1]; // e.g. ~/components/Header/Buttons/Cart/vtex
      const relToSrc = importPath.slice(2); // e.g. components/Header/Buttons/Cart/vtex

      // Check with common extensions
      const candidates = [
        relToSrc,
        relToSrc + ".tsx",
        relToSrc + ".ts",
        relToSrc + "/index.tsx",
        relToSrc + "/index.ts",
      ];

      for (const candidate of candidates) {
        const lower = candidate.toLowerCase();
        const actual = realPaths.get(lower);
        if (actual && actual !== candidate) {
          // Casing mismatch — fix the import path
          let corrected = actual;
          // Strip extension if the original import didn't have one
          if (!relToSrc.match(/\.\w+$/)) {
            corrected = corrected.replace(/\.(tsx?|jsx?)$/, "");
            corrected = corrected.replace(/\/index$/, "");
          }
          const oldPath = importPath;
          const newPath = `~/${corrected}`;
          if (oldPath !== newPath) {
            result = result.replace(oldPath, newPath);
            changed = true;
            log(ctx, `  Fixed import casing: ${oldPath} → ${newPath} in src/${relPath}`);
          }
          break;
        }
      }
    }

    return changed ? result : null;
  });
}

/**
 * Fix APIs that don't exist in Cloudflare Workers:
 * - window.setTimeout → setTimeout
 * - window.clearTimeout → clearTimeout
 * - window.setInterval → setInterval
 * - window.clearInterval → clearInterval
 */
function fixWorkerIncompatibleApis(ctx: MigrationContext) {
  const replacements: Array<{ pattern: RegExp; replacement: string }> = [
    { pattern: /\bwindow\.setTimeout\b/g, replacement: "setTimeout" },
    { pattern: /\bwindow\.clearTimeout\b/g, replacement: "clearTimeout" },
    { pattern: /\bwindow\.setInterval\b/g, replacement: "setInterval" },
    { pattern: /\bwindow\.clearInterval\b/g, replacement: "clearInterval" },
  ];

  rewriteFilesRecursive(ctx, path.join(ctx.sourceDir, "src"), (content, relPath) => {
    if (!relPath.endsWith(".tsx") && !relPath.endsWith(".ts")) return null;

    let result = content;
    let changed = false;

    for (const rp of replacements) {
      if (rp.pattern.test(result)) {
        result = result.replace(rp.pattern, rp.replacement);
        changed = true;
      }
    }

    if (changed) {
      log(ctx, `  Fixed Worker-incompatible APIs: src/${relPath}`);
    }

    return changed ? result : null;
  });
}

export function cleanup(ctx: MigrationContext): void {
  logPhase("Cleanup");

  // 0. Remove empty block stubs that shadow real data
  console.log("  Removing empty block stubs...");
  removeEmptyBlockStubs(ctx);

  // 1. Move static → public (handles static/, static-cv/, static-lb/, etc.)
  console.log("  Moving static assets → public/...");
  moveStaticFiles(ctx);
  moveMultiBrandStaticFiles(ctx);

  // 2. Delete specific files
  console.log("  Deleting old files...");
  for (const file of ROOT_FILES_TO_DELETE) {
    deleteFileIfExists(ctx, file);
  }
  for (const file of SDK_FILES_TO_DELETE) {
    deleteFileIfExists(ctx, file);
    deleteFileIfExists(ctx, `src/${file}`);
  }
  for (const file of WRAPPER_FILES_TO_DELETE) {
    deleteFileIfExists(ctx, file);
    deleteFileIfExists(ctx, `src/${file}`);
  }
  for (const file of LOADER_FILES_TO_DELETE) {
    deleteFileIfExists(ctx, file);
    deleteFileIfExists(ctx, `src/${file}`);
  }

  // 3. Delete directories
  console.log("  Deleting old directories...");
  for (const dir of DIRS_TO_DELETE) {
    deleteDirIfExists(ctx, dir);
  }

  // 4. Clean up old source directories
  console.log("  Cleaning up old source dirs...");
  cleanupOldSourceDirs(ctx);
  cleanupReExportSections(ctx);
  cleanupJunkFromSrc(ctx);

  // 5. Override contexts/device.tsx with SSR-safe useSyncExternalStore version.
  // The transform phase copies and transforms the source file (createContext-based),
  // but @decocms/start shell-renders sections without a Device.Provider, so we
  // must replace it with a standalone implementation.
  console.log("  Overriding contexts/device.tsx...");
  overrideDeviceContext(ctx);

  // 6. Rewrite retry.ts to remove cockatiel (creates AbortController at module scope)
  console.log("  Rewriting utils/retry.ts...");
  rewriteRetryUtil(ctx);

  // 7. Add safety guards for common runtime errors in migrated code
  console.log("  Adding runtime safety guards...");
  addRuntimeSafetyGuards(ctx);

  // 8. Fix section barrel files missing LoadingFallback re-export
  console.log("  Fixing LoadingFallback re-exports...");
  fixLoadingFallbackReExports(ctx);

  // 9. Replace SectionRenderer with RenderSection for nested sections
  console.log("  Upgrading SectionRenderer → RenderSection...");
  upgradeSectionRenderer(ctx);

  // 10. Migrate account.json → src/constants/account.ts
  //    Old stack has a root-level account.json containing the site name as a JSON string.
  //    New stack uses a TS module `src/constants/account.ts` exporting `accountName`.
  //    We also rewrite all imports that reference account.json.
  console.log("  Migrating account.json → src/constants/account.ts...");
  migrateAccountJson(ctx);

  // 11. Rewrite VTEX utility imports to use ~/lib/ wrappers
  //    The old stack imports from apps/vtex/utils/* which get rewritten to
  //    @decocms/apps/vtex/utils/* — but the signatures are incompatible
  //    and some types (VTEXCommerceStable) don't exist. Replace with
  //    simplified ~/lib/ wrappers generated during scaffold.
  console.log("  Rewriting VTEX utility imports → ~/lib/ wrappers...");
  rewriteVtexUtilImports(ctx);

  // 12. Fix useVariantPossiblities omit set
  console.log("  Fixing useVariantPossiblities omit set...");
  fixVariantOmitSet(ctx);

  // 13. Normalize component import path casing
  console.log("  Normalizing component import casing...");
  normalizeImportCasing(ctx);

  // 13. Fix Worker-incompatible APIs (window.setTimeout, etc.)
  console.log("  Fixing Worker-incompatible APIs...");
  fixWorkerIncompatibleApis(ctx);

  console.log(
    `  Deleted ${ctx.deletedFiles.length} files/dirs, moved ${ctx.movedFiles.length} files`,
  );
}
