/**
 * Client-safe admin setup functions.
 *
 * These functions only set module-level state (no node: imports,
 * no AsyncLocalStorage). Safe to import in both client and SSR builds.
 *
 * For server-only handlers (handleMeta, handleRender, etc.),
 * import from "@decocms/start/admin" instead.
 */

export { type InvokeAction, type InvokeLoader, setInvokeActions, setInvokeLoaders } from "./invoke";
export { setMetaData } from "./meta";
export {
  type LoaderConfig,
  type MatcherConfig,
  registerLoaderSchema,
  registerLoaderSchemas,
  registerMatcherSchema,
  registerMatcherSchemas,
} from "./schema";

let cssHref: string | null = null;
let fontHrefs: string[] = [];
let themeName = "light";
let bodyClass = "bg-base-100 text-base-content";
let htmlLang = "pt-BR";

export function setRenderShell(opts: {
  css?: string;
  fonts?: string[];
  theme?: string;
  bodyClass?: string;
  lang?: string;
}) {
  if (opts.css) cssHref = opts.css;
  if (opts.fonts) fontHrefs = opts.fonts;
  if (opts.theme !== undefined) themeName = opts.theme;
  if (opts.bodyClass !== undefined) bodyClass = opts.bodyClass;
  if (opts.lang !== undefined) htmlLang = opts.lang;
}

export function getRenderShellConfig() {
  return { cssHref, fontHrefs, themeName, bodyClass, htmlLang };
}
