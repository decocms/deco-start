import {
  createDecoAdminRoute,
  type DecoAdminRouteOptions,
} from "../node/daemon/route";

export interface DecoAdminRouteHandlers {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
}

/**
 * Build a `{ GET, POST }` pair suitable for one-line `export` from every
 * App Router route file under your `app/` tree. Instantiate once in a shared
 * module and re-export from each route file.
 *
 * @example
 * // app/lib/deco-admin.ts
 * import { createDecoAdminRouteHandlers } from "@decocms/start/next";
 * export const { GET, POST } = createDecoAdminRouteHandlers({ site: "my-site" });
 *
 * // app/%5Fhealthcheck/route.ts
 * export const dynamic = "force-dynamic";
 * export { GET, POST } from "@/lib/deco-admin";
 */
export function createDecoAdminRouteHandlers(
  opts: DecoAdminRouteOptions = {},
): DecoAdminRouteHandlers {
  const handler = createDecoAdminRoute(opts);
  return { GET: handler, POST: handler };
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
};
