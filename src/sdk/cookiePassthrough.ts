/**
 * Request ↔ Response cookie passthrough helpers for TanStack Start.
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
 * Safe to call outside a request scope (no-op).
 */
export function forwardResponseCookies(cookies: string[]): void {
	if (!cookies.length) return;
	try {
		setResponseHeader("set-cookie", cookies);
	} catch {
		// Outside request context (build time, etc.) — ignore.
	}
}
