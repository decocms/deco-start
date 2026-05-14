/**
 * @decocms/start/node/daemon — Web-standard daemon handlers.
 *
 * Node-only (depends on `node:fs/promises`, `chokidar`, `fast-json-patch`).
 * Consumed by both `@decocms/start/next` (directly) and
 * `@decocms/start/tanstack/daemon` (via `toNodeMiddleware` for Vite).
 */
export { handleDecoHealthcheck } from "./healthcheck";
export { handleDecoReadiness } from "../../core/admin/readiness";
export { ADMIN_COMPAT_VERSION } from "../../core/admin/version";
export { requireAdminJwt } from "./auth";
export { verifyAdminJwt, tokenIsValid } from "./jwt";
export type { JwtPayload } from "./jwt";
export { handleFsRequest } from "./fs";
export type { FsHandlerOptions } from "./fs";
export {
  broadcastFsEvent,
  subscribeFsEvents,
  inferMetadata,
  scanDecoFiles,
  type FsEvent,
  type Metadata,
} from "./watch";
export { handleWatchSse } from "./watch-sse";
export type { WatchSseOptions } from "./watch-sse";
export { createDecoWatcher, bindWatcherToChannel } from "./watcher";
export type { DecoWatcher } from "./watcher";
export { createDecoAdminRoute } from "./route";
export type { DecoAdminRouteOptions } from "./route";
export { toNodeMiddleware } from "./nodeHttpAdapter";
export type { WebHandler } from "./nodeHttpAdapter";
