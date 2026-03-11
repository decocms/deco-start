/**
 * Factory for creating a cache-aware Cloudflare Worker entry.
 *
 * Wraps a TanStack Start server entry with:
 * - Cloudflare Cache API integration (edge caching)
 * - Device-specific cache keys (mobile/desktop split)
 * - Per-URL cache profile detection via detectCacheProfile()
 * - Immutable caching for fingerprinted static assets
 * - Cache purge API endpoint
 * - Protection against accidental caching of private/search paths
 *
 * @example
 * ```ts
 * // src/worker-entry.ts
 * import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
 * import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
 *
 * const serverEntry = createServerEntry({
 *   async fetch(request) {
 *     return await handler.fetch(request);
 *   },
 * });
 *
 * export default createDecoWorkerEntry(serverEntry);
 * ```
 */

import { getRenderShellConfig } from "../admin/setup";
import {
  type CacheProfile,
  cacheHeaders,
  detectCacheProfile,
  getCacheProfileConfig,
} from "./cacheHeaders";
import { cleanPathForCacheKey } from "./urlUtils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal ExecutionContext interface compatible with Cloudflare Workers.
 * Defined here so deco-start doesn't need @cloudflare/workers-types.
 */
interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ServerEntry {
  fetch(
    request: Request,
    env: Record<string, unknown>,
    ctx: WorkerExecutionContext,
  ): Response | Promise<Response>;
}

/**
 * Segment dimensions used to differentiate cache entries.
 *
 * The workerEntry calls `buildSegment` (if provided) to extract these
 * from the request. Two requests with the same SegmentKey share a
 * cache entry; different segments get different cached responses.
 */
export interface SegmentKey {
  device: "mobile" | "desktop";
  /** Whether the user is logged in (e.g., has a valid auth cookie). */
  loggedIn?: boolean;
  /** Commerce sales channel / price list. */
  salesChannel?: string;
  /** Sorted list of active A/B flag names for cache cohort splitting. */
  flags?: string[];
}

/**
 * Admin route handlers injected by the site's worker-entry.ts.
 * Kept as a runtime option so the imports only exist in the SSR entry
 * (not pulled into the client Vite build).
 */
export interface AdminHandlers {
  handleMeta: (request: Request) => Response;
  handleDecofileRead: () => Response;
  handleDecofileReload: (request: Request) => Response | Promise<Response>;
  handleRender: (request: Request) => Response | Promise<Response>;
  corsHeaders: (request: Request) => Record<string, string>;
}

export interface DecoWorkerEntryOptions {
  /**
   * Admin route handlers (/live/_meta, /.decofile, /live/previews).
   * Pass the handlers from `@decocms/start/admin` here.
   * If not provided, admin routes are not handled.
   */
  admin?: AdminHandlers;

  /**
   * Override the default cache profile detection.
   * Return `null` to fall through to the built-in detector.
   */
  detectProfile?: (url: URL) => CacheProfile | null;

  /**
   * Whether to create device-specific cache keys (mobile vs desktop).
   * Useful when server-rendered HTML differs by device.
   * @default true
   */
  deviceSpecificKeys?: boolean;

  /**
   * Build a full segment key from the incoming request.
   *
   * When provided, the segment key replaces the simple device-only
   * cache key with a richer key that differentiates by login state,
   * sales channel, and A/B flags.
   *
   * Logged-in segments (`loggedIn: true`) automatically bypass the
   * cache (the response is fetched fresh every time).
   *
   * @example
   * ```ts
   * import { extractVtexContext } from "@decocms/apps/vtex/middleware";
   *
   * createDecoWorkerEntry(serverEntry, {
   *   buildSegment: (request) => {
   *     const vtx = extractVtexContext(request);
   *     return {
   *       device: /mobile|android|iphone/i.test(request.headers.get("user-agent") ?? "") ? "mobile" : "desktop",
   *       loggedIn: vtx.isLoggedIn,
   *       salesChannel: vtx.salesChannel,
   *     };
   *   },
   * });
   * ```
   */
  buildSegment?: (request: Request) => SegmentKey;

  /**
   * Environment variable name holding the cache purge token.
   * Set to `false` to disable the purge endpoint.
   * @default "PURGE_TOKEN"
   */
  purgeTokenEnv?: string | false;

  /**
   * Paths that should always bypass the edge cache, even if the
   * profile detector would otherwise cache them.
   * Defaults include `/_server`, `/_build`, `/assets`, `/deco/`.
   */
  bypassPaths?: string[];

  /**
   * Additional paths (beyond the defaults) that should bypass caching.
   * Merged with the default bypass paths.
   */
  extraBypassPaths?: string[];

  /**
   * Custom HTML shell for the `/live/previews` iframe page.
   * If not provided, a shell is generated from the render config
   * (theme, CSS, fonts) set via setRenderShell().
   */
  previewShell?: string;

  /**
   * Regex for detecting fingerprinted static assets (content-hashed filenames).
   * Matched paths get `immutable, max-age=31536000`.
   * @default /\/_build\/assets\/.*-[a-zA-Z0-9]{8,}\.\w+$/
   */
  fingerprintedAssetPattern?: RegExp;

  /**
   * Whether to strip UTM and tracking params from cache keys.
   * Two requests differing only in utm_source, fbclid, etc.
   * will share the same cache entry.
   * @default true
   */
  stripTrackingParams?: boolean;

  /**
   * Optional proxy handler for commerce backend routes
   * (checkout, account, API, login, etc.).
   *
   * Called early in the request pipeline — after admin routes and cache
   * purge, but before static assets and edge cache logic. This ensures
   * proxy requests never hit TanStack Start or the React SSR pipeline.
   *
   * Return a `Response` to proxy the request, or `null` to let the
   * normal TanStack Start flow handle it.
   *
   * @example
   * ```ts
   * import { shouldProxyToVtex, proxyToVtex } from "@decocms/apps/vtex/utils/proxy";
   *
   * createDecoWorkerEntry(serverEntry, {
   *   proxyHandler: (request, url) => {
   *     if (shouldProxyToVtex(url.pathname)) {
   *       return proxyToVtex(request);
   *     }
   *     return null;
   *   },
   * });
   * ```
   */
  proxyHandler?: (request: Request, url: URL) => Promise<Response | null> | Response | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREVIEW_SHELL_SCRIPT = `(function() {
    if (window.__DECO_LIVE_CONTROLS__) return;
    window.__DECO_LIVE_CONTROLS__ = true;
    addEventListener("message", function(event) {
      var data = event.data;
      if (!data || typeof data !== "object") return;
      switch (data.type) {
        case "editor::inject":
          if (data.args && data.args.script) {
            try { eval(data.args.script); } catch(e) { console.error("[deco] inject error:", e); }
          }
          break;
      }
    });
  })();`;

function buildPreviewShell(): string {
  const { cssHref, fontHrefs, themeName, bodyClass, htmlLang } = getRenderShellConfig();

  const themeAttr = themeName ? ` data-theme="${themeName}"` : "";
  const langAttr = htmlLang ? ` lang="${htmlLang}"` : "";
  const bodyAttr = bodyClass ? ` class="${bodyClass}"` : "";

  const stylesheets = [
    ...fontHrefs.map((href) => `<link rel="stylesheet" href="${href}" />`),
    cssHref ? `<link rel="stylesheet" href="${cssHref}" />` : "",
  ]
    .filter(Boolean)
    .join("\n    ");

  return `<!DOCTYPE html>
<html${langAttr}${themeAttr}>
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Preview</title>
    ${stylesheets}
    <script>${PREVIEW_SHELL_SCRIPT}</script>
</head>
<body${bodyAttr}>
    <div id="preview-root" style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui;color:#666;">
        Loading preview...
    </div>
</body>
</html>`;
}

const MOBILE_RE = /mobile|android|iphone|ipad|ipod/i;
const ONE_YEAR = 31536000;

const DEFAULT_BYPASS_PATHS = ["/_server", "/_build", "/deco/", "/live/", "/.decofile"];

const FINGERPRINTED_ASSET_RE = /(?:\/_build)?\/assets\/.*-[a-zA-Z0-9_-]{8,}\.\w+$/;

const IMMUTABLE_HEADERS: Record<string, string> = {
  "Cache-Control": `public, max-age=${ONE_YEAR}, immutable`,
  Vary: "Accept-Encoding",
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a Cloudflare Worker fetch handler that wraps a TanStack Start
 * server entry with intelligent edge caching.
 */
export function createDecoWorkerEntry(
  serverEntry: ServerEntry,
  options: DecoWorkerEntryOptions = {},
): {
  fetch(
    request: Request,
    env: Record<string, unknown>,
    ctx: WorkerExecutionContext,
  ): Promise<Response>;
} {
  const {
    admin,
    detectProfile: customDetect,
    deviceSpecificKeys = true,
    buildSegment,
    purgeTokenEnv = "PURGE_TOKEN",
    bypassPaths,
    extraBypassPaths = [],
    fingerprintedAssetPattern = FINGERPRINTED_ASSET_RE,
    stripTrackingParams: shouldStripTracking = true,
    previewShell: customPreviewShell,
  } = options;

  const allBypassPaths = [...(bypassPaths ?? DEFAULT_BYPASS_PATHS), ...extraBypassPaths];

  // -- Helpers ----------------------------------------------------------------

  function isBypassPath(pathname: string): boolean {
    return allBypassPaths.some((bp) => pathname.startsWith(bp));
  }

  function isStaticAsset(pathname: string): boolean {
    return fingerprintedAssetPattern.test(pathname);
  }

  function isCacheable(request: Request, url: URL): boolean {
    if (request.method !== "GET") return false;
    if (isBypassPath(url.pathname)) return false;
    if (url.searchParams.has("__deco_draft")) return false;
    if (url.searchParams.has("__deco_preview")) return false;
    if (url.searchParams.has("pathTemplate")) return false;
    return true;
  }

  function getProfile(url: URL): CacheProfile {
    if (customDetect) {
      const custom = customDetect(url);
      if (custom !== null) return custom;
    }
    return detectCacheProfile(url);
  }

  function hashSegment(seg: SegmentKey): string {
    const parts: string[] = [seg.device];
    if (seg.loggedIn) parts.push("auth");
    if (seg.salesChannel) parts.push(`sc=${seg.salesChannel}`);
    if (seg.flags?.length) parts.push(`f=${seg.flags.sort().join(",")}`);
    return parts.join("|");
  }

  function buildCacheKey(request: Request): { key: Request; segment?: SegmentKey } {
    const url = new URL(request.url);

    if (shouldStripTracking) {
      const cleanPath = cleanPathForCacheKey(url.toString());
      const cleanUrl = new URL(cleanPath, url.origin);
      url.search = cleanUrl.search;
    }

    if (buildSegment) {
      const segment = buildSegment(request);
      url.searchParams.set("__seg", hashSegment(segment));
      return { key: new Request(url.toString(), { method: "GET" }), segment };
    }

    if (deviceSpecificKeys) {
      const device = MOBILE_RE.test(request.headers.get("user-agent") ?? "") ? "mobile" : "desktop";
      url.searchParams.set("__cf_device", device);
    }

    return { key: new Request(url.toString(), { method: "GET" }) };
  }

  // -- Purge handler ----------------------------------------------------------

  async function handlePurge(request: Request, env: Record<string, unknown>): Promise<Response> {
    if (purgeTokenEnv === false) {
      return new Response("Purge disabled", { status: 404 });
    }

    const token = (env[purgeTokenEnv] as string) || "";
    if (!token || request.headers.get("Authorization") !== `Bearer ${token}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    let body: { paths?: string[] };
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    const paths = body.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      return new Response('Body must include "paths": ["/", "/page"]', { status: 400 });
    }

    const cache =
      typeof caches !== "undefined"
        ? ((caches as unknown as { default?: Cache }).default ?? null)
        : null;

    if (!cache) {
      return Response.json({ purged: [], total: 0, note: "Cache API unavailable" });
    }

    const baseUrl = new URL(request.url).origin;
    const purged: string[] = [];

    // If using segment-based keys, purge requires known segment combos.
    // For simplicity, purge common combos: both devices, default sales channel.
    const segments: SegmentKey[] = buildSegment
      ? [
          { device: "mobile" },
          { device: "desktop" },
          { device: "mobile", salesChannel: "1" },
          { device: "desktop", salesChannel: "1" },
        ]
      : [];

    for (const p of paths) {
      if (buildSegment && segments.length > 0) {
        for (const seg of segments) {
          const url = new URL(p, baseUrl);
          url.searchParams.set("__seg", hashSegment(seg));
          const key = new Request(url.toString(), { method: "GET" });
          try {
            if (await cache.delete(key)) {
              purged.push(`${p} (${hashSegment(seg)})`);
            }
          } catch {
            /* ignore */
          }
        }
      } else {
        const devices = deviceSpecificKeys ? (["mobile", "desktop"] as const) : ([null] as const);

        for (const device of devices) {
          const url = new URL(p, baseUrl);
          if (device) url.searchParams.set("__cf_device", device);
          const key = new Request(url.toString(), { method: "GET" });
          try {
            if (await cache.delete(key)) {
              purged.push(device ? `${p} (${device})` : p);
            }
          } catch {
            /* ignore */
          }
        }
      }
    }

    return Response.json({ purged, total: purged.length });
  }

  // -- Admin route handler ---------------------------------------------------

  const ADMIN_NO_CACHE: Record<string, string> = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "CDN-Cache-Control": "no-store",
    "Surrogate-Control": "no-store",
  };

  function addCors(response: Response, request: Request): Response {
    if (!admin) return response;
    const cors = admin.corsHeaders(request);
    const resp = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
    for (const [k, v] of Object.entries({ ...cors, ...ADMIN_NO_CACHE })) {
      resp.headers.set(k, v);
    }
    return resp;
  }

  async function tryAdminRoute(request: Request): Promise<Response | null> {
    if (!admin) return null;

    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname === "/live/_meta") {
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { ...admin.corsHeaders(request), ...ADMIN_NO_CACHE },
        });
      }
      return addCors(admin.handleMeta(request), request);
    }

    if (pathname === "/.decofile") {
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { ...admin.corsHeaders(request), ...ADMIN_NO_CACHE },
        });
      }
      if (method === "POST") {
        return addCors(await admin.handleDecofileReload(request), request);
      }
      return addCors(admin.handleDecofileRead(), request);
    }

    if (pathname === "/deco/_liveness") {
      return new Response("OK", {
        status: 200,
        headers: { "Content-Type": "text/plain", ...ADMIN_NO_CACHE },
      });
    }

    if ((pathname === "/live/previews" || pathname === "/live/previews/") && method === "GET") {
      const shell = customPreviewShell ?? buildPreviewShell();
      return new Response(shell, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          ...admin.corsHeaders(request),
          ...ADMIN_NO_CACHE,
        },
      });
    }

    if (pathname.startsWith("/live/previews/") && pathname !== "/live/previews/") {
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { ...admin.corsHeaders(request), ...ADMIN_NO_CACHE },
        });
      }
      return addCors(await admin.handleRender(request), request);
    }

    return null;
  }

  // -- Main fetch handler -----------------------------------------------------

  return {
    async fetch(
      request: Request,
      env: Record<string, unknown>,
      ctx: WorkerExecutionContext,
    ): Promise<Response> {
      const url = new URL(request.url);

      // Admin routes (/_meta, /.decofile, /live/previews) — always handled first
      const adminResponse = await tryAdminRoute(request);
      if (adminResponse) return adminResponse;

      // Purge endpoint
      if (url.pathname === "/_cache/purge" && request.method === "POST") {
        return handlePurge(request, env);
      }

      // Commerce proxy (checkout, account, API, etc.)
      if (options.proxyHandler) {
        const proxyResponse = await options.proxyHandler(request, url);
        if (proxyResponse) return proxyResponse;
      }

      // Static fingerprinted assets — serve from origin with immutable headers
      if (isStaticAsset(url.pathname)) {
        const origin = await serverEntry.fetch(request, env, ctx);
        if (origin.status === 200) {
          const ct = origin.headers.get("content-type") ?? "";
          if (ct.includes("text/html")) {
            return new Response("Not Found", { status: 404 });
          }
          const resp = new Response(origin.body, origin);
          for (const [k, v] of Object.entries(IMMUTABLE_HEADERS)) {
            resp.headers.set(k, v);
          }
          return resp;
        }
        return origin;
      }

      // Non-cacheable requests — pass through but protect against accidental caching
      if (!isCacheable(request, url)) {
        const origin = await serverEntry.fetch(request, env, ctx);
        const profile = getProfile(url);

        // If the profile is private/none/cart, strip any public cache headers
        // the route may have set (prevents the search caching bug)
        if (profile === "private" || profile === "none" || profile === "cart") {
          const resp = new Response(origin.body, origin);
          resp.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
          resp.headers.delete("CDN-Cache-Control");
          return resp;
        }

        return origin;
      }

      // Cacheable request — build segment-aware cache key
      const { key: cacheKey, segment } = buildCacheKey(request);

      // Logged-in users always bypass the cache (personalized content)
      if (segment?.loggedIn) {
        const origin = await serverEntry.fetch(request, env, ctx);
        const resp = new Response(origin.body, origin);
        resp.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
        resp.headers.set("X-Cache", "BYPASS");
        resp.headers.set("X-Cache-Reason", "logged-in");
        return resp;
      }

      // Check Cache API (may not be available in local dev / miniflare)
      const cache =
        typeof caches !== "undefined"
          ? ((caches as unknown as { default?: Cache }).default ?? null)
          : null;

      if (cache) {
        try {
          const cached = await cache.match(cacheKey);
          if (cached) {
            const hit = new Response(cached.body, cached);
            hit.headers.set("X-Cache", "HIT");
            if (segment) hit.headers.set("X-Cache-Segment", hashSegment(segment));
            return hit;
          }
        } catch {
          // Cache API unavailable in this environment — proceed without cache
        }
      }

      // Cache MISS — fetch from origin
      const origin = await serverEntry.fetch(request, env, ctx);

      if (origin.status !== 200) {
        return origin;
      }

      // Determine the right cache profile for this URL
      const profile = getProfile(url);
      const profileConfig = getCacheProfileConfig(profile);

      // Don't cache non-public profiles
      if (!profileConfig.isPublic || profileConfig.sMaxAge === 0) {
        const resp = new Response(origin.body, origin);
        resp.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
        return resp;
      }

      const headers = cacheHeaders(profile);

      const toReturn = new Response(origin.body, {
        status: origin.status,
        statusText: origin.statusText,
        headers: new Headers(origin.headers),
      });

      // Apply profile-specific cache headers for the client response
      for (const [k, v] of Object.entries(headers)) {
        toReturn.headers.set(k, v);
      }
      toReturn.headers.set("X-Cache", "MISS");
      toReturn.headers.set("X-Cache-Profile", profile);
      if (segment) toReturn.headers.set("X-Cache-Segment", hashSegment(segment));

      // For Cache API storage, use sMaxAge as max-age since the Cache API
      // ignores s-maxage and only respects max-age for TTL decisions.
      if (cache) {
        try {
          const toStore = toReturn.clone();
          toStore.headers.set("Cache-Control", `public, max-age=${profileConfig.sMaxAge}`);
          ctx.waitUntil(cache.put(cacheKey, toStore));
        } catch {
          // Cache API unavailable — skip storing
        }
      }

      return toReturn;
    },
  };
}
