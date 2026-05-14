import { ADMIN_COMPAT_VERSION } from "../../core/admin/version";

/**
 * Web-standard `/_healthcheck` handler.
 *
 * Returns the admin-compatibility version (NOT @decocms/start's own version)
 * with the CORS headers admin.deco.cx expects from the daemon endpoint.
 */
export function handleDecoHealthcheck(): Response {
  return new Response(ADMIN_COMPAT_VERSION, {
    status: 200,
    headers: {
      "Content-Type": "text/plain",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
