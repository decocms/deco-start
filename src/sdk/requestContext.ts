/**
 * Per-request context via AsyncLocalStorage.
 *
 * Binds request-scoped state (request, abort signal, device info, flags)
 * that any code in the call stack can access without prop drilling.
 *
 * Requires `nodejs_compat` in wrangler.jsonc (already enabled).
 *
 * **Design decisions:**
 * - We do NOT monkey-patch global `fetch`. Instead, `RequestContext.fetch`
 *   provides a fetch that auto-injects the request's AbortSignal.
 * - The context is optional -- code that doesn't need it just doesn't call it.
 *   Commerce loaders receive it explicitly via the updated `CommerceLoader` sig.
 *
 * @example
 * ```ts
 * // In TanStack Start middleware:
 * import { RequestContext } from "@decocms/start/sdk/requestContext";
 *
 * const middleware = createMiddleware().server(async ({ next, request }) => {
 *   return RequestContext.run(request, () => next());
 * });
 *
 * // Anywhere in the call stack:
 * const req = RequestContext.request;       // the current request
 * const signal = RequestContext.signal;     // AbortSignal
 * const resp = await RequestContext.fetch(url); // auto-aborts on disconnect
 * ```
 */

import { AsyncLocalStorage } from "node:async_hooks";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export interface RequestContextData {
  request: Request;
  signal: AbortSignal;
  startedAt: number;
  /** Lazily computed device type. */
  _device?: "mobile" | "desktop";
  /** Lazily computed bot detection result. */
  _isBot?: boolean;
  /** Arbitrary bag for middleware to attach custom data. */
  bag: Map<string, unknown>;
}

// -------------------------------------------------------------------------
// Storage
// -------------------------------------------------------------------------

const storage = new AsyncLocalStorage<RequestContextData>();

import { isMobileUA } from "./useDevice";

const BOT_RE =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|linkedinbot|twitterbot|whatsapp|telegram|googlebot|yandex|baidu|duckduck/i;

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

export const RequestContext = {
  /**
   * Run a function within a request context.
   *
   * Call this at the outermost middleware level. Everything inside
   * the callback (loaders, resolvers, utilities) can access the
   * context via the static getters.
   */
  run<T>(request: Request, fn: () => T): T {
    const controller = new AbortController();

    if (request.signal) {
      if (request.signal.aborted) {
        controller.abort(request.signal.reason);
      } else {
        request.signal.addEventListener("abort", () => controller.abort(request.signal.reason), {
          once: true,
        });
      }
    }

    const ctx: RequestContextData = {
      request,
      signal: controller.signal,
      startedAt: Date.now(),
      bag: new Map(),
    };

    return storage.run(ctx, fn);
  },

  /**
   * Get the current request context, or null if not in a request scope.
   */
  get current(): RequestContextData | null {
    return storage.getStore() ?? null;
  },

  /**
   * Get the current Request object.
   * @throws if called outside a request context
   */
  get request(): Request {
    const ctx = storage.getStore();
    if (!ctx) throw new Error("RequestContext.request accessed outside a request scope");
    return ctx.request;
  },

  /**
   * Get the current AbortSignal.
   * Use this to cancel in-flight operations when the client disconnects.
   */
  get signal(): AbortSignal {
    const ctx = storage.getStore();
    if (!ctx) throw new Error("RequestContext.signal accessed outside a request scope");
    return ctx.signal;
  },

  /**
   * Detected device type based on User-Agent.
   */
  get device(): "mobile" | "desktop" {
    const ctx = storage.getStore();
    if (!ctx) return "desktop";
    if (ctx._device) return ctx._device;
    const ua = ctx.request.headers.get("user-agent") ?? "";
    ctx._device = isMobileUA(ua) ? "mobile" : "desktop";
    return ctx._device;
  },

  /**
   * Whether the request appears to be from a bot/crawler.
   */
  get isBot(): boolean {
    const ctx = storage.getStore();
    if (!ctx) return false;
    if (ctx._isBot !== undefined) return ctx._isBot;
    const ua = ctx.request.headers.get("user-agent") ?? "";
    ctx._isBot = BOT_RE.test(ua);
    return ctx._isBot;
  },

  /**
   * Elapsed time since the request started (in milliseconds).
   */
  get elapsed(): number {
    const ctx = storage.getStore();
    if (!ctx) return 0;
    return Date.now() - ctx.startedAt;
  },

  /**
   * Fetch with automatic AbortSignal injection.
   *
   * When the client disconnects, this fetch aborts automatically.
   * This is NOT a global monkey-patch -- only code that explicitly
   * calls `RequestContext.fetch()` gets this behavior.
   */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const ctx = storage.getStore();
    if (!ctx) return globalThis.fetch(input, init);

    return globalThis.fetch(input, {
      ...init,
      signal: init?.signal ?? ctx.signal,
    });
  },

  /**
   * Get/set arbitrary values in the request bag.
   * Useful for middleware to pass data to loaders.
   */
  getBag<T>(key: string): T | undefined {
    const ctx = storage.getStore();
    return ctx?.bag.get(key) as T | undefined;
  },

  setBag(key: string, value: unknown): void {
    const ctx = storage.getStore();
    ctx?.bag.set(key, value);
  },
};
