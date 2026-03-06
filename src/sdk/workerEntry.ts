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
  cacheHeaders,
  getCacheProfileConfig,
  detectCacheProfile,
  type CacheProfile,
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

export interface DecoWorkerEntryOptions {
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
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MOBILE_RE = /mobile|android|iphone|ipad|ipod/i;
const ONE_YEAR = 31536000;

const DEFAULT_BYPASS_PATHS = [
  "/_server",
  "/_build",
  "/deco/",
];

const FINGERPRINTED_ASSET_RE =
  /\/_build\/assets\/.*-[a-zA-Z0-9]{8,}\.\w+$/;

const IMMUTABLE_HEADERS: Record<string, string> = {
  "Cache-Control": `public, max-age=${ONE_YEAR}, immutable`,
  "Vary": "Accept-Encoding",
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
    detectProfile: customDetect,
    deviceSpecificKeys = true,
    buildSegment,
    purgeTokenEnv = "PURGE_TOKEN",
    bypassPaths,
    extraBypassPaths = [],
    fingerprintedAssetPattern = FINGERPRINTED_ASSET_RE,
    stripTrackingParams: shouldStripTracking = true,
  } = options;

  const allBypassPaths = [
    ...(bypassPaths ?? DEFAULT_BYPASS_PATHS),
    ...extraBypassPaths,
  ];

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
      const device = MOBILE_RE.test(request.headers.get("user-agent") ?? "")
        ? "mobile"
        : "desktop";
      url.searchParams.set("__cf_device", device);
    }

    return { key: new Request(url.toString(), { method: "GET" }) };
  }

  // -- Purge handler ----------------------------------------------------------

  async function handlePurge(
    request: Request,
    env: Record<string, unknown>,
  ): Promise<Response> {
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
      return new Response(
        'Body must include "paths": ["/", "/page"]',
        { status: 400 },
      );
    }

    const cache = (caches as unknown as { default: Cache }).default;
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
          if (await cache.delete(key)) {
            purged.push(`${p} (${hashSegment(seg)})`);
          }
        }
      } else {
        const devices = deviceSpecificKeys
          ? (["mobile", "desktop"] as const)
          : ([null] as const);

        for (const device of devices) {
          const url = new URL(p, baseUrl);
          if (device) url.searchParams.set("__cf_device", device);
          const key = new Request(url.toString(), { method: "GET" });
          if (await cache.delete(key)) {
            purged.push(device ? `${p} (${device})` : p);
          }
        }
      }
    }

    return Response.json({ purged, total: purged.length });
  }

  // -- Main fetch handler -----------------------------------------------------

  return {
    async fetch(
      request: Request,
      env: Record<string, unknown>,
      ctx: WorkerExecutionContext,
    ): Promise<Response> {
      const url = new URL(request.url);

      // Purge endpoint
      if (url.pathname === "/_cache/purge" && request.method === "POST") {
        return handlePurge(request, env);
      }

      // Static fingerprinted assets — serve from origin with immutable headers
      if (isStaticAsset(url.pathname)) {
        const origin = await serverEntry.fetch(request, env, ctx);
        if (origin.status === 200) {
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
        if (
          profile === "private" ||
          profile === "none" ||
          profile === "cart"
        ) {
          const resp = new Response(origin.body, origin);
          resp.headers.set(
            "Cache-Control",
            "private, no-cache, no-store, must-revalidate",
          );
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
        resp.headers.set(
          "Cache-Control",
          "private, no-cache, no-store, must-revalidate",
        );
        resp.headers.set("X-Cache", "BYPASS");
        resp.headers.set("X-Cache-Reason", "logged-in");
        return resp;
      }

      // Check Cache API
      const cache = (caches as unknown as { default: Cache }).default;

      const cached = await cache.match(cacheKey);
      if (cached) {
        const hit = new Response(cached.body, cached);
        hit.headers.set("X-Cache", "HIT");
        if (segment) hit.headers.set("X-Cache-Segment", hashSegment(segment));
        return hit;
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
        resp.headers.set(
          "Cache-Control",
          "private, no-cache, no-store, must-revalidate",
        );
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
      const toStore = toReturn.clone();
      toStore.headers.set(
        "Cache-Control",
        `public, max-age=${profileConfig.sMaxAge}`,
      );
      ctx.waitUntil(cache.put(cacheKey, toStore));

      return toReturn;
    },
  };
}
