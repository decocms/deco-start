/**
 * Liveness probe handler.
 *
 * Responds to `/_liveness` with a 200 OK so load balancers and
 * orchestrators (K8s, Cloudflare health checks) know the instance is alive.
 */
export function handleLiveness(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname === "/_liveness") {
    return new Response("OK", {
      status: 200,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    });
  }
  return null;
}
