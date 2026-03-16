/**
 * Request / Response cookie passthrough helpers for TanStack Start.
 *
 * Provides two framework-bound functions that commerce apps
 * (VTEX, Shopify, etc.) can plug into their cookie provider hooks
 * to transparently forward browser cookies to API calls and
 * Set-Cookie headers back to the browser.
 *
 * @example
 * ```ts
 * // setup.ts
 * import { getRequestCookieHeader, forwardResponseCookies } from "@decocms/start/sdk/cookiePassthrough";
 * import { setRequestCookieProvider, setResponseCookieForwarder } from "@decocms/apps/vtex";
 *
 * setRequestCookieProvider(getRequestCookieHeader);
 * setResponseCookieForwarder(forwardResponseCookies);
 * ```
 */

import {
	getRequestHeader,
	getResponseHeaders,
	setResponseHeader,
} from "@tanstack/react-start/server";

/**
 * Returns the Cookie header from the current TanStack Start request context.
 * Safe to call outside a request scope (returns undefined).
 */
export function getRequestCookieHeader(): string | undefined {
	try {
		return getRequestHeader("cookie") ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Appends Set-Cookie headers to the current TanStack Start response.
 * Preserves any Set-Cookie headers already set by other middleware or
 * earlier calls, so multiple API calls in one request don't clobber
 * each other's cookies.
 *
 * Safe to call outside a request scope (no-op).
 */
export function forwardResponseCookies(cookies: string[]): void {
	if (!cookies.length) return;
	try {
		const headers = getResponseHeaders();
		const existing: string[] =
			typeof headers.getSetCookie === "function"
				? headers.getSetCookie()
				: [];
		setResponseHeader("set-cookie", [...existing, ...cookies]);

		// Responses with Set-Cookie must not be cached by CDN/edge,
		// otherwise one user's session cookies could be served to another.
		setResponseHeader("cache-control", "no-store, no-cache");
	} catch {
		// Outside request context (build time, etc.) — ignore.
	}
}
