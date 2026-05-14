import { handleDecofileRead, handleDecofileReload } from "../../core/admin/decofile";
import { handleInvoke } from "../../core/admin/invoke";
import { handleMeta } from "../../core/admin/meta";
import { handleRender } from "../../core/admin/render";
import { handleDecoReadiness } from "../../core/admin/readiness";
import { requireAdminJwt } from "./auth";
import { handleFsRequest } from "./fs";
import { handleDecoHealthcheck } from "./healthcheck";
import { handleWatchSse } from "./watch-sse";

export interface DecoAdminRouteOptions {
  /** Master switch — false short-circuits everything to 404. */
  enabled?: boolean;
  /** Hosting probe `/_healthcheck`. Default: true. */
  healthcheck?: boolean;
  /** Hosting probe `/_ready`. Default: true. */
  readiness?: boolean;
  /** Admin protocol (`/live/_meta`, `/.decofile`, `/deco/*`, `/live/previews/*`). Default: true. */
  adminProtocol?: boolean;
  /** Dev tooling SSE (`/_watch`, `/watch`). Default: NODE_ENV !== "production". */
  watch?: boolean;
  /** Dev tooling JSON-patch FS (`/fs/*`). Default: NODE_ENV !== "production". */
  fs?: boolean;
  /** Filesystem root for fs + watch handlers. Default: process.cwd(). */
  cwd?: string;
  /**
   * Site name for JWT validation. Required when any auth-gated group
   * (`adminProtocol`, `watch`, or `fs`) is enabled.
   */
  site?: string;
  /** Watch handler's loopback meta-info port resolver. Default: () => 5173. */
  getPort?: () => number;
  /**
   * Lazily create + bind a chokidar watcher on the first /watch or /fs/* request
   * when watch or fs is enabled. Default: true.
   *
   * Set to `false` on the TanStack/Vite path — Vite already provides the watcher
   * via `bindWatcherToChannel`. Two watchers on the same tree work but waste
   * inotify handles.
   */
  manageWatcher?: boolean;
  /**
   * Hook awaited once per request before any pathname dispatch — including
   * before route-group enable checks. Use it for prerequisites that must run
   * before any admin handler reads shared state (the most common case:
   * `await ensureSetup()` so `setBlocks` has populated the block registry
   * before `handleMeta` / `handleDecofileRead` / `handleDecoReadiness` look
   * at it).
   *
   * Returning `undefined` (the default) continues to the dispatcher.
   * Returning a `Response` short-circuits the request — useful for custom
   * auth, maintenance-mode responses, or any early-out the consumer needs
   * before the daemon's own dispatch runs.
   */
  onRequest?: (req: Request) => void | Response | Promise<void | Response>;
}

interface ResolvedOptions {
  enabled: boolean;
  healthcheck: boolean;
  readiness: boolean;
  adminProtocol: boolean;
  watch: boolean;
  fs: boolean;
  cwd: string;
  site?: string;
  getPort: () => number;
  manageWatcher: boolean;
  onRequest?: (req: Request) => void | Response | Promise<void | Response>;
}

function resolve(opts: DecoAdminRouteOptions): ResolvedOptions {
  const isProd = process.env.NODE_ENV === "production";
  const resolved: ResolvedOptions = {
    enabled: opts.enabled ?? true,
    healthcheck: opts.healthcheck ?? true,
    readiness: opts.readiness ?? true,
    adminProtocol: opts.adminProtocol ?? true,
    watch: opts.watch ?? !isProd,
    fs: opts.fs ?? !isProd,
    cwd: opts.cwd ?? process.cwd(),
    site: opts.site,
    getPort: opts.getPort ?? (() => 5173),
    manageWatcher: opts.manageWatcher ?? true,
    onRequest: opts.onRequest,
  };
  const authGroupActive =
    resolved.enabled && (resolved.adminProtocol || resolved.watch || resolved.fs);
  if (authGroupActive && !resolved.site) {
    throw new Error(
      "createDecoAdminRoute: `site` is required when adminProtocol, watch, or fs is enabled.",
    );
  }
  return resolved;
}

// Lazy chokidar singleton keyed by cwd — created on the first /watch or /fs/*
// request when manageWatcher is enabled. Module-level so two `createDecoAdminRoute`
// calls in the same process share a watcher per cwd.
const watcherSingletons = new Map<string, Promise<{ close: () => Promise<void> }>>();

async function ensureWatcher(cwd: string): Promise<void> {
  if (watcherSingletons.has(cwd)) return;
  // Dynamic import keeps chokidar out of the synchronous module graph for
  // callers that only need probes (e.g. production builds).
  const promise = import("./watcher").then(({ createDecoWatcher }) =>
    createDecoWatcher(cwd),
  );
  watcherSingletons.set(cwd, promise);
  await promise;
}

/**
 * Compose a Web-standard handler for the daemon's full route surface.
 *
 * Each route group can be independently toggled. Disabled groups short-circuit
 * to 404 — callers can't distinguish a disabled deploy from one that never had
 * the route, which keeps the surface honest.
 */
export function createDecoAdminRoute(
  opts: DecoAdminRouteOptions = {},
): (req: Request) => Promise<Response> {
  const cfg = resolve(opts);
  const watcherNeeded =
    cfg.manageWatcher &&
    (cfg.watch || cfg.fs) &&
    process.env.NODE_ENV !== "production";

  return async (req: Request): Promise<Response> => {
    if (!cfg.enabled) return notFound();

    // Per-request hook — runs before pathname dispatch, after the master
    // enabled check. Returning a Response short-circuits; undefined continues.
    if (cfg.onRequest) {
      const early = await cfg.onRequest(req);
      if (early) return early;
    }

    const { pathname } = new URL(req.url);

    // Probes — no auth.
    if (pathname === "/_healthcheck") {
      return cfg.healthcheck ? handleDecoHealthcheck() : notFound();
    }
    if (pathname === "/_ready") {
      return cfg.readiness ? handleDecoReadiness() : notFound();
    }

    // Volumes — TanStack-only (WebSocket). Next-style returns 501.
    if (pathname.includes("/volumes/") && pathname.includes("/files")) {
      if (!cfg.adminProtocol) return notFound();
      return new Response(
        "Volumes WebSocket is not supported in the Next adapter. " +
          "Use the TanStack/Vite daemon for /volumes/<id>/files.",
        { status: 501, headers: { "Content-Type": "text/plain" } },
      );
    }

    // Dev tooling — auth-gated.
    if (pathname === "/_watch" || pathname === "/watch") {
      if (!cfg.watch) return notFound();
      const guard = await requireAdminJwt(req, cfg.site!);
      if (guard) return guard;
      if (watcherNeeded) await ensureWatcher(cfg.cwd);
      return handleWatchSse(req, { cwd: cfg.cwd, getPort: cfg.getPort });
    }

    if (pathname.startsWith("/fs/")) {
      if (!cfg.fs) return notFound();
      const guard = await requireAdminJwt(req, cfg.site!);
      if (guard) return guard;
      if (watcherNeeded) await ensureWatcher(cfg.cwd);
      return handleFsRequest(req, { cwd: cfg.cwd });
    }

    // Admin protocol — handlers self-authenticate today (see src/core/admin/*).
    if (cfg.adminProtocol) {
      if (pathname === "/live/_meta") return handleMeta(req);
      if (pathname === "/.decofile") {
        return req.method === "POST" ? handleDecofileReload(req) : handleDecofileRead();
      }
      if (pathname === "/deco/render" || pathname.startsWith("/live/previews/")) {
        return handleRender(req);
      }
      if (pathname === "/deco/invoke" || pathname.startsWith("/deco/invoke/")) {
        return handleInvoke(req);
      }
    }

    return notFound();
  };
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}
