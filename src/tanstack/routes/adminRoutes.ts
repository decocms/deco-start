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
import { corsHeaders } from "../../core/admin/cors";
import { handleInvoke } from "../../core/admin/invoke";
import { handleMeta } from "../../core/admin/meta";
import { handleRender } from "../../core/admin/render";
import { withTracing } from "../../core/sdk/observability";

function invokeAttrs(request: Request): Record<string, string | boolean> {
  const url = new URL(request.url);
  const invokeKey = url.pathname.split("/deco/invoke/")[1] ?? "";
  return {
    "invoke.key": invokeKey || "(batch)",
    "invoke.batch": invokeKey === "",
  };
}

function renderAttrs(request: Request): Record<string, string> {
  const url = new URL(request.url);
  const pathComponent = url.pathname.split("/deco/render/")[1] ?? "";
  return { "cms.component": pathComponent || "(page)" };
}

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
      GET: withCors(({ request }) =>
        withTracing("deco.admin.meta", async () => handleMeta(request)),
      ),
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
      GET: withCors(({ request }) =>
        withTracing(
          "deco.admin.render",
          () => Promise.resolve(handleRender(request)),
          renderAttrs(request),
        ),
      ),
      POST: withCors(({ request }) =>
        withTracing(
          "deco.admin.render",
          () => Promise.resolve(handleRender(request)),
          renderAttrs(request),
        ),
      ),
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
      GET: withCors(({ request }) =>
        withTracing("deco.admin.invoke", () => handleInvoke(request), invokeAttrs(request)),
      ),
      POST: withCors(({ request }) =>
        withTracing("deco.admin.invoke", () => handleInvoke(request), invokeAttrs(request)),
      ),
      OPTIONS: optionsHandler,
    },
  },
};
