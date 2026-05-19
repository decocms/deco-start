/**
 * A/B Testing wrapper for Cloudflare Worker entries.
 *
 * Provides KV-driven traffic splitting between the current TanStack Start
 * worker ("worker" bucket) and a fallback origin ("fallback" bucket, e.g.
 * legacy Deco/Fresh site). Designed for migration-period A/B testing.
 *
 * Features:
 * - FNV-1a IP hashing for stable, deterministic bucket assignment
 * - Sticky bucketing via cookie ("bucket:timestamp" format)
 * - Query param override for QA (?_deco_bucket=worker)
 * - Circuit breaker: worker errors auto-fallback to legacy origin
 * - Fallback proxy with hostname rewriting (Set-Cookie, Location, body)
 * - Configurable bypass for paths that must always use the worker
 *   (e.g. VTEX checkout proxy paths)
 *
 * @example
 * ```ts
 * import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
 * import { withABTesting } from "@decocms/start/sdk/abTesting";
 *
 * const decoWorker = createDecoWorkerEntry(serverEntry, { ... });
 *
 * export default withABTesting(decoWorker, {
 *   kvBinding: "SITES_KV",
 *   shouldBypassAB: (request, url) => isVtexPath(url.pathname),
 * });
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkerExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
}

export interface WorkerHandler {
	fetch(
		request: Request,
		env: Record<string, unknown>,
		ctx: WorkerExecutionContext,
	): Promise<Response>;
}

interface KVNamespace {
	get<T = string>(key: string, type: "json"): Promise<T | null>;
	get(key: string, type?: "text"): Promise<string | null>;
}

/** KV value shape — same as the original cf-gateway config. */
export interface SiteConfig {
	workerName: string;
	fallbackOrigin: string;
	abTest?: { ratio: number };
}

export type Bucket = "worker" | "fallback";

export interface ABTestConfig {
	/** KV namespace binding name. @default "SITES_KV" */
	kvBinding?: string;

	/** Cookie name for bucket persistence. @default "_deco_bucket" */
	cookieName?: string;

	/** Cookie max-age in seconds. @default 86400 (1 day) */
	cookieMaxAge?: number;

	/** Auto-fallback to legacy on worker errors. @default true */
	circuitBreaker?: boolean;

	/**
	 * Return `true` to bypass A/B for this request — always serve from
	 * the worker regardless of bucket assignment.
	 *
	 * Useful for commerce backend paths (checkout, /api/*) that must
	 * not be proxied through the fallback origin.
	 */
	shouldBypassAB?: (request: Request, url: URL) => boolean;

	/**
	 * Called before the A/B logic runs. Return a `Response` to short-circuit
	 * (e.g. for CMS redirects), or `null` to continue with A/B.
	 */
	preHandler?: (
		request: Request,
		url: URL,
	) => Response | Promise<Response | null> | null;
}

// ---------------------------------------------------------------------------
// FNV-1a 32-bit — fast, good distribution for short strings like IPs.
// Same hash used by the original cf-gateway.
// ---------------------------------------------------------------------------

function fnv1a(str: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return Math.abs(hash);
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function parseCookies(header: string): Record<string, string> {
	return Object.fromEntries(
		header.split(";").map((c) => {
			const [k, ...v] = c.trim().split("=");
			return [k, v.join("=")];
		}),
	);
}

/**
 * Parse the bucket cookie value.
 *
 * New format: "worker:1711540800" (bucket + unix timestamp).
 * Legacy format: "worker" or "fallback" (no timestamp — old 30d cookie).
 */
function parseBucketCookie(
	raw: string | undefined,
): { bucket: Bucket; ts: number } | null {
	if (!raw) return null;

	const colonIdx = raw.indexOf(":");
	if (colonIdx > 0) {
		const bucket = raw.slice(0, colonIdx);
		const ts = parseInt(raw.slice(colonIdx + 1), 10);
		if ((bucket === "worker" || bucket === "fallback") && !isNaN(ts)) {
			return { bucket, ts };
		}
	}

	if (raw === "worker" || raw === "fallback") {
		return { bucket: raw, ts: 0 };
	}

	return null;
}

// ---------------------------------------------------------------------------
// Public helpers (exported for custom composition)
// ---------------------------------------------------------------------------

/**
 * Deterministically assign a bucket based on:
 * 1. Query param override (?_deco_bucket=worker)
 * 2. Existing cookie (stickiness)
 * 3. IP hash against ratio threshold
 */
export function getStableBucket(
	request: Request,
	ratio: number,
	url: URL,
	cookieName: string = "_deco_bucket",
): Bucket {
	const override = url.searchParams.get(cookieName);
	if (override === "worker" || override === "fallback") return override;

	const cookies = parseCookies(request.headers.get("cookie") ?? "");
	const parsed = parseBucketCookie(cookies[cookieName]);
	if (parsed) return parsed.bucket;

	if (ratio <= 0) return "fallback";
	if (ratio >= 1) return "worker";

	const ip =
		request.headers.get("cf-connecting-ip") ?? Math.random().toString();
	return fnv1a(ip) % 100 < ratio * 100 ? "worker" : "fallback";
}

/**
 * Tag a response with the bucket assignment and refresh the sticky cookie
 * if needed (missing, changed, or stale).
 */
export function tagBucket(
	response: Response,
	bucket: Bucket,
	hostname: string,
	request: Request,
	cookieName: string = "_deco_bucket",
	maxAge: number = 86400,
): Response {
	const res = new Response(response.body, response);
	res.headers.set("x-deco-bucket", bucket);

	const cookies = parseCookies(request.headers.get("cookie") ?? "");
	const parsed = parseBucketCookie(cookies[cookieName]);
	const now = Math.floor(Date.now() / 1000);

	const needsSet =
		!parsed || parsed.bucket !== bucket || now - parsed.ts > maxAge;

	if (needsSet) {
		res.headers.append(
			"set-cookie",
			`${cookieName}=${bucket}:${now}; Path=/; Max-Age=${maxAge}; Domain=${hostname}; SameSite=Lax`,
		);
	}

	return res;
}

/**
 * Proxy a request to the fallback origin with full hostname rewriting.
 *
 * Rewrites:
 * 1. URL hostname → fallback origin
 * 2. Set-Cookie Domain → real hostname
 * 3. Body text: fallback hostname → real hostname (for Fresh partial URLs)
 * 4. Location header → real hostname
 */
export async function proxyToFallback(
	request: Request,
	url: URL,
	fallbackOrigin: string,
): Promise<Response> {
	const target = new URL(url.toString());
	target.hostname = fallbackOrigin;

	const headers = new Headers(request.headers);
	headers.delete("host");
	headers.set("x-forwarded-host", url.hostname);

	const init: RequestInit = {
		method: request.method,
		headers,
	};
	if (request.method !== "GET" && request.method !== "HEAD") {
		init.body = request.body;
		// @ts-expect-error -- needed for streaming body in Workers
		init.duplex = "half";
	}
	const response = await fetch(target.toString(), init);

	const ct = response.headers.get("content-type") ?? "";
	const isText =
		ct.includes("text/") || ct.includes("json") || ct.includes("javascript");

	let body: BodyInit | null = response.body;
	if (isText && response.body) {
		const text = await response.text();
		body = text.replaceAll(fallbackOrigin, url.hostname);
	}

	const rewritten = new Response(body, response);

	const setCookies = response.headers.getSetCookie?.() ?? [];
	if (setCookies.length > 0) {
		rewritten.headers.delete("set-cookie");
		for (const cookie of setCookies) {
			rewritten.headers.append(
				"set-cookie",
				cookie.replace(
					new RegExp(
						`Domain=\\.?${fallbackOrigin.replace(/\./g, "\\.")}`,
						"gi",
					),
					`Domain=.${url.hostname}`,
				),
			);
		}
	}

	const location = response.headers.get("location");
	if (location?.includes(fallbackOrigin)) {
		rewritten.headers.set(
			"location",
			location.replaceAll(fallbackOrigin, url.hostname),
		);
	}

	return rewritten;
}

// ---------------------------------------------------------------------------
// Main wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a Deco worker entry with A/B testing support.
 *
 * Reads config from Cloudflare KV by hostname, assigns buckets,
 * and proxies fallback traffic to the legacy origin.
 *
 * When no KV binding is available or no config exists for the hostname,
 * all traffic goes directly to the inner handler (no A/B).
 */
export function withABTesting(
	handler: WorkerHandler,
	config: ABTestConfig = {},
): WorkerHandler {
	const {
		kvBinding = "SITES_KV",
		cookieName = "_deco_bucket",
		cookieMaxAge = 86400,
		circuitBreaker = true,
		shouldBypassAB,
		preHandler,
	} = config;

	return {
		async fetch(
			request: Request,
			env: Record<string, unknown>,
			ctx: WorkerExecutionContext,
		): Promise<Response> {
			const url = new URL(request.url);

			// Pre-handler (e.g. CMS redirects) — runs before A/B
			if (preHandler) {
				const pre = await preHandler(request, url);
				if (pre) return pre;
			}

			const kv = env[kvBinding] as KVNamespace | undefined;
			if (!kv) {
				return handler.fetch(request, env, ctx);
			}

			const siteConfig = await kv.get<SiteConfig>(url.hostname, "json");
			if (!siteConfig?.fallbackOrigin) {
				return handler.fetch(request, env, ctx);
			}

			// Bypass A/B for certain paths (e.g. checkout, API)
			if (shouldBypassAB?.(request, url)) {
				return handler.fetch(request, env, ctx);
			}

			const ratio = siteConfig.abTest?.ratio ?? 0;
			const bucket = getStableBucket(request, ratio, url, cookieName);

			try {
				if (bucket === "fallback") {
					const response = await proxyToFallback(
						request,
						url,
						siteConfig.fallbackOrigin,
					);
					return tagBucket(
						response,
						bucket,
						url.hostname,
						request,
						cookieName,
						cookieMaxAge,
					);
				}

				// Worker bucket
				try {
					const response = await handler.fetch(request, env, ctx);
					return tagBucket(
						response,
						bucket,
						url.hostname,
						request,
						cookieName,
						cookieMaxAge,
					);
				} catch (err) {
					if (!circuitBreaker) throw err;
					console.error(
						"[A/B] Worker error, circuit breaker → fallback:",
						err,
					);
					const response = await proxyToFallback(
						request,
						url,
						siteConfig.fallbackOrigin,
					);
					return tagBucket(
						response,
						"fallback",
						url.hostname,
						request,
						cookieName,
						cookieMaxAge,
					);
				}
			} catch (err) {
				console.error(
					"[A/B] Fatal proxy error, passing through to handler:",
					err,
				);
				return handler.fetch(request, env, ctx);
			}
		},
	};
}
