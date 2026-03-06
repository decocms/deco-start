/**
 * Client-safe admin setup functions.
 *
 * These functions only set module-level state (no node: imports,
 * no AsyncLocalStorage). Safe to import in both client and SSR builds.
 *
 * For server-only handlers (handleMeta, handleRender, etc.),
 * import from "@decocms/start/admin" instead.
 */
export { setMetaData } from "./meta";
export { setInvokeLoaders, type InvokeLoader } from "./invoke";

let cssHref: string | null = null;
let fontHrefs: string[] = [];

export function setRenderShell(opts: { css?: string; fonts?: string[] }) {
  if (opts.css) cssHref = opts.css;
  if (opts.fonts) fontHrefs = opts.fonts;
}

export function getRenderShellConfig() {
  return { cssHref, fontHrefs };
}
