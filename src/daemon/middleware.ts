/**
 * Daemon middleware — intercepts x-daemon-api requests, applies auth,
 * and routes to volumes API or watch SSE.
 *
 * Admin runtime routes (/live/_meta, /.decofile) are NOT handled here —
 * they fall through to Vite SSR (worker-entry.ts) where setMetaData()
 * and setBlocks() have populated shared state. The daemon middleware loads
 * modules via native import() which creates separate module instances.
 *
 * Ported from: deco-cx/deco daemon/daemon.ts
 */
import type { IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import { createAuthMiddleware } from "./auth.ts";
import { createFSHandler } from "./fs.ts";
import { createVolumesHandler } from "./volumes.ts";
import { createWatchHandler, watchFS } from "./watch.ts";

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

  // FS REST API handler (/fs/file/* — read, patch, delete)
  const fs = createFSHandler();

  // SSE watch handler — lazy port resolver for /live/_meta fetch
  const watch = createWatchHandler({
    getPort: () => {
      const addr = httpServer?.address();
      return typeof addr === "object" && addr ? addr.port : 5173;
    },
  });

  // Wire Vite's file watcher to the broadcast channel
  watchFS(opts.server.watcher);

  // Version reported to admin.deco.cx — must satisfy admin's minimum version check.
  // Admin compares against deco-cx/deco versions (e.g. 1.177.x), not @decocms/start versions.
  const VERSION = "1.177.5";

  return (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): void => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      pathname = req.url ?? "/";
    }

    // Healthcheck — no auth required, admin uses this to verify env is reachable
    if (pathname === "/_healthcheck") {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end(VERSION);
      return;
    }

    // Admin runtime routes (/live/_meta, /.decofile) are NOT handled here.
    // They fall through to Vite SSR (worker-entry.ts / TanStack routes) where
    // setMetaData() and setBlocks() have already populated the shared state.
    // The daemon middleware loads modules via native import() which creates
    // separate module instances from Vite SSR — they don't share state.

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
      // FS REST API: /fs/file/* (read, patch, delete .deco/ files)
      if (pathname.startsWith("/fs/")) {
        fs(req, res, next);
        return;
      }

      // Volumes API: /volumes/:id/files/*
      if (pathname.includes("/volumes/") && pathname.includes("/files") && volumes) {
        volumes(req, res, next);
        return;
      }

      // SSE watch: /watch or root /
      if (pathname === "/watch" || pathname === "/") {
        watch(req, res, next);
        return;
      }

      // Everything else falls through to Vite/TanStack admin routes
      // (e.g., /live/_meta, /.decofile, /live/previews, /deco/invoke)
      next();
    });
  };
}
