/**
 * Registers cookie providers for the VTEX client (@decocms/apps/vtex).
 *
 * When called, `vtexFetchWithCookies` will automatically:
 * 1. Inject the browser's Cookie header into VTEX API requests
 * 2. Forward VTEX Set-Cookie headers back to the browser response
 *
 * This ensures checkout, session, and auth actions propagate cookies
 * transparently — logged-in users see their own cart, session tokens
 * survive across requests, etc.
 *
 * Call once at setup time, after `setVtexFetch`:
 *
 * @example
 * ```ts
 * // setup.ts
 * import { setVtexFetch } from "@decocms/apps/vtex";
 * import { createInstrumentedFetch } from "@decocms/start/sdk/instrumentedFetch";
 * import { initVtexCookieProviders } from "@decocms/start/sdk/vtexCookieProviders";
 *
 * setVtexFetch(createInstrumentedFetch("vtex"));
 * initVtexCookieProviders();
 * ```
 */

import {
	setRequestCookieProvider,
	setResponseCookieForwarder,
} from "@decocms/apps/vtex/client";
import {
	getRequestHeader,
	setResponseHeader,
} from "@tanstack/react-start/server";

export function initVtexCookieProviders(): void {
	setRequestCookieProvider(() => {
		try {
			return getRequestHeader("cookie") ?? undefined;
		} catch {
			return undefined;
		}
	});

	setResponseCookieForwarder((cookies) => {
		try {
			setResponseHeader("set-cookie", cookies);
		} catch {
			// Outside request context (build time, etc.) — ignore.
		}
	});
}
