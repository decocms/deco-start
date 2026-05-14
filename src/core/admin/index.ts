export { corsHeaders, isAdminOrLocalhost, registerAdminOrigin, registerAdminOrigins } from "./cors";
export { handleDecofileRead, handleDecofileReload } from "./decofile";
export {
  clearInvokeHandlers,
  handleInvoke,
  type InvokeAction,
  type InvokeLoader,
  registerInvokeHandlers,
  setInvokeActions,
  setInvokeLoaders,
} from "./invoke";
export { LIVE_CONTROLS_SCRIPT } from "./liveControls";
export { handleMeta, setMetaData } from "./meta";
export { handleRender, setPreviewWrapper, setRenderShell } from "./render";
export {
  type ActionConfig,
  composeMeta,
  getRegisteredLoaders,
  getRegisteredMatchers,
  type LoaderConfig,
  type MatcherConfig,
  type MetaResponse,
  registerActionSchema,
  registerActionSchemas,
  registerLoaderSchema,
  registerLoaderSchemas,
  registerMatcherSchema,
  registerMatcherSchemas,
} from "./schema";
export { getRenderShellConfig } from "./setup";
export { ADMIN_COMPAT_VERSION } from "./version";
export { handleDecoReadiness } from "./readiness";
