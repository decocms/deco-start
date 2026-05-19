/**
 * Hydration context utilities for consistent SSR/client rendering.
 *
 * Provides patterns for extracting locale, timezone, and other
 * request-specific data that must be consistent between server
 * and client to avoid hydration mismatches.
 *
 * @example
 * ```tsx
 * // In your storefront's middleware.ts:
 * import { createMiddleware } from "@tanstack/react-start";
 * import { buildHydrationContext } from "@decocms/start/middleware/hydrationContext";
 *
 * export const hydrationMiddleware = createMiddleware().server(async ({ request, next }) => {
 *   const hydrationCtx = buildHydrationContext(request);
 *   return next({ context: { hydration: hydrationCtx } });
 * });
 * ```
 *
 * Then in components:
 * ```tsx
 * // Use the cookie-based values for deterministic SSR rendering
 * const locale = hydrationCtx.locale; // same on server and client
 * ```
 */

export interface HydrationContext {
  /** Locale from cookie or Accept-Language header. */
  locale: string;
  /** Timezone from cookie. Falls back to "UTC" for deterministic SSR. */
  timeZone: string;
  /** Country code from Cloudflare headers or cookie. */
  country?: string;
}

/**
 * Build hydration context from a request.
 *
 * Values are extracted from cookies first (set by the client on first visit),
 * then from headers. Cookie-based values are deterministic because the same
 * cookie is sent on both SSR and client-side navigations.
 *
 * Recommended: set these cookies on first client render:
 * ```tsx
 * useEffect(() => {
 *   const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
 *   document.cookie = `tz=${tz}; path=/; max-age=31536000; SameSite=Lax`;
 *   document.cookie = `locale=${navigator.language}; path=/; max-age=31536000; SameSite=Lax`;
 * }, []);
 * ```
 */
export function buildHydrationContext(request: Request): HydrationContext {
  const cookies = parseCookies(request.headers.get("cookie") ?? "");

  // Locale: cookie → Accept-Language → fallback
  const locale =
    cookies.locale ||
    request.headers.get("accept-language")?.split(",")[0]?.split(";")[0]?.trim() ||
    "en-US";

  // Timezone: cookie → UTC fallback (never guess — causes hydration mismatch)
  const timeZone = cookies.tz || "UTC";

  // Country: Cloudflare header → cookie
  const country =
    request.headers.get("cf-ipcountry") || cookies.country || undefined;

  return { locale, timeZone, country };
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.split("=");
    const k = key?.trim();
    if (k) cookies[k] = rest.join("=").trim();
  }
  return cookies;
}
