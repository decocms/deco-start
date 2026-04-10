/**
 * Daemon middleware — intercepts x-daemon-api requests, applies auth,
 * and routes to volumes API or watch SSE.
 *
 * Ported from: deco-cx/deco daemon/daemon.ts
 */
import type { IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import { createAuthMiddleware } from "./auth";
import { createVolumesHandler } from "./volumes";
import { createWatchHandler, watchFS } from "./watch";

const DAEMON_API_SPECIFIER = "x-daemon-api";
const HYPERVISOR_API_SPECIFIER = "x-hypervisor-api";

export interface DaemonOptions {
  /** Site name for JWT validation. */
  site: string;
  /** Vite dev server instance. */
  server: {
    httpServer: HttpServer | null;
    watcher: { on(event: string, cb: (...args: unknown[]) => void): void };
  };
}

// Creates a Connect-style middleware that:
// 1. Checks for x-daemon-api or x-hypervisor-api header
// 2. Applies JWT auth
// 3. Routes to volumes API or SSE watch
// 4. Falls through to Vite for other daemon requests (admin routes)
export function createDaemonMiddleware(opts: DaemonOptions) {
  const auth = createAuthMiddleware(opts.site);
  const httpServer = opts.server.httpServer;

  // Volumes handler (includes WebSocket upgrade registration)
  const volumes = httpServer
    ? createVolumesHandler({
        httpServer,
        watcher: opts.server.watcher,
      })
    : null;

  // SSE watch handler
  const watch = createWatchHandler();

  // Wire Vite's file watcher to the broadcast channel
  watchFS(opts.server.watcher);

  return (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): void => {
    const isDaemonAPI =
      req.headers[DAEMON_API_SPECIFIER] ??
      req.headers[HYPERVISOR_API_SPECIFIER] ??
      false;

    // Also check query param: ?x-daemon-api=true
    if (!isDaemonAPI) {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.searchParams.get(DAEMON_API_SPECIFIER) !== "true") {
          next();
          return;
        }
      } catch {
        next();
        return;
      }
    }

    // Add CORS headers for admin.deco.cx
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-daemon-api, x-hypervisor-api");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth → then route
    auth(req, res, () => {
      const url = req.url ?? "";

      // Volumes API: /volumes/:id/files/*
      if (url.includes("/volumes/") && url.includes("/files") && volumes) {
        volumes(req, res, next);
        return;
      }

      // SSE watch: /watch or root /
      if (url.includes("/watch") || url === "/" || url === "/?") {
        watch(req, res, next);
        return;
      }

      // Everything else falls through to Vite/TanStack admin routes
      // (e.g., /live/_meta, /.decofile, /live/previews, /deco/invoke)
      next();
    });
  };
}
