import {
  createDecoAdminRoute,
  type DecoAdminRouteOptions,
} from "../node/daemon/route";

/**
 * Dispatch a Next.js App Router request to the appropriate Deco daemon handler.
 *
 * Mount as both GET and POST in dedicated route files under your `app/` tree.
 * Next App Router needs escaped folder names because it treats `_folder` as
 * private and excludes it from routing:
 *
 *   app/
 *   ├── %5Fhealthcheck/route.ts     (literal %5F — Next/Turbopack do not URL-decode this)
 *   ├── %5Fready/route.ts
 *   ├── %5Fwatch/route.ts
 *   ├── .decofile/route.ts           (literal `.`, not %2E — Turbopack does not decode %2E)
 *   ├── live/
 *   │   ├── %5Fmeta/route.ts
 *   │   └── previews/[[...path]]/route.ts
 *   ├── deco/
 *   │   ├── render/route.ts
 *   │   └── invoke/[[...path]]/route.ts
 *   └── fs/file/[[...path]]/route.ts
 *
 * Each route file is two lines:
 *
 *   export const dynamic = "force-dynamic";
 *   export { GET, POST, PATCH, DELETE } from "@/lib/deco-admin";  // ← your config module
 *
 * Where `@/lib/deco-admin` instantiates a single configuration:
 *
 *   import { createDecoAdminRouteHandlers } from "@decocms/start/next";
 *   export const { GET, POST, PATCH, DELETE } = createDecoAdminRouteHandlers({
 *     site: "my-site",
 *   });
 *
 * (PATCH and DELETE are required by `/fs/file/*`; harmless to re-export from
 *  read-only routes — the dispatcher branches on method internally.)
 *
 * For one-off mounting without a config module, `handleDecoAdminRoute` is the
 * pre-instantiated default. It reads `DECO_SITE` from the environment for JWT
 * validation; if you need richer options, use `createDecoAdminRoute` or
 * `createDecoAdminRouteHandlers`.
 *
 * Disabled groups return 404 (looks like the route doesn't exist).
 * `/volumes/<id>/files` returns 501 — the WebSocket flow is TanStack-only.
 */

// Lazy construction so a consumer importing this module without
// `DECO_SITE` set yet (e.g. before .env load completes in some setups)
// does not crash at import time — the auth-gated `adminProtocol` group
// defaults on and would throw from `createDecoAdminRoute`.
//
// NOTE: The handler is created per-call (not cached) so that callers
// starting up before their .env is loaded still work: the first *request*
// sees the fully-populated environment, not the module-init snapshot.
export const handleDecoAdminRoute: (req: Request) => Promise<Response> = (req) =>
  createDecoAdminRoute({ site: process.env.DECO_SITE })(req);

export { createDecoAdminRoute };
export type { DecoAdminRouteOptions };
