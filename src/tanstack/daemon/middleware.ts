/**
 * Daemon middleware — Connect-style entry point used by Vite's middleware
 * stack.
 *
 * All HTTP-shape routes (probes, fs, watch, admin protocol) are composed by
 * `createDecoAdminRoute` from `src/node/daemon/route.ts` and wrapped via
 * `toNodeMiddleware`. The volumes WebSocket binding stays in this file
 * because it needs `httpServer.on("upgrade")`, which is not expressible via
 * Request → Response.
 */
import type { IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import { createAuthMiddleware } from "./auth";
import {
  createDecoAdminRoute,
  type DecoAdminRouteOptions,
} from "../../node/daemon/route";
import { toNodeMiddleware } from "../../node/daemon/nodeHttpAdapter";
import { bindWatcherToChannel } from "../../node/daemon/watcher";
import { createVolumesHandler } from "./volumes";

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
  /**
   * Optional per-group toggles, forwarded to createDecoAdminRoute.
   * Site is taken from the top-level `site` field; the watch port defaults
   * to the Vite httpServer's bound port.
   */
  routes?: Omit<DecoAdminRouteOptions, "site" | "getPort">;
}

export function createDaemonMiddleware(opts: DaemonOptions) {
  const auth = createAuthMiddleware(opts.site);
  const httpServer = opts.server.httpServer;

  // Volumes still owns its httpServer.on("upgrade") binding — not portable.
  const volumes = httpServer
    ? createVolumesHandler({ httpServer, watcher: opts.server.watcher })
    : null;

  // Vite's watcher feeds the shared broadcast channel.
  bindWatcherToChannel(opts.server.watcher);

  const webRouteHandler = createDecoAdminRoute({
    site: opts.site,
    getPort: () => {
      const addr = httpServer?.address();
      return typeof addr === "object" && addr ? addr.port : 5173;
    },
    // Vite already provides the watcher via `bindWatcherToChannel` above;
    // skip the Next-style lazy chokidar singleton so we don't double-watch.
    manageWatcher: false,
    ...opts.routes,
  });

  const webMiddleware = toNodeMiddleware(async (req) => {
    // All routes delegate to the Web-standard dispatcher. Volumes paths return
    // 501 from createDecoAdminRoute (TanStack handles them via the volumes
    // branch above); anything unrecognised gets a 404 — no null fall-through.
    return webRouteHandler(req);
  });

  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      pathname = req.url ?? "/";
    }

    // Probes — no auth, no x-daemon-api header required.
    if (pathname === "/_healthcheck" || pathname === "/_ready") {
      webMiddleware(req, res, next);
      return;
    }

    const isDaemonAPI =
      req.headers[DAEMON_API_SPECIFIER] ??
      req.headers[HYPERVISOR_API_SPECIFIER] ??
      false;

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

    // CORS for admin.deco.cx.
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-daemon-api, x-hypervisor-api");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth before any /fs/*, /watch, /volumes/*, admin protocol routes.
    auth(req, res, () => {
      // Volumes API — TanStack-only, requires raw httpServer.
      if (pathname.includes("/volumes/") && pathname.includes("/files") && volumes) {
        volumes(req, res, next);
        return;
      }
      // All other HTTP-shape routes flow through the Web-standard dispatcher.
      webMiddleware(req, res, next);
    });
  };
}
