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
let themeName = "";
let bodyClass = "";
let htmlLang = "en";

/**
 * Optional React component that wraps section renders in admin previews.
 * Use this to provide context that sections depend on (Router, QueryClient, etc.)
 * without which renderToString would crash.
 *
 * The wrapper receives `{ children }` and should render them inside the
 * necessary providers.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let previewWrapperComponent: any = null;

/**
 * Register a wrapper component for admin preview renders.
 *
 * @example
 * ```ts
 * // In site's setup.ts:
 * import { setPreviewWrapper } from "@decocms/start/admin/setup";
 * import { PreviewProviders } from "./components/PreviewProviders";
 * setPreviewWrapper(PreviewProviders);
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setPreviewWrapper(wrapper: any) {
  previewWrapperComponent = wrapper;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getPreviewWrapper(): any {
  return previewWrapperComponent;
}

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
