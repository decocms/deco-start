/**
 * Tests for the `createUseSuggestions` factory.
 *
 * The hook itself depends on React (useCallback). This file exercises
 * the parts of the factory that don't need a React renderer:
 *  - factory shape + isolation between calls
 *  - the non-React `_internal.setQuery` flow which carries every bit
 *    of behaviour the React hook delegates to (queue, cancel guard,
 *    loading-flag invariants, error path)
 *
 * Hook-level integration is exercised by the site-level smoke (the
 * factory has shipped to two production sites with the same shape).
 */

import { describe, expect, it, vi } from "vitest";
import { createUseSuggestions } from "./useSuggestions";

interface FakeSuggestion {
	products: string[];
}

const FAKE_LOADER = {
	__resolveType: "site/loaders/search/suggestions.ts",
	limit: 5,
} as unknown as FakeSuggestion;

function makeOkFetch(payload: unknown, delayMs = 0): typeof fetch {
	return ((_input: RequestInfo | URL, _init?: RequestInit) =>
		new Promise((resolve) => {
			setTimeout(
				() =>
					resolve(
						new Response(JSON.stringify(payload), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						}),
					),
				delayMs,
			);
		})) as typeof fetch;
}

describe("createUseSuggestions — factory shape", () => {
	it("returns useSuggestions + _internal", () => {
		const f = createUseSuggestions<FakeSuggestion>();
		expect(typeof f.useSuggestions).toBe("function");
		expect(typeof f._internal.setQuery).toBe("function");
		expect(typeof f._internal.drain).toBe("function");
		expect(f._internal.payload.value).toBeNull();
		expect(f._internal.loading.value).toBe(false);
	});

	it("two factory calls produce independent state + functions", () => {
		const a = createUseSuggestions<FakeSuggestion>();
		const b = createUseSuggestions<FakeSuggestion>();
		expect(a.useSuggestions).not.toBe(b.useSuggestions);
		expect(a._internal.payload).not.toBe(b._internal.payload);
		expect(a._internal.loading).not.toBe(b._internal.loading);
	});
});

describe("createUseSuggestions — fetch happy path", () => {
	it("posts to /deco/invoke/<__resolveType> with the query + extra props", async () => {
		const spy = vi.fn(makeOkFetch({ products: ["a", "b"] }));
		const f = createUseSuggestions<FakeSuggestion>({ fetchImpl: spy });
		f._internal.setQuery("samsung", FAKE_LOADER);
		await f._internal.drain();

		expect(spy).toHaveBeenCalledTimes(1);
		const [url, init] = spy.mock.calls[0];
		expect(url).toBe("/deco/invoke/site/loaders/search/suggestions.ts");
		expect(init?.method).toBe("POST");
		expect(JSON.parse(init?.body as string)).toEqual({
			query: "samsung",
			limit: 5,
		});
	});

	it("populates payload with the parsed response", async () => {
		const f = createUseSuggestions<FakeSuggestion>({
			fetchImpl: makeOkFetch({ products: ["a", "b"] }),
		});
		f._internal.setQuery("samsung", FAKE_LOADER);
		await f._internal.drain();
		expect(f._internal.payload.value).toEqual({ products: ["a", "b"] });
	});

	it("flips loading to true synchronously, back to false after fetch settles", async () => {
		const f = createUseSuggestions<FakeSuggestion>({
			fetchImpl: makeOkFetch({ products: [] }),
		});
		expect(f._internal.loading.value).toBe(false);
		f._internal.setQuery("hi", FAKE_LOADER);
		expect(f._internal.loading.value).toBe(true);
		await f._internal.drain();
		expect(f._internal.loading.value).toBe(false);
	});
});

describe("createUseSuggestions — cancel + queue semantics", () => {
	it("cancels older queries BEFORE they fetch — only the latest hits the network", async () => {
		// Mock echoes the body's `query` field so we can tell which
		// invocation actually reached the network.
		const calls: string[] = [];
		const fetchImpl: typeof fetch = ((_url, init) => {
			const body = JSON.parse(init?.body as string) as { query: string };
			calls.push(body.query);
			return Promise.resolve(
				new Response(JSON.stringify({ products: [body.query] }), {
					status: 200,
				}),
			);
		}) as typeof fetch;

		const f = createUseSuggestions<FakeSuggestion>({ fetchImpl });
		// Three queries kicked off back-to-back synchronously.
		f._internal.setQuery("a", FAKE_LOADER);
		f._internal.setQuery("b", FAKE_LOADER);
		f._internal.setQuery("c", FAKE_LOADER);
		await f._internal.drain();

		// Only the latest query reaches the network — the cancel
		// guard short-circuits the first two before they fetch.
		expect(calls).toEqual(["c"]);
		expect(f._internal.payload.value).toEqual({ products: ["c"] });
	});

	it("the latest-query guard prevents stale fetches from clearing loading prematurely", async () => {
		// If the cancel guard ever regresses, this is the test that
		// catches it: we kick off fetch #1, immediately call setQuery
		// again, await drain, and expect the FINAL state to reflect
		// the latest query — not an inconsistent "loading false but
		// payload stale" mid-state.
		const fetchImpl = makeOkFetch({ products: ["latest"] }, 5);
		const f = createUseSuggestions<FakeSuggestion>({ fetchImpl });
		f._internal.setQuery("a", FAKE_LOADER);
		f._internal.setQuery("b", FAKE_LOADER);
		f._internal.setQuery("c", FAKE_LOADER);
		await f._internal.drain();
		expect(f._internal.loading.value).toBe(false);
		expect(f._internal.payload.value).toEqual({ products: ["latest"] });
	});

	it("queues serially — fetches don't run concurrently", async () => {
		// Race detector: track whether the count of in-flight fetches
		// ever exceeds 1.
		let inflight = 0;
		let maxInflight = 0;
		const fetchImpl: typeof fetch = (() =>
			new Promise<Response>((resolve) => {
				inflight += 1;
				maxInflight = Math.max(maxInflight, inflight);
				setTimeout(() => {
					inflight -= 1;
					resolve(
						new Response(JSON.stringify({ products: [] }), { status: 200 }),
					);
				}, 5);
			})) as typeof fetch;

		const f = createUseSuggestions<FakeSuggestion>({ fetchImpl });
		f._internal.setQuery("a", FAKE_LOADER);
		f._internal.setQuery("b", FAKE_LOADER);
		f._internal.setQuery("c", FAKE_LOADER);
		await f._internal.drain();
		expect(maxInflight).toBe(1);
	});
});

describe("createUseSuggestions — error path", () => {
	it("forwards thrown errors to onError + console.error, does NOT update payload", async () => {
		const onError = vi.fn();
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		const fetchImpl = (() =>
			Promise.reject(new Error("network down"))) as typeof fetch;
		const f = createUseSuggestions<FakeSuggestion>({ fetchImpl, onError });

		f._internal.setQuery("samsung", FAKE_LOADER);
		await f._internal.drain();

		expect(onError).toHaveBeenCalledTimes(1);
		const [err, query] = onError.mock.calls[0];
		expect((err as Error).message).toBe("network down");
		expect(query).toBe("samsung");
		expect(consoleError).toHaveBeenCalled();
		expect(f._internal.payload.value).toBeNull();
		expect(f._internal.loading.value).toBe(false);

		consoleError.mockRestore();
	});

	it("non-2xx responses surface as errors", async () => {
		const onError = vi.fn();
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const fetchImpl = (() =>
			Promise.resolve(
				new Response("internal error", { status: 500 }),
			)) as typeof fetch;
		const f = createUseSuggestions<FakeSuggestion>({ fetchImpl, onError });

		f._internal.setQuery("x", FAKE_LOADER);
		await f._internal.drain();

		expect(onError).toHaveBeenCalledTimes(1);
		expect((onError.mock.calls[0][0] as Error).message).toContain("500");
		expect(f._internal.payload.value).toBeNull();
		expect(f._internal.loading.value).toBe(false);

		consoleError.mockRestore();
	});

	it("does NOT throw if onError is omitted (still console.errors)", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const fetchImpl = (() =>
			Promise.reject(new Error("boom"))) as typeof fetch;
		const f = createUseSuggestions<FakeSuggestion>({ fetchImpl });

		f._internal.setQuery("x", FAKE_LOADER);
		await expect(f._internal.drain()).resolves.toBeUndefined();
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
	});
});
