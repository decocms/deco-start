import {
  createDecoAdminRoute,
  type DecoAdminRouteOptions,
} from "../node/daemon/route";

export interface DecoAdminRouteHandlers {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
  PATCH: (req: Request) => Promise<Response>;
  DELETE: (req: Request) => Promise<Response>;
}

/**
 * Build a `{ GET, POST, PATCH, DELETE }` quartet suitable for one-line `export`
 * from every App Router route file under your `app/` tree. Instantiate once in
 * a shared module and re-export from each route file — the same set works for
 * read-only routes (`/_healthcheck`, `/live/_meta`) and the mutating
 * `/fs/file/*` flows alike, because the dispatcher branches on method
 * internally.
 *
 * @example
 * // app/lib/deco-admin.ts
 * import { createDecoAdminRouteHandlers } from "@decocms/start/next";
 * export const { GET, POST, PATCH, DELETE } = createDecoAdminRouteHandlers({
 *   site: "my-site",
 * });
 *
 * // app/%5Fhealthcheck/route.ts (and every other route file)
 * export const dynamic = "force-dynamic";
 * export { GET, POST, PATCH, DELETE } from "@/lib/deco-admin";
 *
 * @example
 * // Per-request setup (e.g. hydrate the block registry before any handler runs).
 * // The onRequest hook runs once per request, before pathname dispatch.
 * export const { GET, POST, PATCH, DELETE } = createDecoAdminRouteHandlers({
 *   site: "my-site",
 *   onRequest: () => ensureSetup(),
 * });
 */
export function createDecoAdminRouteHandlers(
  opts: DecoAdminRouteOptions = {},
): DecoAdminRouteHandlers {
  const handler = createDecoAdminRoute(opts);
  return { GET: handler, POST: handler, PATCH: handler, DELETE: handler };
}

/**
 * Pre-instantiated handlers using all defaults (reads `DECO_SITE` from env).
 * Use this only for the simplest setup — most apps will call
 * `createDecoAdminRouteHandlers` to lock options at the call site.
 *
 * Implemented lazily so importing this module without `DECO_SITE` set yet
 * does not crash at import time.
 */
let _defaultHandlers: DecoAdminRouteHandlers | null = null;
function getDefaultHandlers(): DecoAdminRouteHandlers {
  if (!_defaultHandlers) {
    _defaultHandlers = createDecoAdminRouteHandlers({ site: process.env.DECO_SITE });
  }
  return _defaultHandlers;
}

export const decoAdminRouteHandlers: DecoAdminRouteHandlers = {
  GET: (req) => getDefaultHandlers().GET(req),
  POST: (req) => getDefaultHandlers().POST(req),
  PATCH: (req) => getDefaultHandlers().PATCH(req),
  DELETE: (req) => getDefaultHandlers().DELETE(req),
};
