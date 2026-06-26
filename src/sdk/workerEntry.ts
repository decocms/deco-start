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
import { loadBlocks } from "../cms/loader";
import type { MatcherContext } from "../cms/resolve";
import { isBot, resolveDecoPage } from "../cms/resolve";
import { runSectionLoaders, runSingleSectionLoader } from "../cms/sectionLoaders";
import {
  type CacheProfileName,
  cacheHeaders,
  canonicalizeServerFnPayloadForCacheKey,
  detectCacheProfile,
  edgeCacheConfig,
  getCacheProfile,
  serverFnPagePath,
} from "./cacheHeaders";
import { buildHtmlShell } from "./htmlShell";
import { ensureBlocksHydrated, maybePollRevision } from "./kvHydration";
import {
  getActiveSpan,
  logRequest,
  recordCacheMetric,
  recordRequestMetric,
  setSpanAttribute,
  withTracing,
} from "./observability";
import { _setDebugSampled, _setRequestTraceContext, instrumentWorker, type OtelOptions } from "./otel";
import { setRuntimeEnv } from "./otelAdapters";
import { parseTraceparent } from "./otelHttpTracer";
import { RequestContext } from "./requestContext";
import { cleanPathForCacheKey } from "./urlUtils";
import { type Device, isMobileUA } from "./useDevice";
import { getAppMiddleware } from "./setupApps";
import { isDevMode } from "./env";

/**
 * Build-time identifier injected by `decoVitePlugin()` (see
 * `src/vite/plugin.js`). Falls back to `undefined` if the consuming site
 * isn't using the plugin or the symbol wasn't `define`d at bundle time.
 *
 * The runtime `env.BUILD_HASH` (when explicitly set, e.g. via
 * `wrangler deploy --var BUILD_HASH:foo`) takes precedence — see
 * `getBuildHash()` below.
 */
declare const __DECO_BUILD_HASH__: string | undefined;

/**
 * The five canonical cache-decision strings stamped on the `X-Cache`
 * response header (and on the `decision` label of `cache_*_total`
 * metrics). Used by the request-metric label enrichment to keep label
 * cardinality bounded — anything else (e.g. an upstream proxy that sets
 * its own `X-Cache: random-text`) is dropped from the label.
 */
type CacheDecisionString = "HIT" | "STALE-HIT" | "STALE-ERROR" | "MISS" | "BYPASS";

function isCacheDecision(value: string | null): value is CacheDecisionString {
  return (
    value === "HIT" ||
    value === "STALE-HIT" ||
    value === "STALE-ERROR" ||
    value === "MISS" ||
    value === "BYPASS"
  );
}

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
  /**
   * Device class derived from the request User-Agent.
   *
   * Accepts the full `Device` union (`"mobile" | "desktop" | "tablet"`) so
   * that callers can pass `detectDevice(...)` directly without manual
   * narrowing. Sites that want to share cache entries between mobile and
   * tablet can collapse the value at the call site (e.g.
   * `device === "tablet" ? "mobile" : device`).
   */
  device: Device;
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
   * Defaults include `/_build`, `/deco/`, `/live/`, `/.decofile`.
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

  /**
   * Cookie names considered "safe" for caching — these are public/anonymous
   * cookies that do not carry per-user session or auth data.
   *
   * When a response contains ONLY safe cookies, it is still eligible for
   * Cache API storage. The safe cookies are stripped from the cached copy
   * but kept on the response served to the current user.
   *
   * If the response contains ANY cookie NOT in this list, the response
   * bypasses caching entirely (existing behavior).
   *
   * @default DEFAULT_SAFE_COOKIES (vtex_is_session, vtex_is_anonymous, vtex_segment, _deco_bucket)
   *
   * @example
   * ```ts
   * createDecoWorkerEntry(serverEntry, {
   *   safeCookies: [
   *     ...DEFAULT_SAFE_COOKIES,
   *     "my_custom_analytics_cookie",
   *   ],
   * });
   * ```
   */
  safeCookies?: string[];

  /**
   * Additional static paths (beyond fingerprinted assets) that should
   * receive long-lived immutable cache headers.
   *
   * Useful for non-fingerprinted resources like fonts that live at
   * stable URLs (e.g., `/fonts/Lato-Regular.woff2`).
   *
   * @default ["/fonts/"]
   *
   * @example
   * ```ts
   * createDecoWorkerEntry(serverEntry, {
   *   staticPaths: ["/fonts/", "/static/", "/images/icons/"],
   * });
   * ```
   */
  staticPaths?: string[];

  /**
   * CDN-Cache-Control header strategy.
   *
   * - `"no-store"` (default): CDN never caches; every request invokes the Worker.
   *   Correct when segment-based cache keys differ from the original URL.
   * - `"match-profile"`: Set CDN-Cache-Control to a short TTL matching the
   *   profile's edge.fresh value. Only safe when you are NOT using segment-based
   *   cache keys (i.e., no `buildSegment` and `deviceSpecificKeys: false`).
   * - A function: Return a CDN-Cache-Control value per profile, or `null` for no-store.
   *
   * @default "no-store"
   */
  cdnCacheControl?: "no-store" | "match-profile" | ((profile: CacheProfileName) => string | null);
  /**
   * Auto-instrumentation via `instrumentWorker` is enabled by default. The
   * framework wraps the returned handler so that, when OTel env vars
   * (`DECO_OTEL_*_ENDPOINT`, `DECO_OTEL_TRACES_SAMPLING_RATE`,
   * `DECO_OTEL_LOGS_MIN_LEVEL`) are set on the Worker's `env`, telemetry
   * starts flowing without the site having to touch its worker entry.
   *
   * - Pass an `OtelOptions` object to override defaults (serviceName,
   *   sampling, custom env var names, etc.).
   * - Pass `false` to disable framework-side instrumentation entirely
   *   (e.g., when the site applies its own `instrumentWorker` wrap or
   *   uses a custom transport).
   *
   * When the OTel endpoint env vars are absent the wrap is effectively a
   * no-op — no buffers, no flushes, no network calls.
   */
  observability?: OtelOptions | false;
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

  // Strip CF geo headers that carry non-ASCII values (cf-region: "São Paulo",
  // cf-ipcity: "Brasília", etc.) before building the new Request. The geo
  // data is preserved in the __cf_geo_* cookies we just built, so callers
  // downstream lose no information.
  //
  // Without this strip, the Workers runtime emits a warning on every
  // request because the new Request inherits these UTF-8 headers from the
  // inbound request:
  //
  //   "A header value for "cf-region" contains non-ASCII characters: "..."
  //
  // and the warning is logged once per non-ASCII header — for a Brazilian
  // storefront with cities/states full of accents that means ~2 warns per
  // request × every request that hits the worker.
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lk = key.toLowerCase();
    if (lk === "cf-region" || lk === "cf-ipcity") continue;
    headers.set(key, value);
  }
  headers.set("cookie", combined);

  // Mirror the ASCII-safe geo fields from request.cf into headers so matchers
  // that read `request.headers.get("cf-region-code")` (parity with the
  // upstream deco-cx/apps location matcher) still work even if the inbound
  // request didn't carry them. Non-ASCII fields (region name, city) stay in
  // the cookies above — putting them in headers would re-trigger the
  // non-ASCII warning we strip on the loop above.
  if (cf.country && !headers.has("cf-ipcountry")) headers.set("cf-ipcountry", cf.country);
  if (cf.regionCode && !headers.has("cf-region-code")) headers.set("cf-region-code", cf.regionCode);
  if (cf.latitude && !headers.has("cf-iplatitude")) headers.set("cf-iplatitude", cf.latitude);
  if (cf.longitude && !headers.has("cf-iplongitude")) headers.set("cf-iplongitude", cf.longitude);

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

const DEFAULT_BYPASS_PATHS = ["/_build", "/deco/", "/live/", "/.decofile"];

/**
 * Cookie names that are safe for caching — they carry anonymous/public
 * segment data, not per-user auth tokens.
 *
 * VTEX Intelligent Search sets `vtex_is_session` and `vtex_is_anonymous`
 * on every response. `vtex_segment` encodes the sales channel.
 * `_deco_bucket` is the A/B test cohort cookie.
 */
export const DEFAULT_SAFE_COOKIES: string[] = [
  "vtex_is_session",
  "vtex_is_anonymous",
  "vtex_segment",
  "_deco_bucket",
];

const DEFAULT_STATIC_PATHS = ["/fonts/"];

/**
 * Parse Set-Cookie header values and return cookie names.
 */
function parseCookieNames(response: Response): string[] {
  const names: string[] = [];
  // getSetCookie() returns individual Set-Cookie values (available in Workers runtime)
  const setCookies = (response.headers as any).getSetCookie?.() as string[] | undefined;
  if (setCookies) {
    for (const sc of setCookies) {
      const eqIdx = sc.indexOf("=");
      if (eqIdx > 0) names.push(sc.slice(0, eqIdx).trim());
    }
  } else {
    // Fallback: parse from combined header (less reliable but covers edge cases)
    const combined = response.headers.get("set-cookie") ?? "";
    for (const part of combined.split(",")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx > 0) {
        const name = part.slice(0, eqIdx).trim();
        // Skip attributes like "Expires=..." that appear after semicolons
        if (!name.includes(";") && name.length > 0) names.push(name);
      }
    }
  }
  return names;
}

/**
 * Check if ALL cookies in a response are in the safe list.
 * Returns true if the response has no cookies or only safe cookies.
 */
function hasOnlySafeCookies(response: Response, safeCookieSet: Set<string>): boolean {
  if (!response.headers.has("set-cookie")) return true;
  const names = parseCookieNames(response);
  if (names.length === 0) return true;
  return names.every((name) => safeCookieSet.has(name));
}

/**
 * Clone a response, stripping Set-Cookie headers that match the safe list.
 * Uses response.clone() to preserve the original body for the served response.
 * The returned copy is intended for cache storage only.
 */
function stripSafeCookiesForCache(response: Response, safeCookieSet: Set<string>): Response {
  const clone = response.clone();
  const setCookies = (response.headers as any).getSetCookie?.() as string[] | undefined;
  if (!setCookies || setCookies.length === 0) return clone;

  // Remove all Set-Cookie headers, then re-add only unsafe ones
  clone.headers.delete("set-cookie");
  for (const sc of setCookies) {
    const eqIdx = sc.indexOf("=");
    const name = eqIdx > 0 ? sc.slice(0, eqIdx).trim() : "";
    if (name && !safeCookieSet.has(name)) {
      clone.headers.append("set-cookie", sc);
    }
  }
  return clone;
}

/**
 * Deduplicate Set-Cookie headers — keep only the LAST occurrence of
 * each cookie name. Multiple layers (VTEX middleware, invoke handlers,
 * etc.) may independently append the same cookie.
 */
function deduplicateSetCookies(response: Response): void {
  const setCookies = (response.headers as any).getSetCookie?.() as string[] | undefined;
  if (!setCookies || setCookies.length <= 1) return;

  // Build map: cookie name → last Set-Cookie value
  const seen = new Map<string, string>();
  for (const sc of setCookies) {
    const eqIdx = sc.indexOf("=");
    const name = eqIdx > 0 ? sc.slice(0, eqIdx).trim() : sc;
    seen.set(name, sc);
  }

  // If no duplicates, nothing to do
  if (seen.size === setCookies.length) return;

  response.headers.delete("set-cookie");
  for (const sc of seen.values()) {
    response.headers.append("set-cookie", sc);
  }
}

const FINGERPRINTED_ASSET_RE = /(?:\/_build)?\/assets\/.*-[a-zA-Z0-9_-]{8,}\.\w+$/;

const IMMUTABLE_HEADERS: Record<string, string> = {
  "Cache-Control": `public, max-age=${ONE_YEAR}, immutable`,
  Vary: "Accept-Encoding",
};

/** SHA-256 hex hash of a string — used for POST body cache keys. */
async function hashText(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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
    buildSegment: rawBuildSegment,
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
    safeCookies: safeCookiesOpt = DEFAULT_SAFE_COOKIES,
    staticPaths: staticPathsOpt = DEFAULT_STATIC_PATHS,
    cdnCacheControl: cdnCacheControlOpt = "no-store",
    observability: observabilityOpt,
  } = options;

  // Backfill `regionId` from Cloudflare geo when the consumer's buildSegment
  // doesn't set one. Without this, sites using website/matchers/location.ts
  // get a single cached response per device that leaks across regions: the
  // first visitor's resolved variant gets served to everyone. With this,
  // existing sites get region-segmented cache "for free" on bump — no
  // worker-entry.ts edit required.
  function readRegionFromRequest(request: Request): string | undefined {
    // Trust the Cloudflare-injected `request.cf` first — it can't be spoofed
    // by clients. Fall back to the `cf-region-code` header for environments
    // that surface geo only via headers (e.g. tests, non-CF proxies).
    const cf = (request as unknown as { cf?: { regionCode?: string } }).cf;
    if (cf?.regionCode) return cf.regionCode;
    const fromHeader = request.headers.get("cf-region-code");
    return fromHeader || undefined;
  }

  const buildSegment = rawBuildSegment
    ? (request: Request): SegmentKey => {
        const seg = rawBuildSegment(request);
        if (seg.regionId) return seg;
        const region = readRegionFromRequest(request);
        return region ? { ...seg, regionId: region } : seg;
      }
    : undefined;

  const safeCookieSet = new Set(safeCookiesOpt);

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
    if (fingerprintedAssetPattern.test(pathname)) return true;
    // Non-fingerprinted static paths (e.g., /fonts/)
    return staticPathsOpt.some((sp) => pathname.startsWith(sp));
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
    // For TanStack GET server-fn requests, resolve the page path embedded in
    // the payload so the data request inherits the PAGE's profile (product /
    // search / static) instead of the generic "listing" derived from the
    // `/_serverFn/...` pathname. This is what makes SPA-navigation data
    // requests cache as long as their HTML documents (e.g. PDP 5min) and hit
    // the edge like full reloads do. Falls back to the request URL when no
    // embedded path is found.
    const pagePath = serverFnPagePath(url);
    const target = pagePath ? new URL(pagePath, url.origin) : url;
    if (customDetect) {
      const custom = customDetect(target);
      if (custom !== null) return custom;
    }
    return detectCacheProfile(target);
  }

  function hashSegment(seg: SegmentKey): string {
    const parts: string[] = [seg.device];
    if (seg.loggedIn) parts.push("auth");
    if (seg.salesChannel) parts.push(`sc=${seg.salesChannel}`);
    if (seg.regionId) parts.push(`r=${seg.regionId}`);
    if (seg.flags?.length) parts.push(`f=${seg.flags.sort().join(",")}`);
    return parts.join("|");
  }

  /**
   * Resolve the per-deploy cache-key version with this priority:
   *   1. `env[cacheVersionEnv]` — explicit override (e.g. `wrangler
   *      deploy --var BUILD_HASH:foo`). Wins so callers can always
   *      force a specific value.
   *   2. `__DECO_BUILD_HASH__` — build-time constant injected by
   *      `decoVitePlugin()` from WORKERS_CI_COMMIT_SHA / git rev-parse.
   *      This is the production path on Cloudflare Workers Builds.
   *   3. Empty string — versioning disabled (legacy pre-plugin sites).
   */
  function getBuildHash(env: Record<string, unknown>): string {
    if (cacheVersionEnv === false) return "";
    const fromEnv = (env[cacheVersionEnv] as string) || "";
    if (fromEnv) return fromEnv;
    return typeof __DECO_BUILD_HASH__ !== "undefined" ? __DECO_BUILD_HASH__ : "";
  }

  function buildCacheKey(
    request: Request,
    env: Record<string, unknown>,
  ): { key: Request; segment?: SegmentKey } {
    const url = new URL(request.url);

    if (shouldStripTracking) {
      const cleanPath = cleanPathForCacheKey(url.toString());
      const cleanUrl = new URL(cleanPath, url.origin);
      url.search = cleanUrl.search;
    }

    // For GET server-fn requests (SPA navigation data), the page being loaded
    // is encoded in the `payload` arg. Canonicalize it and strip variant params
    // (skuId/idsku) that the loader ignores — otherwise `/p?skuId=X` and `/p`
    // get distinct keys and every variant-carrying PDP→PDP nav MISSes, even
    // though the resolved response is identical. Keeps PLP filter params intact.
    if (
      url.pathname.startsWith("/_serverFn/") ||
      url.pathname.startsWith("/_server/")
    ) {
      const payload = url.searchParams.get("payload");
      if (payload) {
        url.searchParams.set("payload", canonicalizeServerFnPayloadForCacheKey(payload));
      }
    }

    const version = getBuildHash(env);
    if (version) {
      url.searchParams.set("__v", version);
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

    // Bots render every section eagerly (shouldDeferSection short-circuits in
    // resolve.ts), producing a ~10x larger HTML payload (all eager-section
    // props serialized into the SSR hydration blob). Key bots into a SEPARATE
    // bucket so a crawler / Lighthouse / PageSpeed request can never poison the
    // shared human cache entry (and vice-versa). This MUST use the same `isBot`
    // predicate that gates shouldDeferSection — keying off a different bot
    // regex (e.g. requestContext's BOT_RE, which misses Lighthouse/Semrush)
    // would let the key and render decisions diverge and re-introduce poisoning.
    if (isBot(request.headers.get("user-agent") ?? undefined)) {
      url.searchParams.set("__bot", "1");
    }

    // Programmatic, non-navigation fetches (the PLP "Ver mais"/load-more AJAX,
    // embeds, server-to-server) read the static SSR HTML and can't run the
    // client-side deferred-section resolution, so the origin renders every
    // section eagerly for them (isProgrammaticFetch in cms/resolve.ts) — the
    // same ~10x larger payload as bots. Key them into a SEPARATE `__fetch=1`
    // bucket so a fetch-triggered eager response never poisons the navigation
    // (deferred) entry, and vice-versa. MUST use the same `Sec-Fetch-Dest:
    // empty` signal as isProgrammaticFetch so the key and render decisions can't
    // diverge. `/_serverFn` (SPA-nav data) is excluded: it has its own keying
    // and stays eager via isClientNavigation, not this bucket.
    const secFetchDest = request.headers.get("sec-fetch-dest");
    const isServerFnPath = url.pathname.startsWith("/_serverFn/") ||
      url.pathname.startsWith("/_server/");
    if (!isServerFnPath && secFetchDest === "empty") {
      url.searchParams.set("__fetch", "1");
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

    const cache = isDevMode()
      ? null
      : typeof caches !== "undefined"
        ? ((caches as unknown as { default?: Cache }).default ?? null)
        : null;

    if (!cache) {
      return Response.json({ purged: [], total: 0, note: "Cache API unavailable" });
    }

    const baseUrl = new URL(request.url).origin;
    const purged: string[] = [];

    const geoKeys: (string | null)[] = [null, ...geoVariants];

    // Bots (`__bot=1`) and programmatic fetches (`__fetch=1`) are each keyed
    // into a separate bucket (see buildCacheKey), so purge every combination.
    // The param-set order below MUST mirror buildCacheKey exactly (__v,
    // __cf_geo, __bot, __fetch, then __seg/__cf_device) so the purge key
    // byte-matches the stored key.
    const botVariants = [false, true] as const;
    const fetchVariants = [false, true] as const;

    for (const p of paths) {
      if (buildSegment) {
        const segments = buildPurgeSegments(body);
        for (const seg of segments) {
          for (const cc of geoKeys) {
            for (const bot of botVariants) {
              for (const fetchReq of fetchVariants) {
                const url = new URL(p, baseUrl);
                const purgeVersion = getBuildHash(env);
                if (purgeVersion) url.searchParams.set("__v", purgeVersion);
                if (cc) url.searchParams.set("__cf_geo", cc);
                if (bot) url.searchParams.set("__bot", "1");
                if (fetchReq) url.searchParams.set("__fetch", "1");
                url.searchParams.set("__seg", hashSegment(seg));
                const key = new Request(url.toString(), { method: "GET" });
                try {
                  if (await cache.delete(key)) {
                    const tags = [
                      hashSegment(seg),
                      cc,
                      bot ? "bot" : null,
                      fetchReq ? "fetch" : null,
                    ]
                      .filter(Boolean)
                      .join(", ");
                    purged.push(`${p} (${tags})`);
                  }
                } catch {
                  /* ignore */
                }
              }
            }
          }
        }
      } else {
        const devices = deviceSpecificKeys ? (["mobile", "desktop"] as const) : ([null] as const);

        for (const device of devices) {
          for (const cc of geoKeys) {
            for (const bot of botVariants) {
              for (const fetchReq of fetchVariants) {
                const url = new URL(p, baseUrl);
                const purgeVersion = getBuildHash(env);
                if (purgeVersion) url.searchParams.set("__v", purgeVersion);
                if (cc) url.searchParams.set("__cf_geo", cc);
                if (bot) url.searchParams.set("__bot", "1");
                if (fetchReq) url.searchParams.set("__fetch", "1");
                if (device) url.searchParams.set("__cf_device", device);
                const key = new Request(url.toString(), { method: "GET" });
                try {
                  if (await cache.delete(key)) {
                    const parts = [device, cc, bot ? "bot" : null, fetchReq ? "fetch" : null]
                      .filter(Boolean)
                      .join(", ");
                    purged.push(parts ? `${p} (${parts})` : p);
                  }
                } catch {
                  /* ignore */
                }
              }
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
      const resp = await withTracing("deco.admin.meta", async () => admin.handleMeta(request));
      return addCors(resp, request);
    }

    if (pathname === "/.decofile") {
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { ...admin.corsHeaders(request), ...ADMIN_NO_CACHE },
        });
      }
      if (method === "POST") {
        const resp = await withTracing("deco.admin.decofile.reload", () =>
          Promise.resolve(admin.handleDecofileReload(request)),
        );
        return addCors(resp, request);
      }
      const resp = await withTracing("deco.admin.decofile.read", async () =>
        admin.handleDecofileRead(),
      );
      return addCors(resp, request);
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
      const pathComponent = pathname.slice("/live/previews/".length);
      const resp = await withTracing(
        "deco.admin.render",
        () => Promise.resolve(admin.handleRender(request)),
        { "cms.component": pathComponent || "(page)" },
      );
      return addCors(resp, request);
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
      const startedAt = performance.now();
      const reqUrl = new URL(request.url);
      const method = request.method;

      // Inject CF geo data as cookies for location matchers (before anything reads cookies)
      if (geoOpt) {
        request = injectGeoCookies(request);
      }

      // Captured inside the withTracing scope so the outer post-response
      // path (response headers, metric labels, log attrs) can stamp the
      // trace ID without re-entering AsyncLocalStorage. The closure
      // captures whatever the framework span saw; if the bridge tracer
      // is a no-op, both stay empty strings and the header writes below
      // become no-ops.
      const identity = { requestId: "", traceId: "" };

      // Wrap the entire request in a RequestContext so that all code
      // in the call stack (loaders, invoke handlers, vtexFetchWithCookies)
      // can access the request and write response headers.
      const response = await RequestContext.run(request, async () => {
        // Stash env so request-scoped adapters (Workers Analytics Engine,
        // future binding-driven destinations) can resolve their bindings
        // via getRuntimeEnv() in sdk/otelAdapters.ts.
        setRuntimeEnv(env);

        // RequestContext.run already resolved request.id from the
        // inbound headers (precedence: x-request-id → cf-ray → UUID).
        // Lift it into the closure so the response-write path below has
        // access without going back through ALS.
        identity.requestId = RequestContext.requestId ?? "";

        // W3C tracecontext propagation — parse the inbound `traceparent`
        // header so the OTLP trace exporter creates root spans under
        // the caller's trace ID. No-op when the header is absent or
        // malformed; the exporter falls back to a fresh trace ID.
        const incomingTraceparent = request.headers.get("traceparent");
        const remoteTrace = parseTraceparent(incomingTraceparent);
        if (remoteTrace) _setRequestTraceContext(remoteTrace);

        // Debug sampling: ?__d=<any> forces this request to be fully sampled
        // regardless of headSamplingRate. Lets operators trace a specific
        // production request without changing global sampling rates.
        if (new URL(request.url).searchParams.has("__d")) _setDebugSampled();

        // Wrap inner handler in a single root span carrying our normalized
        // path/method attributes. The framework span flows BOTH ways:
        //  - via the OTLP direct-POST tracer (when DECO_OTEL_TRACES_ENDPOINT
        //    is set) → ClickHouse `otel_traces`,
        //  - via the @opentelemetry/api bridge → CF Workers Observability
        //    when `observability.traces.enabled = true` in wrangler.jsonc.
        // See `configureTracerStack` in `otel.ts` for the composition.
        return withTracing(
          "deco.http.request",
          async () => {
            // Stamp identity on the root span so every child span +
            // every log emitted under the same active span carries
            // them. Done inside the span scope so getActiveSpan()
            // returns the right span. Cheap no-op for any of these
            // when no tracer is configured.
            if (identity.requestId) {
              setSpanAttribute("request.id", identity.requestId);
            }
            const spanCtx = getActiveSpan()?.spanContext?.();
            if (spanCtx?.traceId) {
              identity.traceId = spanCtx.traceId;
            }

            // Run app middleware (injects app state into RequestContext.bag,
            // runs registered middleware like VTEX cookie forwarding).
            const appMw = getAppMiddleware();
            const innerResponse = appMw
              ? await appMw(request, () => handleRequest(request, env, ctx))
              : await handleRequest(request, env, ctx);

            // Access log — always emit for 5xx (ERROR level); sample INFO
            // access logs via DECO_OTEL_ACCESS_LOG_RATE (float 0–1, default
            // 1.0 = 100%). Set to 0 to silence INFO access logs entirely.
            try {
              const status = innerResponse.status;
              let shouldLog = status >= 500; // errors always logged
              if (!shouldLog) {
                const rateRaw = (env as Record<string, unknown>)
                  .DECO_OTEL_ACCESS_LOG_RATE;
                const rate =
                  typeof rateRaw === "string" ? parseFloat(rateRaw) : 1.0;
                if (rate >= 1.0) {
                  shouldLog = true;
                } else if (rate > 0) {
                  // FNV-1a 32-bit on requestId/traceId for consistent
                  // per-request sampling (same request always same decision).
                  const key = identity.requestId || identity.traceId;
                  if (key) {
                    let h = 2166136261;
                    for (let i = 0; i < key.length; i++) {
                      h ^= key.charCodeAt(i);
                      h = Math.imul(h, 16777619);
                    }
                    shouldLog = (h >>> 0) / 4294967295 < rate;
                  } else {
                    shouldLog = Math.random() < rate;
                  }
                }
              }
              if (shouldLog) {
                logRequest(
                  request,
                  innerResponse.status,
                  performance.now() - startedAt,
                  {
                    ...(identity.requestId
                      ? { "request.id": identity.requestId }
                      : {}),
                    ...(identity.traceId
                      ? { "trace.id": identity.traceId }
                      : {}),
                  },
                );
              }
            } catch {
              /* swallow — observability must never fail the request */
            }

            return innerResponse;
          },
          {
            "http.method": method,
            "url.path": reqUrl.pathname,
          },
        );
      });

      // Deduplicate Set-Cookie headers — multiple layers (VTEX middleware,
      // invoke handlers, etc.) may independently append the same cookie.
      deduplicateSetCookies(response);

      let finalResponse = applySecurityHeaders(response);

      // Echo request.id + trace.id back to the client / tail worker.
      // The CF tail worker reads these headers off the response to
      // stamp `request.id` / `trace.id` on tail rows — they're the
      // join key against direct-POST logs/metrics (which carry the
      // same values via the logger + span attributes).
      //
      // Headers are written defensively: if a downstream component
      // already set them (e.g. a proxy upstream), the existing value
      // wins. That's intentional — a load-balancer-supplied request.id
      // is more useful for cross-system correlation than ours.
      if (identity.requestId || identity.traceId) {
        // applySecurityHeaders may return either the original Response
        // (HTML path, fresh Headers) or the same Response (non-HTML
        // path). Either way Response.headers is mutable on Workers, so
        // we can set on it directly.
        if (identity.requestId && !finalResponse.headers.has("x-request-id")) {
          try {
            finalResponse.headers.set("x-request-id", identity.requestId);
          } catch {
            // Some intermediaries seal response headers (e.g. cached
            // responses replayed from the Cache API). Fall back to
            // building a new Response.
            const headers = new Headers(finalResponse.headers);
            if (identity.requestId) headers.set("x-request-id", identity.requestId);
            if (identity.traceId) headers.set("x-trace-id", identity.traceId);
            finalResponse = new Response(finalResponse.body, {
              status: finalResponse.status,
              statusText: finalResponse.statusText,
              headers,
            });
          }
        }
        if (identity.traceId && !finalResponse.headers.has("x-trace-id")) {
          try {
            finalResponse.headers.set("x-trace-id", identity.traceId);
          } catch {
            /* see above — sealed header case already handled */
          }
        }
      }

      // Metrics + structured request log. Done after security headers so
      // the recorded status reflects what the client actually receives.
      // Both calls are no-ops when no meter / logger is configured.
      const durationMs = performance.now() - startedAt;
      try {
        // Phase 2 / D-11 canonical labels — lift the cache decision +
        // profile + region off the response we just built so dashboards
        // can answer "cache hit rate per route" from `http_requests_total`
        // alone, no join to `cache_*_total` required.
        const xCacheRaw = finalResponse.headers.get("X-Cache");
        const cacheDecision = isCacheDecision(xCacheRaw) ? xCacheRaw : undefined;
        const colo = (request as unknown as { cf?: { colo?: string } }).cf?.colo;
        // NOTE: `request.id` and `trace.id` are intentionally NOT stamped
        // on the metric. They are per-request identifiers and would
        // collapse aggregation (every request → its own histogram data
        // point). They are stamped on the span and the access log
        // (logRequest inside withTracing above); use those for
        // request-level correlation.
        recordRequestMetric(method, reqUrl.pathname, finalResponse.status, durationMs, {
          ...(cacheDecision ? { cache_decision: cacheDecision } : {}),
          ...(cacheDecision ? { cache_layer: "edge" as const } : {}),
          ...(typeof colo === "string" && colo.length > 0 ? { region: colo } : {}),
        });
      } catch {
        /* swallow — observability must never fail the request */
      }
      return finalResponse;
    },
  };

  // Auto-instrument with `instrumentWorker` unless explicitly opted out.
  // When `observabilityOpt === false` the site is taking control of its own
  // OTel wiring; otherwise the framework wraps the handler so that, when
  // `DECO_OTEL_*_ENDPOINT` env vars are configured, telemetry flows
  // without any change to the site's worker-entry. When the env vars are
  // absent the wrap is a no-op (no exporters created, no flush calls).
  return observabilityOpt === false
    ? handler
    : instrumentWorker(handler, (observabilityOpt as OtelOptions | undefined) ?? {});

  async function handleRequest(
    request: Request,
    env: Record<string, unknown>,
    ctx: WorkerExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Fast-deploy: hydrate the in-memory decofile from KV on the first request
    // per isolate (awaited, ~10-30ms once), then opportunistically poll for
    // content changes (non-blocking, via ctx.waitUntil). No-op unless the
    // DECO_KV binding is present — non-migrated sites are unaffected. Runs
    // before admin routes so /.decofile reads reflect KV too.
    await ensureBlocksHydrated(env, ctx);
    maybePollRevision(env, ctx);

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
        return Response.json(null, {
          status: 404,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
      const enrichedSections = await runSectionLoaders(page.resolvedSections, request);

      // Run SEO section loader if registered
      let seoResult = page.seoSection;
      if (seoResult) {
        try {
          seoResult = await runSingleSectionLoader(seoResult, request);
        } catch {
          // use unloaded seoSection
        }
      }

      // Merge site-wide SEO defaults into seo props
      const blocks = loadBlocks();
      const site = blocks["Site"] as Record<string, unknown> | undefined;
      const fullSiteSeo = (site?.seo as Record<string, unknown>) ?? {};

      // When SeoV2 loader ran, use its output as base (preserves key order)
      // and only fill in missing fields from the site-wide SEO config.
      const loaderProps = seoResult?.props ?? {};
      const seoProps: Record<string, unknown> = { ...loaderProps };
      for (const [k, v] of Object.entries(fullSiteSeo)) {
        if (!(k in seoProps)) seoProps[k] = v;
      }
      // Strip internal template fields
      delete seoProps.titleTemplate;
      delete seoProps.descriptionTemplate;

      // Build resolveChain statically to match legacy deco-cx/deco format.
      type FieldResolver = { type: string; value: string | number };
      const rawKey = page.blockKey ?? `pages-${page.name}`;
      const encodedKey = rawKey.replace(
        /^(pages-)(.+)$/,
        (_m, prefix, rest) => prefix + encodeURIComponent(rest),
      );
      const pageChain: FieldResolver[] = [
        { type: "resolver", value: "website/handlers/fresh.ts" },
        { type: "prop", value: "page" },
        { type: "resolver", value: "resolved" },
        { type: "resolvable", value: encodedKey },
        { type: "resolver", value: "website/pages/Page.tsx" },
      ];

      const seoChain: FieldResolver[] = [
        ...pageChain,
        { type: "prop", value: "seo" },
        { type: "resolver", value: seoResult?.component ?? "website/sections/Seo/SeoV2.tsx" },
      ];

      const result = {
        props: {
          name: page.name,
          path: page.path,
          seo: {
            props: seoProps,
            metadata: {
              resolveChain: seoChain,
              component: seoResult?.component ?? "website/sections/Seo/SeoV2.tsx",
            },
          },
          sections: enrichedSections.map((s, i) => ({
            props: s.props,
            metadata: {
              resolveChain: [
                ...pageChain,
                { type: "prop", value: "sections" },
                { type: "prop", value: String(i) },
                { type: "resolver", value: s.component },
              ],
              component: s.component,
            },
          })),
          devMode: false,
          unindexedDomain: false,
        },
        metadata: {
          resolveChain: pageChain,
          component: "website/pages/Page.tsx",
        },
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

    // -----------------------------------------------------------------
    // POST _serverFn — edge-cacheable using body-hash as cache key.
    // These carry public CMS section data (shelves, deferred sections)
    // that benefits from edge caching despite being POST requests.
    // -----------------------------------------------------------------
    if (
      request.method === "POST" &&
      (url.pathname.startsWith("/_serverFn/") || url.pathname.startsWith("/_server/"))
    ) {
      const serverFnCache = isDevMode()
        ? null
        : typeof caches !== "undefined"
          ? ((caches as unknown as { default?: Cache }).default ?? null)
          : null;

      // Build segment once — used for logged-in check and cache key
      const sfnSegment = buildSegment ? buildSegment(request) : undefined;

      // Logged-in users always bypass — personalized content must not leak
      if (sfnSegment?.loggedIn) {
        const origin = await serverEntry.fetch(request, env, ctx);
        const resp = new Response(origin.body, origin);
        resp.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
        resp.headers.set("X-Cache", "BYPASS");
        resp.headers.set("X-Cache-Reason", "logged-in");
        return resp;
      }

      // Clone request before consuming body — the clone goes to origin
      // untouched so TanStack Start internals (cookie passthrough, etc.)
      // work correctly. We only read the body for the cache key hash.
      const originClone = request.clone();
      const body = await request.text();
      const bodyHash = await hashText(body);

      // Build a synthetic GET cache key from the URL + body hash + segment
      // Includes device, salesChannel, regionId, flags — so users in
      // different regions or channels get separate cache entries.
      const cacheKeyUrl = new URL(request.url);
      cacheKeyUrl.searchParams.set("__body", bodyHash);
      const sfnVersion = getBuildHash(env);
      if (sfnVersion) cacheKeyUrl.searchParams.set("__v", sfnVersion);
      if (sfnSegment) {
        cacheKeyUrl.searchParams.set("__seg", hashSegment(sfnSegment));
      } else if (deviceSpecificKeys) {
        const device = isMobileUA(request.headers.get("user-agent") ?? "") ? "mobile" : "desktop";
        cacheKeyUrl.searchParams.set("__cf_device", device);
      }
      // Include CF geo data so location-based content doesn't leak across geos
      const cf = (request as unknown as { cf?: Record<string, string> }).cf;
      if (cf) {
        const geoParts: string[] = [];
        if (cf.country) geoParts.push(cf.country);
        if (cf.region) geoParts.push(cf.region);
        if (cf.city) geoParts.push(cf.city);
        if (geoParts.length) cacheKeyUrl.searchParams.set("__cf_geo", geoParts.join("|"));
      }
      const sfnCacheKey = new Request(cacheKeyUrl.toString(), { method: "GET" });

      // Use "listing" profile for server function responses
      const sfnProfile: CacheProfileName = "listing";
      const sfnEdge = edgeCacheConfig(sfnProfile);

      // Check edge cache
      let sfnCached: Response | undefined;
      if (serverFnCache) {
        try {
          sfnCached = await withTracing(
            "deco.cache.lookup",
            async () => (await serverFnCache.match(sfnCacheKey)) ?? undefined,
            { "cache.profile": sfnProfile, "cache.kind": "serverFn" },
          );
        } catch {
          /* Cache API unavailable */
        }
      }

      if (sfnCached && sfnEdge.fresh > 0) {
        const storedAt = Number(sfnCached.headers.get("X-Deco-Stored-At") || "0");
        const ageSec = storedAt > 0 ? (Date.now() - storedAt) / 1000 : Infinity;

        if (ageSec < sfnEdge.fresh) {
          recordCacheMetric(true, sfnProfile, "HIT", "edge");
          const out = new Response(sfnCached.body, sfnCached);
          const hdrs = cacheHeaders(sfnProfile);
          for (const [k, v] of Object.entries(hdrs)) out.headers.set(k, v);
          out.headers.set("X-Cache", "HIT");
          out.headers.set("X-Cache-Profile", sfnProfile);
          return out;
        }

        if (ageSec < sfnEdge.fresh + sfnEdge.swr) {
          recordCacheMetric(true, sfnProfile, "STALE-HIT", "edge");
          // Stale-while-revalidate: serve stale, refresh in background
          ctx.waitUntil(
            (async () => {
              try {
                const bgReq = new Request(request, { body, method: "POST" });
                const bgOrigin = await serverEntry.fetch(bgReq, env, ctx);
                if (
                  bgOrigin.status === 200 &&
                  bgOrigin.headers.get("X-Deco-Cacheable") === "true" &&
                  !bgOrigin.headers.has("set-cookie") &&
                  serverFnCache
                ) {
                  const ttl = sfnEdge.fresh + Math.max(sfnEdge.swr, sfnEdge.sie);
                  const toStore = bgOrigin.clone();
                  toStore.headers.set("Cache-Control", `public, max-age=${ttl}`);
                  toStore.headers.set("X-Deco-Stored-At", String(Date.now()));
                  toStore.headers.delete("CDN-Cache-Control");
                  toStore.headers.delete("X-Deco-Cacheable");
                  await serverFnCache.put(sfnCacheKey, toStore);
                }
              } catch {
                /* background revalidation failed */
              }
            })(),
          );
          const out = new Response(sfnCached.body, sfnCached);
          const hdrs = cacheHeaders(sfnProfile);
          for (const [k, v] of Object.entries(hdrs)) out.headers.set(k, v);
          out.headers.set("X-Cache", "STALE-HIT");
          out.headers.set("X-Cache-Profile", sfnProfile);
          out.headers.set("X-Cache-Age", String(Math.round(ageSec)));
          return out;
        }
      }

      // Cache MISS — fetch origin with the body we already read
      recordCacheMetric(false, sfnProfile, "MISS", "edge");
      const origin = await serverEntry.fetch(originClone, env, ctx);

      // Only cache responses explicitly marked as cacheable by the handler
      // (loadDeferredSection sets X-Deco-Cacheable: true). Checkout actions,
      // invoke mutations, and other server functions are passed through.
      const isCacheableResponse =
        origin.headers.get("X-Deco-Cacheable") === "true" &&
        !origin.headers.has("set-cookie") &&
        origin.status === 200;

      if (!isCacheableResponse) {
        const resp = new Response(origin.body, origin);
        resp.headers.delete("X-Deco-Cacheable");
        resp.headers.set("X-Cache", "BYPASS");
        resp.headers.set(
          "X-Cache-Reason",
          origin.headers.has("set-cookie") ? "set-cookie" : "not-cacheable",
        );
        return resp;
      }

      // Store in edge cache
      if (serverFnCache) {
        try {
          const ttl = sfnEdge.fresh + Math.max(sfnEdge.swr, sfnEdge.sie);
          const toStore = origin.clone();
          toStore.headers.set("Cache-Control", `public, max-age=${ttl}`);
          toStore.headers.set("X-Deco-Stored-At", String(Date.now()));
          toStore.headers.delete("CDN-Cache-Control");
          toStore.headers.delete("X-Deco-Cacheable");
          ctx.waitUntil(
            withTracing("deco.cache.store", () => serverFnCache.put(sfnCacheKey, toStore), {
              "cache.profile": sfnProfile,
              "cache.kind": "serverFn",
            }),
          );
        } catch {
          /* Cache API unavailable */
        }
      }

      const resp = new Response(origin.body, origin);
      resp.headers.delete("X-Deco-Cacheable");
      const hdrs = cacheHeaders(sfnProfile);
      for (const [k, v] of Object.entries(hdrs)) resp.headers.set(k, v);
      resp.headers.set("X-Cache", "MISS");
      resp.headers.set("X-Cache-Profile", sfnProfile);
      return resp;
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

      // Responses with private Set-Cookie headers carry per-user tokens —
      // never expose them with public cache headers.
      // Safe/public cookies (e.g., vtex_is_session) are allowed through.
      if (origin.headers.has("set-cookie") && !hasOnlySafeCookies(origin, safeCookieSet)) {
        resp.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
        resp.headers.delete("CDN-Cache-Control");
        resp.headers.set("X-Cache", "BYPASS");
        resp.headers.set("X-Cache-Reason", "private-set-cookie");
        return resp;
      }

      // Set cache headers from the detected profile so the response
      // is explicit about cacheability (avoids ambiguous empty header).
      const hdrsNc = cacheHeaders(profile);
      for (const [k, v] of Object.entries(hdrsNc)) resp.headers.set(k, v);

      const reason = request.method !== "GET" ? `method:${request.method}` : "bypass-path";
      resp.headers.set("X-Cache", "BYPASS");
      resp.headers.set("X-Cache-Profile", profile);
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

    // Check Cache API — disabled in local dev to avoid stale responses
    const cache = isDevMode()
      ? null
      : typeof caches !== "undefined"
        ? ((caches as unknown as { default?: Cache }).default ?? null)
        : null;

    const profile = getProfile(url);
    const edgeConfig = edgeCacheConfig(profile);

    // Helper: dress a response with proper client-facing headers
    function dressResponse(
      resp: Response,
      xCache: string,
      extra?: Record<string, string>,
    ): Response {
      const out = new Response(resp.body, resp);
      const hdrs = cacheHeaders(profile);
      for (const [k, v] of Object.entries(hdrs)) out.headers.set(k, v);

      // CDN-Cache-Control: controls Cloudflare's automatic CDN layer
      // (separate from Cache API which the worker manages directly).
      if (cdnCacheControlOpt === "no-store") {
        out.headers.set("CDN-Cache-Control", "no-store");
      } else if (cdnCacheControlOpt === "match-profile") {
        if (edgeConfig.isPublic && edgeConfig.fresh > 0) {
          out.headers.set("CDN-Cache-Control", `public, max-age=${edgeConfig.fresh}`);
        } else {
          out.headers.set("CDN-Cache-Control", "no-store");
        }
      } else if (typeof cdnCacheControlOpt === "function") {
        const val = cdnCacheControlOpt(profile);
        out.headers.set("CDN-Cache-Control", val ?? "no-store");
      }

      out.headers.set("X-Cache", xCache);
      out.headers.set("X-Cache-Profile", profile);
      if (segment) out.headers.set("X-Cache-Segment", hashSegment(segment));
      const headerVersion = getBuildHash(env);
      if (headerVersion) out.headers.set("X-Cache-Version", headerVersion);
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
        ctx.waitUntil(
          withTracing("deco.cache.store", () => cache.put(cacheKey, toStore), {
            "cache.profile": profile,
            "cache.kind": "html",
          }),
        );
      } catch {
        // Cache API unavailable
      }
    }

    // Helper: background revalidation (fetch origin, store result)
    function revalidateInBackground() {
      ctx.waitUntil(
        Promise.resolve(serverEntry.fetch(request, env, ctx))
          .then((origin) => {
            if (origin.status === 200) {
              // Only cache if response has no cookies or only safe cookies.
              // Strip safe cookies from the cached copy.
              if (hasOnlySafeCookies(origin, safeCookieSet)) {
                const cleanOrigin = origin.headers.has("set-cookie")
                  ? stripSafeCookiesForCache(origin, safeCookieSet)
                  : origin;
                storeInCache(cleanOrigin);
              }
            }
          })
          .catch(() => {
            // Background revalidation failed — stale entry stays until SIE expires
          }),
      );
    }

    // --- Edge cache check with SWR + SIE ---
    let cached: Response | undefined;
    if (cache) {
      try {
        cached = await withTracing(
          "deco.cache.lookup",
          async () => (await cache.match(cacheKey)) ?? undefined,
          { "cache.profile": profile, "cache.kind": "html" },
        );
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
        recordCacheMetric(true, profile, "HIT", "edge");
        return dressResponse(cached, "HIT");
      }

      if (ageSec < edgeConfig.fresh + edgeConfig.swr) {
        // STALE-HIT within SWR window — serve stale, revalidate in background
        recordCacheMetric(true, profile, "STALE-HIT", "edge");
        revalidateInBackground();
        return dressResponse(cached, "STALE-HIT", { "X-Cache-Age": String(Math.round(ageSec)) });
      }

      // Past SWR window but still in cache (within SIE window) — keep reference
      // for potential error fallback below
    }

    // Cache MISS or past SWR window — fetch from origin
    recordCacheMetric(false, profile, "MISS", "edge");
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
          console.warn(
            `[edge-cache] Origin threw, serving stale (age=${Math.round(ageSec)}s, sie=${edgeConfig.sie}s)`,
          );
          recordCacheMetric(true, profile, "STALE-ERROR", "edge");
          return dressResponse(cached, "STALE-ERROR", {
            "X-Cache-Age": String(Math.round(ageSec)),
          });
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
            console.warn(
              `[edge-cache] Origin ${origin.status}, serving stale (age=${Math.round(ageSec)}s)`,
            );
            recordCacheMetric(true, profile, "STALE-ERROR", "edge");
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

    // Responses with private Set-Cookie headers must never be cached —
    // they carry per-user session/auth tokens that would leak to other users.
    // Safe/public cookies (IS session, segment, etc.) are stripped from the
    // cached copy but kept on the response served to the current user.
    if (origin.headers.has("set-cookie") && !hasOnlySafeCookies(origin, safeCookieSet)) {
      const resp = new Response(origin.body, origin);
      resp.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
      resp.headers.delete("CDN-Cache-Control");
      resp.headers.set("X-Cache", "BYPASS");
      resp.headers.set("X-Cache-Reason", "private-set-cookie");
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
    // Strip safe cookies from the cached copy so they don't leak
    // to other users, but the current user still gets them.
    const cacheOrigin = origin.headers.has("set-cookie")
      ? stripSafeCookiesForCache(origin, safeCookieSet)
      : origin;
    storeInCache(cacheOrigin);
    return dressResponse(origin, "MISS");
  }
}
