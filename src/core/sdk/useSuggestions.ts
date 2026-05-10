/**
 * Search-suggestions hook factory.
 *
 * Both casaevideo-storefront and baggagio-tanstack independently
 * invented the same shape for autocomplete-style suggestions:
 *
 *  - module-level signal for the current payload + loading flag
 *  - serial in-flight queue so older requests can't race past newer ones
 *  - "is this still the latest query?" cancel guard
 *  - posts to `/deco/invoke/<__resolveType>` with the loader's
 *    extra props + the live `query` string
 *
 * This factory is the canonical version. Sites instantiate it once
 * at module load with their concrete suggestion type and (optionally)
 * an `onError` hook for observability (Sentry / OpenTelemetry / etc.).
 *
 * Why a factory and not a plain hook:
 *  - Each call to `createUseSuggestions()` produces an isolated
 *    `payload` / `loading` / queue. Keeps the door open for sites
 *    with multiple independent suggestion streams (e.g. searchbar
 *    *and* a category-jump suggester) without globally-shared state.
 *  - Type narrowing happens at the factory boundary, not at hook
 *    usage — the returned `useSuggestions` is already specialised
 *    on `T` so callers don't need to re-pass generics.
 *  - Mirrors the existing `createUseCart` / `createUseUser` /
 *    `createUseWishlist` factory pattern from
 *    `@decocms/apps/vtex/hooks/*`. See
 *    `references/platform-hooks-factories.md`.
 */

import { useCallback } from "react";
import type { Resolved } from "../types";
import { signal, type ReactiveSignal } from "./signal";

/**
 * Optional dependencies the factory accepts at instantiation time.
 *
 * Most are pure observability hooks — the factory itself runs a
 * `console.error()` after invoking `onError`, so callers don't have
 * to remember to forward the error to the console themselves.
 */
export interface UseSuggestionsOptions {
	/**
	 * Called once per failed fetch with the original error and the
	 * query that triggered it. Use for Sentry / OTEL captures.
	 *
	 * The factory still calls `console.error` after this returns so
	 * sites that don't wire `onError` keep the same console output.
	 */
	onError?: (error: unknown, query: string) => void;

	/**
	 * Override the fetch implementation. Tests pass a stub here; the
	 * default is the global `fetch`. Production sites have no reason
	 * to set this.
	 */
	fetchImpl?: typeof fetch;
}

/**
 * Shape returned by the hook produced by `createUseSuggestions`.
 *
 * `loading` and `payload` are reactive signals — subscribe with
 * `useStore()` from `@tanstack/react-store` (or read `.value`
 * directly inside an `useEffect`).
 */
export interface UseSuggestionsReturn<T> {
	loading: ReactiveSignal<boolean>;
	payload: ReactiveSignal<T | null>;
	/**
	 * Trigger a suggestion fetch for `query`. Calls coalesce through
	 * a serial promise queue, and only the *latest* query's result
	 * is allowed to flip `loading` back to `false` — so rapid keystrokes
	 * don't leave the UI permanently in a stale loading state.
	 */
	setQuery: (query: string) => void;
}

/**
 * Returned by {@link createUseSuggestions}.
 *
 * `useSuggestions` is the React hook bound to this factory's state.
 * The `_internal` field exposes the underlying signals and a non-
 * React `setQuery` for advanced cases (SSR pre-population, unit
 * tests, server-side warmup). Sites almost never need it.
 */
export interface CreateUseSuggestionsReturn<T> {
	useSuggestions: (loader: Resolved<T | null>) => UseSuggestionsReturn<T>;
	_internal: {
		readonly payload: ReactiveSignal<T | null>;
		readonly loading: ReactiveSignal<boolean>;
		/**
		 * Same semantics as `useSuggestions(...).setQuery`, but pure JS —
		 * no React hook context required. Useful in unit tests and for
		 * SSR pre-fetch helpers.
		 */
		setQuery: (query: string, loader: Resolved<T | null>) => void;
		/**
		 * Promise that resolves once every queued fetch has settled.
		 * Tests await this to assert post-cancellation state.
		 */
		readonly drain: () => Promise<unknown>;
	};
}

/**
 * Build a typed `useSuggestions` hook bound to a private
 * `payload` / `loading` / queue tuple. Call once per stream at
 * module load.
 *
 * @example
 *   // site/src/sdk/useSuggestions.ts
 *   import { createUseSuggestions } from "@decocms/start/sdk/useSuggestions";
 *   import * as Sentry from "@sentry/react";
 *   import type { Suggestion } from "@decocms/apps/commerce/types";
 *
 *   export const { useSuggestions } = createUseSuggestions<Suggestion>({
 *     onError: (err) => Sentry.captureException(err),
 *   });
 */
export function createUseSuggestions<T>(
	options: UseSuggestionsOptions = {},
): CreateUseSuggestionsReturn<T> {
	const payload = signal<T | null>(null);
	const loading = signal<boolean>(false);
	let queue: Promise<unknown> = Promise.resolve();
	let latestQuery = "";

	const fetchImpl = options.fetchImpl ?? fetch;
	const onError = options.onError;

	async function doFetch(
		query: string,
		resolved: Resolved<T | null>,
	): Promise<void> {
		if (latestQuery !== query) return;

		const { __resolveType, ...extraProps } = resolved as {
			__resolveType: string;
			[k: string]: unknown;
		};

		try {
			const response = await fetchImpl(`/deco/invoke/${__resolveType}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query, ...extraProps }),
			});
			if (!response.ok) {
				throw new Error(`Suggestions invoke failed: ${response.status}`);
			}
			payload.value = (await response.json()) as T | null;
		} catch (error) {
			onError?.(error, query);
			console.error("[useSuggestions] fetch failed:", error);
		} finally {
			// Only the latest query is allowed to flip the loading flag —
			// otherwise rapid keystrokes can leave the UI in a stale
			// "still loading" state because an older fetch resolved last.
			if (latestQuery === query) loading.value = false;
		}
	}

	function setQueryImpl(query: string, loader: Resolved<T | null>): void {
		loading.value = true;
		latestQuery = query;
		queue = queue.then(() => doFetch(query, loader));
	}

	function useSuggestions(loader: Resolved<T | null>): UseSuggestionsReturn<T> {
		const setQuery = useCallback(
			(query: string) => setQueryImpl(query, loader),
			[loader],
		);

		return { loading, payload, setQuery };
	}

	return {
		useSuggestions,
		_internal: {
			payload,
			loading,
			setQuery: setQueryImpl,
			drain: () => queue,
		},
	};
}
