import type { TransformResult } from "../types.ts";

/**
 * Removes dead code patterns from the old Deco stack that don't work
 * in TanStack Start:
 *
 * - `export const cache = "stale-while-revalidate"` (old cache system)
 * - `export const cacheKey = ...` (old cache key generation)
 * - `crypto.subtle.digestSync(...)` (Deno-only sync API)
 *
 * NOTE: `export const loader` is kept — it's a server-side function the CMS calls.
 * NOTE: invoke.* calls are NOT migrated — they are RPC calls to the server
 * where the CMS config (API keys, etc.) is available. The runtime.ts invoke
 * proxy handles routing them to /deco/invoke/*.
 */
/**
 * Remove an `export const <name> = ...` block using brace-counting
 * so nested `{}` (for loops, if/else) don't cause premature truncation.
 */
function removeExportConstBlock(src: string, name: string): string {
  const pattern = new RegExp(`^export\\s+const\\s+${name}\\s*=`, "m");
  const match = pattern.exec(src);
  if (!match) return src;

  // Find the arrow `=>` first, then the opening `{` of the body.
  // This avoids matching destructuring braces in parameters like
  // `export const loader = ({ groups }: Props) => { ... }`
  let pos = match.index + match[0].length;
  // Look for `=>`
  const arrowIdx = src.indexOf("=>", pos);
  if (arrowIdx === -1) {
    // No arrow function — try simple brace from current position
    while (pos < src.length && src[pos] !== "{") pos++;
  } else {
    // Start searching for `{` after the arrow
    pos = arrowIdx + 2;
    while (pos < src.length && src[pos] !== "{") pos++;
  }
  if (pos >= src.length) return src; // no brace body, skip

  // Count braces to find the matching closing brace
  let depth = 0;
  const start = match.index;
  for (; pos < src.length; pos++) {
    if (src[pos] === "{") depth++;
    else if (src[pos] === "}") {
      depth--;
      if (depth === 0) {
        // Skip optional semicolon and trailing newline
        let end = pos + 1;
        if (end < src.length && src[end] === ";") end++;
        if (end < src.length && src[end] === "\n") end++;
        return src.slice(0, start) + src.slice(end);
      }
    }
  }
  return src; // unbalanced braces, don't touch
}

const ALL_PLATFORMS = ["vtex", "shopify", "linx", "vnda", "wake", "nuvemshop"];

/**
 * Strip imports, JSX conditionals, and if-blocks for non-active platforms.
 * E.g. on a VTEX site, remove all shopify/linx/vnda/wake/nuvemshop branches.
 */
function stripNonPlatformCode(src: string, platform: string): { content: string; stripped: boolean } {
  const deadPlatforms = ALL_PLATFORMS.filter((p) => p !== platform);
  if (deadPlatforms.length === 0) return { content: src, stripped: false };

  const deadRe = new RegExp(`\\b(${deadPlatforms.join("|")})\\b`, "i");
  if (!deadRe.test(src)) return { content: src, stripped: false };

  let result = src;
  const removedIdentifiers: string[] = [];

  // 1. Remove import lines referencing dead platforms
  const importLineRe = /^import\s+(\w+)\s+from\s+["'][^"']*["'];?\s*$/gm;
  result = result.replace(importLineRe, (line, ident) => {
    if (deadRe.test(line)) {
      removedIdentifiers.push(ident);
      return "";
    }
    return line;
  });

  // Also handle: import type { X } from "path/platform"
  const importTypeLineRe = /^import\s+type\s+\{[^}]*\}\s+from\s+["'][^"']*["'];?\s*$/gm;
  result = result.replace(importTypeLineRe, (line) => {
    if (deadRe.test(line)) return "";
    return line;
  });

  // Handle lazy dynamic imports: const X = lazy(() => import("./platform/Cart"));
  const lazyImportRe = /^const\s+(\w+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(["'][^"']*["']\)\s*\);?\s*$/gm;
  result = result.replace(lazyImportRe, (line, ident) => {
    if (deadRe.test(line)) {
      removedIdentifiers.push(ident);
      return "";
    }
    return line;
  });

  // 2. Remove JSX conditionals: {platform === "shopify" && (...)} using paren-counting
  for (const dp of deadPlatforms) {
    const jsxPatternStr = `\\{\\s*platform\\s*===\\s*["']${dp}["']\\s*&&\\s*\\(`;
    const jsxPattern = new RegExp(jsxPatternStr);
    let match: RegExpExecArray | null;
    while ((match = jsxPattern.exec(result)) !== null) {
      const start = match.index;
      // Find the opening paren after &&
      let pos = result.indexOf("(", match.index + match[0].length - 1);
      if (pos === -1) break;
      let depth = 0;
      for (; pos < result.length; pos++) {
        if (result[pos] === "(") depth++;
        else if (result[pos] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      // pos is at the closing paren. Find closing }
      let end = pos + 1;
      while (end < result.length && /\s/.test(result[end])) end++;
      if (end < result.length && result[end] === "}") end++;
      // Remove trailing newline
      if (end < result.length && result[end] === "\n") end++;
      result = result.slice(0, start) + result.slice(end);
    }
  }

  // 3. Remove if-blocks: if (platform === "shopify") { ... }
  for (const dp of deadPlatforms) {
    const ifPatternStr = `if\\s*\\(\\s*platform\\s*===\\s*["']${dp}["']\\s*\\)\\s*\\{`;
    const ifPattern = new RegExp(ifPatternStr);
    let match: RegExpExecArray | null;
    while ((match = ifPattern.exec(result)) !== null) {
      const start = match.index;
      let pos = result.indexOf("{", match.index);
      if (pos === -1) break;
      let depth = 0;
      for (; pos < result.length; pos++) {
        if (result[pos] === "{") depth++;
        else if (result[pos] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      let end = pos + 1;
      if (end < result.length && result[end] === "\n") end++;
      result = result.slice(0, start) + result.slice(end);
    }
  }

  // 4. Remove JSX references to removed identifiers: <RemovedIdent ... />
  for (const ident of removedIdentifiers) {
    // Self-closing: <Ident ... />
    const selfClose = new RegExp(`\\s*<${ident}\\b[^>]*/>`, "g");
    result = result.replace(selfClose, "");
    // Open/close pair (rare for platform buttons, but handle it)
    const openClose = new RegExp(`\\s*<${ident}\\b[^>]*>[\\s\\S]*?</${ident}>`, "g");
    result = result.replace(openClose, "");
  }

  return { content: result, stripped: result !== src };
}

export function transformDeadCode(content: string, platform?: string): TransformResult {
  const notes: string[] = [];
  let changed = false;
  let result = content;

  // Remove old cache export: export const cache = "stale-while-revalidate" or { maxAge: ... }
  if (/^export\s+const\s+cache\s*=/m.test(result)) {
    // String form: export const cache = "stale-while-revalidate";
    result = result.replace(
      /^export\s+const\s+cache\s*=\s*["'][^"']*["'];?\s*\n?/gm,
      "",
    );
    // Object form: export const cache = { maxAge: 60 * 10 };
    result = result.replace(
      /^export\s+const\s+cache\s*=\s*\{[^}]*\};?\s*\n?/gm,
      "",
    );
    // Multiline object form (use brace-counting)
    if (/^export\s+const\s+cache\s*=/m.test(result)) {
      result = removeExportConstBlock(result, "cache");
    }
    changed = true;
    notes.push("Removed dead `export const cache` (old caching system)");
  }

  // Remove old cacheKey export (can be multiline with brace-counting)
  if (/^export\s+const\s+cacheKey\s*=/m.test(result)) {
    result = removeExportConstBlock(result, "cacheKey");
    // Also handle simpler inline forms
    result = result.replace(
      /^export\s+const\s+cacheKey\s*=[^;]*;\s*\n?/gm,
      "",
    );
    changed = true;
    notes.push("Removed dead `export const cacheKey` (old caching system)");
  }

  // NOTE: `export const loader` is kept — these are server-side functions
  // that the CMS calls to modify section props before rendering.

  // Replace crypto.subtle.digestSync (Deno-only) with a note
  if (result.includes("digestSync")) {
    result = result.replace(
      /crypto\.subtle\.digestSync\(/g,
      "/* MIGRATION: digestSync is Deno-only, use await crypto.subtle.digest( */ crypto.subtle.digest(",
    );
    changed = true;
    notes.push("MANUAL: crypto.subtle.digestSync is Deno-only — replaced with crypto.subtle.digest (needs await)");
  }

  // Replace logger usage from @deco/deco/o11y with console
  if (result.includes("logger.")) {
    result = result.replace(/\blogger\.error\b/g, "console.error");
    result = result.replace(/\blogger\.warn\b/g, "console.warn");
    result = result.replace(/\blogger\.info\b/g, "console.info");
    result = result.replace(/\blogger\.debug\b/g, "console.debug");
    result = result.replace(/\blogger\.log\b/g, "console.log");
    changed = true;
    notes.push("Replaced logger.* with console.* (logger from @deco/deco/o11y removed)");
  }

  // Remove re-exports of framework-only SEO Preview components
  const seoPreviewRe = /^export\s*\{[^}]*\}\s*from\s*["'][^"']*_seo[^"']*["'];?\s*$/gm;
  if (seoPreviewRe.test(result)) {
    result = result.replace(seoPreviewRe, "");
    changed = true;
    notes.push("Removed re-export of _seo/Preview (framework-only component)");
  }

  // Replace imports of removed framework APIs with inline stubs
  const removedApis: Array<{ import: RegExp; replacement: string; note: string }> = [
    {
      import: /import\s+\{([^}]*)\bgetSegmentFromBag\b([^}]*)\}\s+from\s+["'][^"']*segment["'];?\n?/,
      replacement: `const getSegmentFromBag = (_ctx: any) => ({ value: {} as any });\n`,
      note: "Stubbed getSegmentFromBag (Deco bag API removed — uses empty segment)",
    },
    // createHttpClient is now provided by ~/lib/http-utils (generated during scaffold)
    // — no need to remove it here; the import rewrite handles it.
    {
      import: /import\s+\{([^}]*)\bfetchSafe\b([^}]*)\}\s+from\s+["'][^"']*["'];?\n?/,
      replacement: `const fetchSafe = async (url: string | URL | Request, init?: RequestInit) => { const r = await fetch(url, init); if (!r.ok) throw new Error(\`fetchSafe: \${r.status}\`); return r; };\n`,
      note: "Stubbed fetchSafe (old Deco fetch utility — using native fetch with error check)",
    },
    {
      import: /import\s+\{([^}]*)\bgetISCookiesFromBag\b([^}]*)\}\s+from\s+["'][^"']*intelligentSearch["'];?\n?/,
      replacement: `const getISCookiesFromBag = (_ctx: any) => ({});\n`,
      note: "Stubbed getISCookiesFromBag (Deco bag API removed — returns empty cookies)",
    },
  ];

  for (const api of removedApis) {
    if (api.import.test(result)) {
      const match = result.match(api.import);
      if (match) {
        const otherImports = (match[1] + match[2])
          .split(",")
          .map((s: string) => s.trim())
          .filter((s: string) => s && s !== "getSegmentFromBag");
        let importLine = "";
        if (otherImports.length > 0) {
          const fromMatch = match[0].match(/from\s+["']([^"']+)["']/);
          const fromPath = fromMatch ? fromMatch[1] : "";
          importLine = `import { ${otherImports.join(", ")} } from "${fromPath}";\n`;
        }
        result = result.replace(api.import, importLine + api.replacement);
        changed = true;
        notes.push(api.note);
      }
    }
  }

  // Strip code for non-active platforms (e.g. remove shopify/linx imports on VTEX site)
  if (platform) {
    const platformResult = stripNonPlatformCode(result, platform);
    if (platformResult.stripped) {
      result = platformResult.content;
      changed = true;
      notes.push(`Stripped non-${platform} platform code`);
    }

    // Remove usePlatform() — the hook and all platform prop threading.
    // On a single-platform site the golden reference removes it entirely:
    //   - `const platform = usePlatform()` → deleted
    //   - `{platform === "vtex" && (<X />)}` → `<X />`
    //   - `platform={platform}` / `platform={usePlatform()}` JSX attrs → deleted
    //   - `platform: ReturnType<typeof usePlatform>` in types → deleted
    //   - `platform,` in destructuring / param lists → deleted
    if (result.includes("usePlatform")) {
      const before = result;

      // a) Remove `const platform = usePlatform();` declarations
      result = result.replace(/^\s*const\s+platform\s*=\s*usePlatform\(\);?\s*\n?/gm, "");

      // b) Collapse JSX conditionals for the ACTIVE platform:
      //    {platform === "vtex" && (<Component .../>)} → <Component .../>
      //    {platform === "vtex" && <Component .../> }  → <Component .../>
      const activeJsxParen = new RegExp(
        `\\{\\s*platform\\s*===\\s*["']${platform}["']\\s*&&\\s*\\(([\\s\\S]*?)\\)\\s*\\}`,
        "g",
      );
      result = result.replace(activeJsxParen, (_m, inner) => inner.trim());

      const activeJsxNoParen = new RegExp(
        `\\{\\s*platform\\s*===\\s*["']${platform}["']\\s*&&\\s*(<[^{}]*/>)\\s*\\}`,
        "g",
      );
      result = result.replace(activeJsxNoParen, (_m, jsx) => jsx.trim());

      // c) Remove platform JSX attributes: platform={platform}, platform={usePlatform()}
      result = result.replace(/\s+platform=\{usePlatform\(\)\}/g, "");
      result = result.replace(/\s+platform=\{platform\}/g, "");

      // d) Remove platform from type definitions / interfaces
      //    platform: ReturnType<typeof usePlatform>;
      result = result.replace(/^\s*platform\s*:\s*ReturnType<typeof usePlatform>;?\s*\n?/gm, "");
      //    platform: Platform;  (when from ~/apps/site.ts)
      result = result.replace(/^\s*platform\??\s*:\s*Platform;?\s*\n?/gm, "");
      //    platform?: string;
      result = result.replace(/^\s*platform\??\s*:\s*string;?\s*\n?/gm, "");

      // e) Remove `platform` from Omit<..., "platform"> → just the base type
      result = result.replace(/Omit<(\w+),\s*["']platform["']>/g, "$1");

      // f) Clean up remaining references in destructuring and param lists
      //    { platform, ...rest } → { ...rest } (or just remove the comma'd entry)
      result = result.replace(/\bplatform\s*,\s*/g, "");
      result = result.replace(/,\s*platform\b/g, "");

      if (result !== before) {
        changed = true;
        notes.push(`Removed usePlatform() — collapsed to ${platform}-only code`);
      }
    }
  }

  // ── Module-scope React hook calls ────────────────────────────────────
  // In Preact + signals, hooks like useUser()/useCart() can be called at module
  // scope because they return signals (no component context needed).
  // In React, hooks MUST be inside components. Detect and move them.
  //
  // Pattern: `const { a, b: alias } = useHookName();` at the top level
  // (not indented, not inside a function body).
  const moduleScopeHookRe = /^(const\s+\{([^}]+)\}\s*=\s*(use\w+)\(\);?\s*$)/gm;
  const moduleScopeHooks: Array<{
    fullMatch: string;
    vars: string[];
    hookCall: string;
    hookName: string;
  }> = [];

  let hookMatch: RegExpExecArray | null;
  while ((hookMatch = moduleScopeHookRe.exec(result)) !== null) {
    const line = hookMatch[1];
    const destructured = hookMatch[2];
    const hookName = hookMatch[3];

    // Skip non-React hooks (useAccount from ~/utils/sitename is just a function,
    // useUI returns signals — both are safe at module scope)
    const knownUnsafeHooks = ["useUser", "useCart", "useWishlist"];
    if (!knownUnsafeHooks.includes(hookName)) continue;

    const vars = destructured
      .split(",")
      .map((v) => {
        const trimmed = v.trim();
        const aliasMatch = trimmed.match(/(\w+)\s*:\s*(\w+)/);
        return aliasMatch ? aliasMatch[2] : trimmed;
      })
      .filter(Boolean);

    moduleScopeHooks.push({
      fullMatch: line,
      vars,
      hookCall: `const { ${destructured.trim()} } = ${hookName}();`,
      hookName,
    });
  }

  if (moduleScopeHooks.length > 0) {
    for (const hook of moduleScopeHooks) {
      // Remove the module-scope line
      result = result.replace(hook.fullMatch + "\n", "");
      result = result.replace(hook.fullMatch, "");

      // Find exported component functions and locate their body opener.
      // Arrow: `export const Foo = (...) => {`  — body starts after `=> {`
      // Function: `export function Foo(...) {`   — body starts after `) {`
      const insertions: Array<{ index: number; hookCall: string }> = [];

      // Arrow function body openers: "=> {"
      const arrowBodyRe = /=>\s*\{/g;
      // Function body openers: line starting with export ... function ... ) {
      const funcDeclRe = /^export\s+(?:default\s+)?function\s+\w+/gm;

      // Strategy: find all `=> {` and `) {` that follow an export declaration,
      // then check the body for variable references.
      const lines = result.split("\n");
      let inExportDecl = false;
      let charOffset = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Track exported function/const declarations
        if (/^export\s+(default\s+)?(function|const)\s+\w+/.test(line)) {
          inExportDecl = true;
        }

        if (inExportDecl) {
          // Look for body opener: `=> {` or `) {` (for function declarations)
          let bodyOpenerIdx = -1;
          const arrowMatch = line.match(/=>\s*\{/);
          const funcMatch = line.match(/\)\s*\{$/);

          if (arrowMatch && arrowMatch.index !== undefined) {
            bodyOpenerIdx = charOffset + arrowMatch.index + arrowMatch[0].length;
          } else if (funcMatch && funcMatch.index !== undefined) {
            bodyOpenerIdx = charOffset + funcMatch.index + funcMatch[0].length;
          }

          if (bodyOpenerIdx >= 0) {
            inExportDecl = false;
            const bodySlice = result.slice(bodyOpenerIdx, bodyOpenerIdx + 3000);
            const usesVars = hook.vars.some((v) => new RegExp(`\\b${v}\\b`).test(bodySlice));
            if (usesVars) {
              insertions.push({ index: bodyOpenerIdx, hookCall: `\n  ${hook.hookCall}` });
            }
          }
        }

        charOffset += line.length + 1; // +1 for \n
      }

      for (const ins of insertions.reverse()) {
        result = result.slice(0, ins.index) + ins.hookCall + result.slice(ins.index);
      }

      if (insertions.length > 0) {
        changed = true;
        notes.push(`Moved module-scope ${hook.hookName}() into ${insertions.length} component(s)`);
      }
    }
  }

  // Clean up blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return { content: result, changed, notes };
}
