import { getRevision } from "../cms/loader";

/**
 * Web-standard readiness probe. Returns 200 once `setBlocks()` has been called
 * at least once (the block registry is hydrated and the storefront can serve
 * resolved pages), 503 otherwise.
 *
 * Suitable for k8s readinessProbe / Cloud Run health checks / our own infra.
 * Intentionally no CORS — readiness probes are intra-cluster.
 */
export function handleDecoReadiness(): Response {
  const ready = getRevision() !== null;
  return new Response(ready ? "ready" : "not ready", {
    status: ready ? 200 : 503,
    headers: { "Content-Type": "text/plain" },
  });
}
