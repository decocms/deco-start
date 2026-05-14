/**
 * Deco-flavored TanStack Router factory.
 *
 * Uses standard URLSearchParams serialization instead of TanStack's default
 * JSON-based format. Required because VTEX (and most commerce platforms) uses
 * filter URLs like `?filter.brand=Nike&filter.brand=Adidas` which must
 * round-trip correctly through the router's search system.
 */
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import type {
	SearchSerializer,
	SearchParser,
	AnyRoute,
	TrailingSlashOption,
} from "@tanstack/react-router";

export const decoParseSearch: SearchParser = (searchStr) => {
	const str = searchStr.startsWith("?") ? searchStr.slice(1) : searchStr;
	if (!str) return {};

	const params = new URLSearchParams(str);
	const result: Record<string, string | string[]> = {};

	for (const key of new Set(params.keys())) {
		const values = params.getAll(key);
		result[key] = values.length === 1 ? values[0] : values;
	}
	return result;
};

export const decoStringifySearch: SearchSerializer = (search) => {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(search)) {
		if (value === undefined || value === null || value === "") continue;
		if (Array.isArray(value)) {
			for (const v of value) params.append(key, String(v));
		} else {
			params.append(key, String(value));
		}
	}
	const str = params.toString();
	return str ? `?${str}` : "";
};

export interface CreateDecoRouterOptions {
	routeTree: AnyRoute;
	scrollRestoration?: boolean;
	defaultPreload?: "intent" | "viewport" | "render" | false;
	/**
	 * How long a preloaded route stays "fresh" before a click re-fetches it.
	 * When using `defaultPreload: "intent"`, this is what makes hover → click
	 * navigation truly instant. Without it, TanStack uses a short default and
	 * the prefetched data may be considered stale by the time the user clicks.
	 *
	 * Recommended for commerce storefronts: 60_000 (1 minute).
	 * @default undefined (TanStack default — short)
	 */
	defaultPreloadStaleTime?: number;
	/**
	 * How long a preloaded route stays in memory before garbage collection.
	 * @default undefined (TanStack default)
	 */
	defaultPreloadGcTime?: number;
	/**
	 * Delay before firing a preload after `hover`/`touchstart`.
	 * @default undefined (TanStack default — ~50ms)
	 */
	defaultPreloadDelay?: number;
	/**
	 * Default staleTime applied to all route loaders (not just preload).
	 * @default undefined (TanStack default — 0)
	 */
	defaultStaleTime?: number;
	/**
	 * Milliseconds to wait before showing the pending component on slow
	 * navigations. Useful when `eager` sections block the route swap.
	 * @default undefined (TanStack default)
	 */
	defaultPendingMs?: number;
	/**
	 * Minimum milliseconds the pending component must be shown once revealed.
	 * Prevents flash if the loader resolves right after the pending UI appears.
	 * @default undefined (TanStack default)
	 */
	defaultPendingMinMs?: number;
	trailingSlash?: TrailingSlashOption;
	/**
	 * Router context — passed to all route loaders/components via routeContext.
	 * Commonly used for { queryClient } per TanStack Query integration docs.
	 */
	context?: Record<string, unknown>;
	/**
	 * Non-DOM provider component to wrap the entire router.
	 * Per TanStack docs, only non-DOM-rendering components (providers) should
	 * be used — anything else causes hydration errors.
	 *
	 * Example: QueryClientProvider wrapping
	 *   Wrap: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
	 */
	Wrap?: (props: { children: any }) => any;
}

/**
 * Create a TanStack Router with Deco defaults:
 * - URLSearchParams-based search serialization (not JSON)
 * - Scroll restoration enabled
 * - Preload on intent
 *
 * For commerce storefronts, pair `defaultPreload: "intent"` (default) with
 * `defaultPreloadStaleTime: 60_000` so hover prefetch is reused on click —
 * see the `deco-pdp-fast-navigation` skill for the full pattern.
 */
export function createDecoRouter(options: CreateDecoRouterOptions) {
	const {
		routeTree,
		scrollRestoration = true,
		defaultPreload = "intent",
		defaultPreloadStaleTime,
		defaultPreloadGcTime,
		defaultPreloadDelay,
		defaultStaleTime,
		defaultPendingMs,
		defaultPendingMinMs,
		trailingSlash,
		context,
		Wrap,
	} = options;

	return createTanStackRouter({
		routeTree,
		scrollRestoration,
		defaultPreload,
		defaultPreloadStaleTime,
		defaultPreloadGcTime,
		defaultPreloadDelay,
		defaultStaleTime,
		defaultPendingMs,
		defaultPendingMinMs,
		trailingSlash,
		context: context as any,
		Wrap,
		parseSearch: decoParseSearch,
		stringifySearch: decoStringifySearch,
	});
}
