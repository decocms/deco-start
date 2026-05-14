/**
 * @decocms/start/next — Next.js App Router adapter.
 *
 * App Router only. Pages Router not supported.
 */
export { loadCmsPage } from "./loadCmsPage";
export { buildMatcherContextFromNext } from "./ctx";
export {
  createDecoAdminRoute,
  handleDecoAdminRoute,
  type DecoAdminRouteOptions,
} from "./adminRoute";
export {
  createDecoAdminRouteHandlers,
  decoAdminRouteHandlers,
  type DecoAdminRouteHandlers,
} from "./routeHandlers";
export { DecoPage } from "./DecoPage";

// Probe handlers — re-exported so consumers can mount a single route file
// without the full dispatcher.
export { handleDecoHealthcheck } from "../node/daemon/healthcheck";
export { handleDecoReadiness } from "../core/admin/readiness";
export { ADMIN_COMPAT_VERSION } from "../core/admin/version";
