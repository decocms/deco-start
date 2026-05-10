/**
 * Liveness and readiness probe handlers.
 *
 * - `/_liveness` — simple 200 OK for load balancers (K8s, Cloudflare)
 * - `/deco/_health` — detailed JSON health metrics (delegated to healthMetrics)
 */

import { handleHealthCheck } from "./healthMetrics";

export function handleLiveness(request: Request): Response | null {
  const url = new URL(request.url);

  if (url.pathname === "/_liveness" || url.pathname === "/deco/_liveness") {
    return new Response("OK", {
      status: 200,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    });
  }

  return handleHealthCheck(request);
}
