/**
 * Admin Route Helpers
 *
 * Pre-built server handler configs for the Deco admin protocol routes.
 * Sites spread these into their `createFileRoute` definitions to avoid
 * repeating the same CORS + handler boilerplate.
 *
 * @example Site's `src/routes/deco/meta.ts`:
 * ```ts
 * import { createFileRoute } from "@tanstack/react-router";
 * import { decoMetaRoute } from "@decocms/start/routes";
 *
 * export const Route = createFileRoute("/deco/meta")(decoMetaRoute);
 * ```
 */
import { corsHeaders } from "../admin/cors";
import { handleInvoke } from "../admin/invoke";
import { handleMeta } from "../admin/meta";
import { handleRender } from "../admin/render";

type HandlerFn = (ctx: { request: Request }) => Promise<Response> | Response;

function withCors(handler: HandlerFn): HandlerFn {
  return async (ctx) => {
    const response = await handler(ctx);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders(ctx.request))) {
      headers.set(k, v);
    }
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  };
}

function optionsHandler(ctx: { request: Request }): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(ctx.request),
  });
}

/**
 * Route config for `/deco/meta` — serves JSON Schema + manifest.
 * Spread into `createFileRoute("/deco/meta")({...})`.
 */
export const decoMetaRoute = {
  server: {
    handlers: {
      GET: withCors(({ request }) => handleMeta(request)),
      OPTIONS: optionsHandler,
    },
  },
};

/**
 * Route config for `/deco/render` — section/page preview in iframe.
 * Spread into `createFileRoute("/deco/render")({...})`.
 */
export const decoRenderRoute = {
  server: {
    handlers: {
      GET: withCors(async ({ request }) => handleRender(request)),
      POST: withCors(async ({ request }) => handleRender(request)),
      OPTIONS: optionsHandler,
    },
  },
};

/**
 * Route config for `/deco/invoke/$` — loader/action execution.
 * Spread into `createFileRoute("/deco/invoke/$")({...})`.
 */
export const decoInvokeRoute = {
  server: {
    handlers: {
      GET: withCors(async ({ request }) => handleInvoke(request)),
      POST: withCors(async ({ request }) => handleInvoke(request)),
      OPTIONS: optionsHandler,
    },
  },
};
