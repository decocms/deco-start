import { handleDecofileRead, handleDecofileReload } from "../core/admin/decofile";
import { handleInvoke } from "../core/admin/invoke";
import { handleMeta } from "../core/admin/meta";
import { handleRender } from "../core/admin/render";

/**
 * Dispatch a Next.js App Router request to the appropriate Deco admin handler.
 *
 * Wire as both GET and POST in `app/[[...catchall]]/route.ts` (or in dedicated
 * route handlers under `app/live/_meta/route.ts`, `app/.decofile/route.ts`,
 * etc.). This adapter layer just inspects `request.url` and delegates to the
 * core handler for the matching path. CORS is the caller's responsibility.
 *
 * Returns a 404 `Response` for non-admin paths so the caller can fall through
 * to its normal page rendering.
 */
export async function handleDecoAdminRoute(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (pathname === "/live/_meta") {
    return handleMeta(req);
  }

  if (pathname === "/.decofile") {
    if (method === "POST") return await handleDecofileReload(req);
    return handleDecofileRead();
  }

  if (pathname === "/deco/render" || pathname.startsWith("/live/previews/")) {
    return await handleRender(req);
  }

  if (pathname === "/deco/invoke" || pathname.startsWith("/deco/invoke/")) {
    return await handleInvoke(req);
  }

  return new Response("Not Found", { status: 404 });
}
