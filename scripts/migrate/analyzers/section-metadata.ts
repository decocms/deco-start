import * as fs from "node:fs";
import * as path from "node:path";
import type { MigrationContext, SectionMeta } from "../types.ts";
import { log } from "../types.ts";

const HEADER_RE = /\bheader\b/i;
const FOOTER_RE = /\bfooter\b/i;
const THEME_RE = /\btheme\b/i;
const LISTING_RE = /\b(?:shelf|carousel|slider|product\s*list|search\s*result)\b/i;

const LOADER_CONST_RE = /^export\s+const\s+loader\b/m;
const LOADER_FN_RE = /^export\s+(?:async\s+)?function\s+loader\b/m;
const LOADING_FALLBACK_RE = /^export\s+(?:const|function)\s+LoadingFallback\b/m;
const JSDOC_TITLE_RE = /@title\b/;
const JSDOC_DESC_RE = /@description\b/;
const CTX_DEVICE_RE = /ctx\.device|useDevice|device.*(?:mobile|desktop)/i;
const CTX_URL_RE = /ctx\.url|req\.url|ctx\.request|searchParam|pathname/i;
const ASYNC_RE = /^export\s+async\s+function\s+loader\b/m;
const STATUS_ONLY_RE = /ctx\.response\.status\s*=/;
const IS_MOBILE_RE = /isMobile|is_mobile|ctx\.device\s*===?\s*["']mobile["']/i;
const DEVICE_PROP_RE = /device\s*:\s*ctx\.device/;

function isStatusOnlyLoader(content: string): boolean {
  const loaderMatch = content.match(
    /(?:export\s+const\s+loader\s*=|export\s+(?:async\s+)?function\s+loader)\s*[\s\S]*?\n(?=export\s|\z)/m,
  );
  if (!loaderMatch) return false;
  const loaderBody = loaderMatch[0];
  if (!STATUS_ONLY_RE.test(loaderBody)) return false;
  const meaningful = loaderBody
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/ctx\.response\.status\s*=\s*\d+;?/g, "")
    .replace(/return\s+props;?/g, "")
    .replace(/if\s*\(props\.\w+\s*===?\s*null\)/g, "")
    .replace(/export\s+(const|async\s+)?function\s+loader[^{]*\{/g, "")
    .replace(/\};\s*$/g, "")
    .trim();
  return meaningful.replace(/[\s{}();,]/g, "").length < 30;
}

export function extractSectionMetadata(ctx: MigrationContext): void {
  const sectionFiles = ctx.files.filter(
    (f) => f.category === "section" && f.action !== "delete",
  );

  for (const file of sectionFiles) {
    let content: string;
    try {
      content = fs.readFileSync(file.absPath, "utf-8");
    } catch {
      continue;
    }

    const basename = path.basename(file.path, path.extname(file.path));
    const dirName = path.dirname(file.path).split("/").pop() || "";
    const parentDirs = path.dirname(file.path).split("/");

    const hasLoaderConst = LOADER_CONST_RE.test(content);
    const hasLoaderFn = LOADER_FN_RE.test(content);
    const hasLoader = hasLoaderConst || hasLoaderFn;

    const isAccountSection = parentDirs.some((d) => d.toLowerCase() === "account");

    const meta: SectionMeta = {
      path: file.path,
      hasLoader,
      loaderIsAsync: hasLoader && ASYNC_RE.test(content),
      hasLoadingFallback: LOADING_FALLBACK_RE.test(content),
      isHeader: HEADER_RE.test(basename) || HEADER_RE.test(dirName),
      isFooter: FOOTER_RE.test(basename) || FOOTER_RE.test(dirName),
      isTheme: THEME_RE.test(basename) || THEME_RE.test(dirName),
      isListing: LISTING_RE.test(basename) || LISTING_RE.test(dirName),
      hasTitle: JSDOC_TITLE_RE.test(content),
      hasDescription: JSDOC_DESC_RE.test(content),
      loaderUsesDevice: hasLoader && CTX_DEVICE_RE.test(content),
      loaderUsesUrl: hasLoader && CTX_URL_RE.test(content),
      isAccountSection,
      isStatusOnly: hasLoader && isStatusOnlyLoader(content),
      usesMobileBoolean: hasLoader && IS_MOBILE_RE.test(content) && !DEVICE_PROP_RE.test(content),
    };

    ctx.sectionMetas.push(meta);
  }

  const withLoader = ctx.sectionMetas.filter((m) => m.hasLoader).length;
  const layouts = ctx.sectionMetas.filter((m) => m.isHeader || m.isFooter || m.isTheme).length;
  const accounts = ctx.sectionMetas.filter((m) => m.isAccountSection).length;
  const statusOnly = ctx.sectionMetas.filter((m) => m.isStatusOnly).length;
  log(ctx, `Sections analyzed: ${ctx.sectionMetas.length} total, ${withLoader} with loader, ${layouts} layout, ${accounts} account, ${statusOnly} status-only`);
}
