/**
 * Health metrics collection for request tracking and diagnostics.
 *
 * Provides atomic counters for requests (total, inflight, errors)
 * and a health endpoint with cache stats and uptime.
 *
 * @example
 * ```ts
 * import { trackRequest, getHealthMetrics, handleHealthCheck } from "@decocms/start/middleware/healthMetrics";
 *
 * // In middleware:
 * trackRequest.start();
 * const response = await next();
 * trackRequest.end(response.status);
 * ```
 */

import { getLoaderCacheStats } from "../sdk/cachedLoader";

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

let totalRequests = 0;
let inflightRequests = 0;
let totalErrors = 0;
const startedAt = Date.now();

const statusCounts: Record<string, number> = {};

export const trackRequest = {
  start() {
    totalRequests++;
    inflightRequests++;
  },

  end(status: number) {
    inflightRequests--;
    const bucket = `${Math.floor(status / 100)}xx`;
    statusCounts[bucket] = (statusCounts[bucket] || 0) + 1;
    if (status >= 500) totalErrors++;
  },
};

// ---------------------------------------------------------------------------
// Metrics access
// ---------------------------------------------------------------------------

export interface HealthMetrics {
  uptime: number;
  uptimeHuman: string;
  requests: {
    total: number;
    inflight: number;
    errors: number;
    statusCodes: Record<string, number>;
  };
  cache: {
    entries: number;
    inflight: number;
  };
  memory?: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

export function getHealthMetrics(): HealthMetrics {
  const uptime = Date.now() - startedAt;
  const cacheStats = getLoaderCacheStats();

  const metrics: HealthMetrics = {
    uptime,
    uptimeHuman: formatUptime(uptime),
    requests: {
      total: totalRequests,
      inflight: inflightRequests,
      errors: totalErrors,
      statusCodes: { ...statusCounts },
    },
    cache: cacheStats,
  };

  // Memory info is only available in Node.js / Deno environments
  if (typeof globalThis.process !== "undefined" && globalThis.process.memoryUsage) {
    try {
      const mem = globalThis.process.memoryUsage();
      metrics.memory = {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      };
    } catch {
      // not available in this runtime
    }
  }

  return metrics;
}

// ---------------------------------------------------------------------------
// Health check handler
// ---------------------------------------------------------------------------

/**
 * Handle `/deco/_health` requests with detailed metrics.
 * Returns null for non-matching requests.
 */
export function handleHealthCheck(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== "/deco/_health") return null;

  const metrics = getHealthMetrics();

  return new Response(JSON.stringify(metrics, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
