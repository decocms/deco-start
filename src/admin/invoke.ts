/**
 * Handles /deco/invoke -- executes loaders and actions by key.
 *
 * Supports:
 * - Single invoke by key: POST /deco/invoke/some/loader.ts
 * - Batch invoke: POST /deco/invoke with { key: payload } body
 * - FormData parsing for file uploads and form submissions
 * - `?select=field1,field2` to pick fields from the result
 * - Resolves __resolveType in batch payloads
 *
 * Handlers can write to `RequestContext.responseHeaders` to forward
 * headers (e.g., Set-Cookie from VTEX checkout). The invoke endpoint
 * copies those headers into the final HTTP Response.
 */

import { RequestContext } from "../sdk/requestContext";

export type InvokeLoader = (props: any, request: Request) => Promise<any>;
export type InvokeAction = (props: any, request: Request) => Promise<any>;

// Additive handler registry — registerInvokeHandlers() adds to this map.
const handlerRegistry = new Map<string, InvokeLoader | InvokeAction>();

// Legacy getter-based registries (backward compat for setInvokeLoaders/Actions).
let getRegisteredLoaders: () => Record<string, InvokeLoader> = () => ({});
let getRegisteredActions: () => Record<string, InvokeAction> = () => ({});

export function setInvokeLoaders(getter: () => Record<string, InvokeLoader>) {
  getRegisteredLoaders = getter;
}

export function setInvokeActions(getter: () => Record<string, InvokeAction>) {
  getRegisteredActions = getter;
}

/**
 * Additive handler registration — adds handlers without replacing existing ones.
 * First registration wins: if a key already exists, it is NOT overwritten.
 * Use this for automatic manifest-based registration from setupApps().
 */
export function registerInvokeHandlers(
  handlers: Record<string, InvokeLoader | InvokeAction>,
): void {
  for (const [key, handler] of Object.entries(handlers)) {
    if (!handlerRegistry.has(key)) {
      handlerRegistry.set(key, handler);
    }
  }
}

/**
 * Clear all registered invoke handlers.
 * Called by setupApps() before re-registering on hot-reload.
 */
export function clearInvokeHandlers(): void {
  handlerRegistry.clear();
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

const isDev =
  typeof globalThis.process !== "undefined" && globalThis.process.env?.NODE_ENV === "development";

function selectFields(data: unknown, select?: string[]): unknown {
  if (!select?.length || !data || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map((item) => selectFields(item, select));
  const result: Record<string, unknown> = {};
  for (const key of select) {
    if (key in (data as Record<string, unknown>)) {
      result[key] = (data as Record<string, unknown>)[key];
    }
  }
  return result;
}

function errorResponse(message: string, status: number, error?: unknown) {
  const body: Record<string, unknown> = { error: message };
  if (isDev && error instanceof Error && error.stack) {
    body.stack = error.stack;
  }
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function parseBody(request: Request): Promise<any> {
  const contentType = request.headers.get("content-type") ?? "";

  // FormData
  if (
    contentType.includes("multipart/form-data") ||
    contentType.includes("application/x-www-form-urlencoded")
  ) {
    try {
      const formData = await request.formData();
      const obj: Record<string, unknown> = {};
      for (const [key, value] of formData.entries()) {
        if (obj[key] !== undefined) {
          // Multiple values → array
          const existing = Array.isArray(obj[key]) ? (obj[key] as unknown[]) : [obj[key]];
          existing.push(value);
          obj[key] = existing;
        } else {
          obj[key] = value;
        }
      }
      return obj;
    } catch {
      return {};
    }
  }

  // URL-encoded search params (for GET fallback)
  if (request.method === "GET") {
    const url = new URL(request.url);
    const propsParam = url.searchParams.get("props");
    if (propsParam) {
      try {
        return JSON.parse(decodeURIComponent(propsParam));
      } catch {
        return {};
      }
    }
    return {};
  }

  // JSON (default for POST)
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function findHandler(
  key: string,
): { handler: InvokeLoader | InvokeAction; type: "loader" | "action" } | null {
  // 1. Check additive registry first (from registerInvokeHandlers / setupApps)
  const registered = handlerRegistry.get(key);
  if (registered) return { handler: registered, type: "action" };

  // 2. Fall back to legacy getter-based registries
  const loaders = getRegisteredLoaders();
  if (loaders[key]) return { handler: loaders[key], type: "loader" };

  const actions = getRegisteredActions();
  if (actions[key]) return { handler: actions[key], type: "action" };

  return null;
}

export async function handleInvoke(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathParts = url.pathname.split("/deco/invoke/");
  const invokeKey = pathParts[1] || "";
  const select = url.searchParams.get("select")?.split(",").filter(Boolean);

  const body = await parseBody(request);

  // Single invoke by key
  if (invokeKey) {
    const found = findHandler(invokeKey);
    if (!found) {
      return errorResponse(`Unknown handler: ${invokeKey}`, 404);
    }

    try {
      const result = await found.handler(body, request);
      // Response passthrough: if the handler returns a Response object,
      // forward it as-is (preserving headers like Set-Cookie).
      if (result instanceof Response) {
        return result;
      }
      const filtered = selectFields(result, select);
      const response = new Response(JSON.stringify(filtered), { status: 200, headers: JSON_HEADERS });

      // Copy any headers that handlers wrote to RequestContext.responseHeaders
      // (e.g., Set-Cookie from proxySetCookie). This mirrors deco-cx/deco's
      // ctx.response.headers → HTTP Response forwarding.
      const ctx = RequestContext.current;
      if (ctx) {
        for (const [key, value] of ctx.responseHeaders.entries()) {
          response.headers.append(key, value);
        }
      }

      return response;
    } catch (error) {
      return errorResponse((error as Error).message, 500, error);
    }
  }

  // Batch invoke
  if (request.method === "POST" && body && typeof body === "object" && !Array.isArray(body)) {
    const results: Record<string, unknown> = {};

    const entries = Object.entries(body as Record<string, unknown>);
    await Promise.all(
      entries.map(async ([key, payload]) => {
        const resolveType = (payload as any)?.__resolveType || key;
        const found = findHandler(resolveType);

        if (found) {
          try {
            let result = await found.handler(payload, request);
            // If a loader returns a Response, extract its JSON body for batching.
            // Set-Cookie headers from batch items are not forwarded individually
            // (use single invoke for auth loaders that need cookie passthrough).
            if (result instanceof Response) {
              try { result = await result.json(); } catch { result = null; }
            }
            results[key] = selectFields(result, select);
          } catch (error) {
            results[key] = { error: (error as Error).message };
          }
        } else {
          results[key] = { error: `Unknown handler: ${resolveType}` };
        }
      }),
    );

    return new Response(JSON.stringify(results), { status: 200, headers: JSON_HEADERS });
  }

  return errorResponse("No invoke key specified", 400);
}
