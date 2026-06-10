/**
 * A/B Testing wrapper for Cloudflare Worker entries.
 *
 * Provides KV-driven traffic splitting between the current TanStack Start
 * worker ("worker" bucket) and a fallback origin ("fallback" bucket, e.g.
 * legacy Deco/Fresh site). Designed for migration-period A/B testing.
 *
 * Features:
 * - FNV-1a IP hashing for stable, deterministic bucket assignment
 * - Sticky bucketing via cookie ("bucket:ratioPct" format) — the cookie carries
 *   a fingerprint of the KV ratio at the time of assignment. When the ratio
 *   changes in KV, all cookies with the old fingerprint are re-evaluated
 *   against the new threshold, so the distribution rebalances in one visit
 *   per user; once stable, cookies converge and become sticky again.
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

	/**
	 * Cookie max-age in seconds. @default 31536000 (1 year)
	 *
	 * Long by design: the cookie's ratio fingerprint handles invalidation
	 * (a change in KV ratio implicitly invalidates all old cookies), so
	 * there's no need for the browser to expire the cookie to pick up
	 * ratio changes. Shorter values just cause more user-bucket churn
	 * across sessions without any rebalancing benefit.
	 */
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
// Header constants
// ---------------------------------------------------------------------------

/**
 * Hop-by-hop headers per RFC 7230 §6.1 — must not be forwarded through
 * proxies. Plus `host`, which we always rewrite to the target origin.
 */
const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"transfer-encoding",
	"te",
	"trailer",
	"upgrade",
	"proxy-authorization",
	"proxy-authenticate",
]);

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
 * Convert a 0–1 ratio to a 0–100 integer percentage. Anchors the cookie
 * fingerprint to the resolution at which bucketing decisions are actually
 * made (`hash % 100 < ratio * 100`), so two equivalent ratios like 0.5 and
 * 0.500001 produce the same fingerprint and don't invalidate cookies.
 */
const RATIO_PCT_MAX = 100;

function ratioToPct(ratio: number): number {
	if (!Number.isFinite(ratio) || ratio <= 0) return 0;
	if (ratio >= 1) return RATIO_PCT_MAX;
	return Math.round(ratio * RATIO_PCT_MAX);
}

/**
 * Parse the bucket cookie value.
 *
 * Format: "worker:50" (bucket + ratioPct fingerprint, 0–100). The fingerprint
 * is the KV ratio at the time the cookie was set. Callers must compare it
 * against the current KV ratio and only honor the cookie when they match.
 *
 * Legacy formats ("worker:1711540800" with unix timestamp, or bare
 * "worker"/"fallback") parse to `null` so they're treated as missing and
 * re-evaluated against the current ratio. Those cookies vanish naturally
 * because the legacy default Max-Age was 1 day.
 */
function parseBucketCookie(
	raw: string | undefined,
): { bucket: Bucket; ratioPct: number } | null {
	if (!raw) return null;

	const colonIdx = raw.indexOf(":");
	if (colonIdx <= 0) return null;

	const bucket = raw.slice(0, colonIdx);
	if (bucket !== "worker" && bucket !== "fallback") return null;

	const ratioPct = parseInt(raw.slice(colonIdx + 1), 10);
	if (isNaN(ratioPct) || ratioPct < 0 || ratioPct > RATIO_PCT_MAX) return null;

	return { bucket, ratioPct };
}

// ---------------------------------------------------------------------------
// Public helpers (exported for custom composition)
// ---------------------------------------------------------------------------

/**
 * Deterministically assign a bucket based on:
 * 1. Query param override (?_deco_bucket=worker)
 * 2. Existing cookie whose ratio fingerprint matches the current KV ratio
 * 3. IP hash against ratio threshold
 *
 * Step 2 is the key correctness property: a cookie set when the KV ratio
 * was X is only trusted while the KV ratio is still X. When the operator
 * changes the ratio in KV, all cookies with the old fingerprint fall
 * through to step 3 and are re-evaluated against the new threshold — the
 * fnv1a IP hash being deterministic means each user converges to the new
 * distribution in a single visit, then the cookie is re-issued with the
 * new fingerprint and becomes sticky again.
 */
export function getStableBucket(
	request: Request,
	ratio: number,
	url: URL,
	cookieName: string = "_deco_bucket",
): Bucket {
	const override = url.searchParams.get(cookieName);
	if (override === "worker" || override === "fallback") return override;

	const currentRatioPct = ratioToPct(ratio);
	const cookies = parseCookies(request.headers.get("cookie") ?? "");
	const parsed = parseBucketCookie(cookies[cookieName]);
	if (parsed && parsed.ratioPct === currentRatioPct) return parsed.bucket;

	if (currentRatioPct <= 0) return "fallback";
	if (currentRatioPct >= RATIO_PCT_MAX) return "worker";

	const ip =
		request.headers.get("cf-connecting-ip") ?? Math.random().toString();
	return fnv1a(ip) % RATIO_PCT_MAX < currentRatioPct ? "worker" : "fallback";
}

/**
 * Tag a response with the bucket assignment and refresh the sticky cookie
 * when the current bucket/ratio differs from what the cookie carries.
 *
 * The cookie value is `<bucket>:<ratioPct>` — see `parseBucketCookie`. The
 * fingerprint is what makes ratio changes in KV propagate automatically:
 * when the operator bumps the ratio, this function rewrites the cookie on
 * the next response so the user starts honoring the new threshold.
 */
export function tagBucket(
	response: Response,
	bucket: Bucket,
	hostname: string,
	request: Request,
	ratio: number,
	cookieName: string = "_deco_bucket",
	maxAge: number = 60 * 60 * 24 * 365,
): Response {
	const res = new Response(response.body, response);
	res.headers.set("x-deco-bucket", bucket);

	const currentRatioPct = ratioToPct(ratio);
	const cookies = parseCookies(request.headers.get("cookie") ?? "");
	const parsed = parseBucketCookie(cookies[cookieName]);

	const needsSet =
		!parsed ||
		parsed.bucket !== bucket ||
		parsed.ratioPct !== currentRatioPct;

	if (needsSet) {
		res.headers.append(
			"set-cookie",
			`${cookieName}=${bucket}:${currentRatioPct}; Path=/; Max-Age=${maxAge}; Domain=${hostname}; SameSite=Lax`,
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
 *
 * **`redirect: "manual"` is critical.** The request body is forwarded as a
 * stream (`duplex: "half"`) and is consumed by this first fetch. If the
 * upstream returns a 301/302 and we let CF auto-follow, the runtime would
 * try to replay the request and throw `Cannot reconstruct a Request with
 * a used body.` Instead we forward the 3xx response to the client so the
 * client (browser/curl) follows it on its own. The Location header is
 * rewritten below so the next hop targets the real hostname.
 */
export async function proxyToFallback(
	request: Request,
	url: URL,
	fallbackOrigin: string,
): Promise<Response> {
	const target = new URL(url.toString());
	target.hostname = fallbackOrigin;

	// Strip hop-by-hop headers + Host before forwarding. Without this the
	// upstream may close the connection (Connection: close) or get confused
	// by Transfer-Encoding/Upgrade meant for the original CF↔client hop.
	const headers = new Headers();
	for (const [key, value] of request.headers.entries()) {
		const lk = key.toLowerCase();
		if (lk === "host") continue;
		if (HOP_BY_HOP_HEADERS.has(lk)) continue;
		headers.set(key, value);
	}
	headers.set("x-forwarded-host", url.hostname);

	const init: RequestInit = {
		method: request.method,
		headers,
		redirect: "manual",
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

	// Only rewrite text bodies on 2xx successful responses. Reading
	// `response.text()` on a 3xx (forwarded redirect) or binary response
	// would consume the stream needlessly and could throw on non-text
	// content. The Location header is rewritten separately further down.
	let body: BodyInit | null = response.body;
	if (
		isText &&
		response.body &&
		response.status >= 200 &&
		response.status < 300
	) {
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
		cookieMaxAge = 60 * 60 * 24 * 365,
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

			// Tee the request so the outer `catch` below can still pass the
			// original (with body intact) to `handler.fetch` if proxyToFallback
			// somehow throws after consuming the body. `Request.clone()` is
			// safe in CF Workers — it tees the underlying stream.
			const fallbackRequest = request.clone();

			try {
				if (bucket === "fallback") {
					const response = await proxyToFallback(
						fallbackRequest,
						url,
						siteConfig.fallbackOrigin,
					);
					return tagBucket(
						response,
						bucket,
						url.hostname,
						request,
						ratio,
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
						ratio,
						cookieName,
						cookieMaxAge,
					);
				} catch (err) {
					if (!circuitBreaker) throw err;
					console.error(
						"[A/B] Worker error, circuit breaker → fallback:",
						err,
					);
					// Use the teed clone — handler.fetch above may have already
					// consumed the original request body before throwing.
					const response = await proxyToFallback(
						fallbackRequest,
						url,
						siteConfig.fallbackOrigin,
					);
					return tagBucket(
						response,
						"fallback",
						url.hostname,
						request,
						ratio,
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
