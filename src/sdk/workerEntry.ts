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

import {
  type CacheProfileName,
  cacheHeaders,
  detectCacheProfile,
  edgeCacheConfig,
  getCacheProfile,
} from "./cacheHeaders";
import { buildHtmlShell } from "./htmlShell";
import { cleanPathForCacheKey } from "./urlUtils";
import { isMobileUA } from "./useDevice";
import { getRenderShellConfig } from "../admin/setup";
import { RequestContext } from "./requestContext";
import { getAppMiddleware } from "./setupApps";
import type { MatcherContext } from "../cms/resolve";
import { resolveDecoPage } from "../cms/resolve";
import { runSectionLoaders } from "../cms/sectionLoaders";

/**
 * Append Link preload headers for CSS and fonts so the browser starts
 * fetching them before parsing HTML. Only applied to HTML responses.
 */
function appendResourceHints(resp: Response): void {
  const ct = resp.headers.get("content-type");
  if (!ct || !ct.includes("text/html")) return;
  const { cssHref, fontHrefs } = getRenderShellConfig();
  if (cssHref) {
    resp.headers.append("Link", `<${cssHref}>; rel=preload; as=style`);
  }
  for (const href of fontHrefs) {
    resp.headers.append("Link", `<${href}>; rel=preload; as=font; crossorigin`);
  }
}

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
  /**
   * VTEX region ID for regionalized pricing/availability.
   * When present, cache entries are segmented per region.
   * Sites without regionalization should omit this field
   * to avoid unnecessary cache fragmentation.
   */
  regionId?: string;
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
  detectProfile?: (url: URL) => CacheProfileName | null;

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
   *       // Include regionId only if the site uses VTEX regionalization.
   *       // When present, cache entries split by region; omit it for
   *       // non-regionalized sites to maximize cache sharing.
   *       regionId: vtx.regionId ?? undefined,
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

  /**
   * Environment variable name holding a build version string.
   * The value is appended to every cache key so each deploy gets its own
   * cache namespace — old entries become orphaned and expire naturally,
   * preventing stale HTML that references old CSS/JS fingerprinted filenames.
   *
   * Set to `false` to disable. When the env var is missing or empty,
   * cache keys remain unversioned (backward-compatible).
   *
   * @default "BUILD_HASH"
   *
   * @example
   * ```yaml
   * # CI: pass git hash to wrangler
   * - run: npx wrangler deploy --var BUILD_HASH:$(git rev-parse --short HEAD)
   * ```
   */
  cacheVersionEnv?: string | false;

  /**
   * Security headers appended to every SSR response (HTML pages).
   * Pass `false` to disable entirely.
   *
   * Default headers: X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
   * Permissions-Policy, X-XSS-Protection, HSTS, Cross-Origin-Opener-Policy.
   *
   * Custom entries are merged with defaults (custom values take precedence).
   *
   * @default DEFAULT_SECURITY_HEADERS
   */
  securityHeaders?: Record<string, string> | false;

  /**
   * Content Security Policy directives (report-only by default).
   * Pass an array of directive strings which are joined with "; ".
   * Pass `false` to omit CSP entirely.
   *
   * @example
   * ```ts
   * csp: [
   *   "default-src 'self'",
   *   "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com",
   *   "img-src 'self' data: https:",
   * ]
   * ```
   */
  csp?: string[] | false;

  /**
   * Automatically inject Cloudflare geo data (country, region, city)
   * as internal cookies on every request so location matchers can read
   * them from MatcherContext.cookies. The cookies are only visible
   * within the Worker — they are never sent to the browser.
   *
   * @default true
   */
  autoInjectGeoCookies?: boolean;
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
  return buildHtmlShell({ script: PREVIEW_SHELL_SCRIPT });
}

// ---------------------------------------------------------------------------
// Cloudflare geo cookie injection
// ---------------------------------------------------------------------------

/**
 * Inject Cloudflare geo data as cookies so matchers (location.ts) can
 * read them from MatcherContext.cookies without relying on request.cf.
 *
 * Call this on the incoming request before passing it to the worker entry.
 * Only needed in production Cloudflare Workers where `request.cf` is populated.
 *
 * @example
 * ```ts
 * export default {
 *   async fetch(request, env, ctx) {
 *     return handler.fetch(injectGeoCookies(request), env, ctx);
 *   }
 * };
 * ```
 */
export function injectGeoCookies(request: Request): Request {
  const cf = (request as unknown as { cf?: Record<string, string> }).cf;
  if (!cf) return request;

  const parts: string[] = [];
  if (cf.region) parts.push(`__cf_geo_region=${encodeURIComponent(cf.region)}`);
  if (cf.country) parts.push(`__cf_geo_country=${encodeURIComponent(cf.country)}`);
  if (cf.city) parts.push(`__cf_geo_city=${encodeURIComponent(cf.city)}`);
  if (cf.latitude) parts.push(`__cf_geo_lat=${encodeURIComponent(cf.latitude)}`);
  if (cf.longitude) parts.push(`__cf_geo_lng=${encodeURIComponent(cf.longitude)}`);
  if (cf.regionCode) parts.push(`__cf_geo_region_code=${encodeURIComponent(cf.regionCode)}`);

  if (!parts.length) return request;

  const existing = request.headers.get("cookie") ?? "";
  const combined = existing ? `${existing}; ${parts.join("; ")}` : parts.join("; ");
  const headers = new Headers(request.headers);
  headers.set("cookie", combined);

  return new Request(request, { headers });
}

const ONE_YEAR = 31536000;

/**
 * Sensible security headers for any production storefront.
 * CSP is intentionally not included — it's site-specific (third-party script domains).
 */
export const DEFAULT_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-XSS-Protection": "1; mode=block",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
};

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
    cacheVersionEnv = "BUILD_HASH",
    securityHeaders: securityHeadersOpt,
    csp: cspOpt,
    autoInjectGeoCookies: geoOpt = true,
  } = options;

  // Build the final security headers map (merged defaults + custom + CSP)
  const secHeaders: Record<string, string> | null = (() => {
    if (securityHeadersOpt === false) return null;
    const base = { ...DEFAULT_SECURITY_HEADERS };
    if (securityHeadersOpt) {
      for (const [k, v] of Object.entries(securityHeadersOpt)) base[k] = v;
    }
    if (cspOpt && cspOpt.length > 0) {
      base["Content-Security-Policy-Report-Only"] = cspOpt.join("; ");
    }
    return base;
  })();

  function applySecurityHeaders(resp: Response): Response {
    if (!secHeaders) return resp;
    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("text/html")) return resp;
    const out = new Response(resp.body, resp);
    for (const [k, v] of Object.entries(secHeaders)) {
      if (!out.headers.has(k)) out.headers.set(k, v);
    }
    return out;
  }

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

  function getProfile(url: URL): CacheProfileName {
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
    if (seg.regionId) parts.push(`r=${seg.regionId}`);
    if (seg.flags?.length) parts.push(`f=${seg.flags.sort().join(",")}`);
    return parts.join("|");
  }

  function buildCacheKey(request: Request, env: Record<string, unknown>): { key: Request; segment?: SegmentKey } {
    const url = new URL(request.url);

    if (shouldStripTracking) {
      const cleanPath = cleanPathForCacheKey(url.toString());
      const cleanUrl = new URL(cleanPath, url.origin);
      url.search = cleanUrl.search;
    }

    if (cacheVersionEnv !== false) {
      const version = (env[cacheVersionEnv] as string) || "";
      if (version) {
        url.searchParams.set("__v", version);
      }
    }

    // Include CF geo data in cache key so location matcher results don't leak
    // across different geos. Applies to both segment and device-based keys.
    const cf = (request as unknown as { cf?: Record<string, string> }).cf;
    if (cf) {
      const geoParts: string[] = [];
      if (cf.country) geoParts.push(cf.country);
      if (cf.region) geoParts.push(cf.region);
      if (cf.city) geoParts.push(cf.city);
      if (geoParts.length) {
        url.searchParams.set("__cf_geo", geoParts.join("|"));
      }
    }

    if (buildSegment) {
      const segment = buildSegment(request);
      url.searchParams.set("__seg", hashSegment(segment));
      return { key: new Request(url.toString(), { method: "GET" }), segment };
    }

    if (deviceSpecificKeys) {
      const device = isMobileUA(request.headers.get("user-agent") ?? "") ? "mobile" : "desktop";
      url.searchParams.set("__cf_device", device);
    }

    return { key: new Request(url.toString(), { method: "GET" }) };
  }

  // -- Purge handler ----------------------------------------------------------

  interface PurgeRequestBody {
    paths?: string[];
    countries?: string[];
    /** Sales channels to include in segment combos. Defaults to ["1"]. */
    salesChannels?: string[];
    /** Region IDs to include in segment combos. Each ID generates additional entries. */
    regionIds?: string[];
  }

  function buildPurgeSegments(body: PurgeRequestBody): SegmentKey[] {
    const devices: Array<"mobile" | "desktop"> = ["mobile", "desktop"];
    const channels = body.salesChannels ?? ["1"];
    const regions: Array<string | undefined> = [undefined, ...(body.regionIds ?? [])];

    const segments: SegmentKey[] = [];
    for (const device of devices) {
      for (const salesChannel of channels) {
        for (const regionId of regions) {
          segments.push({ device, salesChannel, regionId });
        }
      }
      segments.push({ device });
    }
    return segments;
  }

  async function handlePurge(request: Request, env: Record<string, unknown>): Promise<Response> {
    if (purgeTokenEnv === false) {
      return new Response("Purge disabled", { status: 404 });
    }

    const token = (env[purgeTokenEnv] as string) || "";
    if (!token || request.headers.get("Authorization") !== `Bearer ${token}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    let body: PurgeRequestBody;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    const paths = body.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      return new Response('Body must include "paths": ["/", "/page"]', { status: 400 });
    }

    const geoVariants = body.countries ?? [];

    const cache =
      typeof caches !== "undefined"
        ? ((caches as unknown as { default?: Cache }).default ?? null)
        : null;

    if (!cache) {
      return Response.json({ purged: [], total: 0, note: "Cache API unavailable" });
    }

    const baseUrl = new URL(request.url).origin;
    const purged: string[] = [];

    const geoKeys: (string | null)[] = [null, ...geoVariants];

    for (const p of paths) {
      if (buildSegment) {
        const segments = buildPurgeSegments(body);
        for (const seg of segments) {
          for (const cc of geoKeys) {
            const url = new URL(p, baseUrl);
            if (cacheVersionEnv !== false) {
              const version = (env[cacheVersionEnv] as string) || "";
              if (version) url.searchParams.set("__v", version);
            }
            url.searchParams.set("__seg", hashSegment(seg));
            if (cc) url.searchParams.set("__cf_geo", cc);
            const key = new Request(url.toString(), { method: "GET" });
            try {
              if (await cache.delete(key)) {
                const label = cc ? `${p} (${hashSegment(seg)}, ${cc})` : `${p} (${hashSegment(seg)})`;
                purged.push(label);
              }
            } catch {
              /* ignore */
            }
          }
        }
      } else {
        const devices = deviceSpecificKeys ? (["mobile", "desktop"] as const) : ([null] as const);

        for (const device of devices) {
          for (const cc of geoKeys) {
            const url = new URL(p, baseUrl);
            if (cacheVersionEnv !== false) {
              const version = (env[cacheVersionEnv] as string) || "";
              if (version) url.searchParams.set("__v", version);
            }
            if (device) url.searchParams.set("__cf_device", device);
            if (cc) url.searchParams.set("__cf_geo", cc);
            const key = new Request(url.toString(), { method: "GET" });
            try {
              if (await cache.delete(key)) {
                const parts = [device, cc].filter(Boolean).join(", ");
                purged.push(parts ? `${p} (${parts})` : p);
              }
            } catch {
              /* ignore */
            }
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

  const handler = {
    async fetch(
      request: Request,
      env: Record<string, unknown>,
      ctx: WorkerExecutionContext,
    ): Promise<Response> {
      // Inject CF geo data as cookies for location matchers (before anything reads cookies)
      if (geoOpt) {
        request = injectGeoCookies(request);
      }

      // Wrap the entire request in a RequestContext so that all code
      // in the call stack (loaders, invoke handlers, vtexFetchWithCookies)
      // can access the request and write response headers.
      const response = await RequestContext.run(request, async () => {
      // Run app middleware (injects app state into RequestContext.bag,
      // runs registered middleware like VTEX cookie forwarding).
      const appMw = getAppMiddleware();
      if (appMw) {
        return appMw(request, () => handleRequest(request, env, ctx));
      }
      return handleRequest(request, env, ctx);
      });

      return applySecurityHeaders(response);
    },
  };

  return handler;

  async function handleRequest(
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

      // ?asJson — return resolved page data as JSON (legacy deco compat)
      if (url.searchParams.has("asJson") && request.method === "GET") {
        const basePath = url.pathname;
        const cookies: Record<string, string> = {};
        for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
          const [k, ...v] = pair.split("=");
          if (k?.trim()) cookies[k.trim()] = v.join("=").trim();
        }
        const matcherCtx: MatcherContext = {
          userAgent: request.headers.get("user-agent") ?? "",
          url: url.toString(),
          path: basePath,
          cookies,
          request,
        };
        const page = await resolveDecoPage(basePath, matcherCtx);
        if (!page) {
          return Response.json(null, { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
        }
        const enrichedSections = await runSectionLoaders(page.resolvedSections, request);
        const { seoSection: _seo, ...pageData } = page;
        const result = {
          ...pageData,
          resolvedSections: enrichedSections,
        };
        return Response.json(result, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
          },
        });
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

        if (profile === "private" || profile === "none" || profile === "cart") {
          const resp = new Response(origin.body, origin);
          resp.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
          resp.headers.delete("CDN-Cache-Control");
          resp.headers.set("X-Cache", "BYPASS");
          resp.headers.set("X-Cache-Reason", `non-cacheable:${profile}`);
          return resp;
        }

        const resp = new Response(origin.body, origin);
        const reason = request.method !== "GET"
          ? `method:${request.method}`
          : "bypass-path";
        resp.headers.set("X-Cache", "BYPASS");
        resp.headers.set("X-Cache-Reason", reason);
        return resp;
      }

      // Cacheable request — build segment-aware cache key
      const { key: cacheKey, segment } = buildCacheKey(request, env);

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

      const profile = getProfile(url);
      const edgeConfig = edgeCacheConfig(profile);

      // Helper: dress a response with proper client-facing headers
      function dressResponse(resp: Response, xCache: string, extra?: Record<string, string>): Response {
        const out = new Response(resp.body, resp);
        const hdrs = cacheHeaders(profile);
        for (const [k, v] of Object.entries(hdrs)) out.headers.set(k, v);
        out.headers.set("CDN-Cache-Control", "no-store");
        out.headers.set("X-Cache", xCache);
        out.headers.set("X-Cache-Profile", profile);
        if (segment) out.headers.set("X-Cache-Segment", hashSegment(segment));
        if (cacheVersionEnv !== false) {
          const v = (env[cacheVersionEnv] as string) || "";
          if (v) out.headers.set("X-Cache-Version", v);
        }
        if (extra) for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
        appendResourceHints(out);
        return out;
      }

      // Helper: store a response in Cache API with the full retention window
      function storeInCache(resp: Response) {
        if (!cache) return;
        try {
          const storageTtl = edgeConfig.fresh + Math.max(edgeConfig.swr, edgeConfig.sie);
          const toStore = resp.clone();
          toStore.headers.set("Cache-Control", `public, max-age=${storageTtl}`);
          toStore.headers.set("X-Deco-Stored-At", String(Date.now()));
          toStore.headers.delete("CDN-Cache-Control");
          ctx.waitUntil(cache.put(cacheKey, toStore));
        } catch {
          // Cache API unavailable
        }
      }

      // Helper: background revalidation (fetch origin, store result)
      function revalidateInBackground() {
        ctx.waitUntil(
          Promise.resolve(serverEntry.fetch(request, env, ctx)).then((origin) => {
            if (origin.status === 200 && !origin.headers.has("set-cookie")) {
              storeInCache(origin);
            }
          }).catch(() => {
            // Background revalidation failed — stale entry stays until SIE expires
          }),
        );
      }

      // --- Edge cache check with SWR + SIE ---
      let cached: Response | undefined;
      if (cache) {
        try {
          cached = await cache.match(cacheKey) ?? undefined;
        } catch {
          // Cache API unavailable
        }
      }

      if (cached && edgeConfig.isPublic && edgeConfig.fresh > 0) {
        const storedAtStr = cached.headers.get("X-Deco-Stored-At");
        const storedAt = storedAtStr ? Number(storedAtStr) : 0;
        const ageMs = storedAt > 0 ? Date.now() - storedAt : Infinity;
        const ageSec = ageMs / 1000;

        if (ageSec < edgeConfig.fresh) {
          // FRESH HIT — serve immediately
          return dressResponse(cached, "HIT");
        }

        if (ageSec < edgeConfig.fresh + edgeConfig.swr) {
          // STALE-HIT within SWR window — serve stale, revalidate in background
          revalidateInBackground();
          return dressResponse(cached, "STALE-HIT", { "X-Cache-Age": String(Math.round(ageSec)) });
        }

        // Past SWR window but still in cache (within SIE window) — keep reference
        // for potential error fallback below
      }

      // Cache MISS or past SWR window — fetch from origin
      let origin: Response;
      try {
        origin = await serverEntry.fetch(request, env, ctx);
      } catch (err) {
        // Origin fetch threw — SIE fallback if we have a stale entry
        if (cached && edgeConfig.sie > 0) {
          const storedAtStr = cached.headers.get("X-Deco-Stored-At");
          const storedAt = storedAtStr ? Number(storedAtStr) : 0;
          const ageSec = storedAt > 0 ? (Date.now() - storedAt) / 1000 : Infinity;
          if (ageSec < edgeConfig.fresh + edgeConfig.sie) {
            console.warn(`[edge-cache] Origin threw, serving stale (age=${Math.round(ageSec)}s, sie=${edgeConfig.sie}s)`);
            return dressResponse(cached, "STALE-ERROR", { "X-Cache-Age": String(Math.round(ageSec)) });
          }
        }
        throw err;
      }

      if (origin.status !== 200) {
        // Non-200 origin — SIE fallback on 5xx/429
        if (origin.status >= 500 || origin.status === 429) {
          if (cached && edgeConfig.sie > 0) {
            const storedAtStr = cached.headers.get("X-Deco-Stored-At");
            const storedAt = storedAtStr ? Number(storedAtStr) : 0;
            const ageSec = storedAt > 0 ? (Date.now() - storedAt) / 1000 : Infinity;
            if (ageSec < edgeConfig.fresh + edgeConfig.sie) {
              console.warn(`[edge-cache] Origin ${origin.status}, serving stale (age=${Math.round(ageSec)}s)`);
              return dressResponse(cached, "STALE-ERROR", {
                "X-Cache-Age": String(Math.round(ageSec)),
                "X-Cache-Origin-Status": String(origin.status),
              });
            }
          }
        }
        const resp = new Response(origin.body, origin);
        resp.headers.set("X-Cache", "BYPASS");
        resp.headers.set("X-Cache-Reason", `status:${origin.status}`);
        appendResourceHints(resp);
        return resp;
      }

      // Responses with Set-Cookie must never be cached — they carry
      // per-user session/auth tokens that would leak to other users.
      if (origin.headers.has("set-cookie")) {
        const resp = new Response(origin.body, origin);
        resp.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
        resp.headers.delete("CDN-Cache-Control");
        resp.headers.set("X-Cache", "BYPASS");
        resp.headers.set("X-Cache-Reason", "set-cookie");
        appendResourceHints(resp);
        return resp;
      }

      const profileConfig = getCacheProfile(profile);

      if (!profileConfig.isPublic || profileConfig.edge.fresh === 0) {
        const resp = new Response(origin.body, origin);
        resp.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
        resp.headers.set("X-Cache", "BYPASS");
        resp.headers.set("X-Cache-Reason", `profile:${profile}`);
        appendResourceHints(resp);
        return resp;
      }

      // Clone for cache BEFORE dressResponse consumes the body stream.
      // dressResponse() calls new Response(resp.body, resp) which locks
      // the ReadableStream. Calling clone() on a locked body corrupts
      // the stream in Workers runtime, causing Error 1101.
      storeInCache(origin);
      return dressResponse(origin, "MISS");
  }
}
