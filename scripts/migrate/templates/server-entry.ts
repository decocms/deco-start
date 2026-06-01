import type { MigrationContext } from "../types";

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function generateServerEntry(
  ctx: MigrationContext,
): Record<string, string> {
  const files: Record<string, string> = {
    "src/server.ts": generateServer(),
    "src/worker-entry.ts": generateWorkerEntry(ctx),
    "src/router.tsx": generateRouter(),
    "src/runtime.ts": generateRuntime(),
    "src/context.ts": generateContext(ctx),
    "src/server/invoke.ts": generateInvoke(ctx),
    "src/server/invoke.gen.ts": generateInvokeGen(ctx),
  };
  return files;
}

function generateServer(): string {
  return `import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";

export default createStartHandler(defaultStreamHandler);
`;
}

function generateWorkerEntry(ctx: MigrationContext): string {
  const isVtex = ctx.platform === "vtex";

  if (isVtex) {
    return generateVtexWorkerEntry(ctx);
  }

  const isCommerce = ctx.platform !== "custom";
  const platformLabel = isCommerce ? ctx.platform : null;

  return `/**
 * Cloudflare Worker entry point.
 *
 * Wraps TanStack Start with admin protocol handlers, edge caching, and
 * the @decocms/start observability stack (5.0+, Cloudflare-native):
 *   - logs:    console.* -> CF Workers Logs (captured by the platform
 *              when wrangler.jsonc has \`observability.enabled: true\`).
 *              View in the CF dashboard -> Workers & Pages -> <site> ->
 *              Observability -> Logs.
 *   - traces:  @opentelemetry/api global tracer bridge (so
 *              withTracing() spans are picked up by Cloudflare's
 *              auto-instrumentation) -> CF Workers Tracing. View in the
 *              same dashboard, Traces tab.
 *   - metrics: AE (DECO_METRICS binding). Query via the AE SQL API or
 *              Grafana ClickHouse datasource pointed at AE.
 *
 * No in-Worker OTLP exporter ships with 5.x — the CF dashboard is the
 * destination. A ClickHouse-collector adapter is scaffolded at
 * @decocms/start/sdk/otelAdapters/clickhouseCollector but throws if
 * called; it'll get a real implementation once the OTel collector
 * gateway lands.
 *
 * To wire wrangler.jsonc with the canonical observability block, run:
 *   npx -p @decocms/start deco-cf-observability --write
 */
import "./setup";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
import { instrumentWorker } from "@decocms/start/sdk/observability";
import {
  handleMeta,
  handleDecofileRead,
  handleDecofileReload,
  handleRender,
  corsHeaders,
} from "@decocms/start/admin";
${isCommerce ? `
// TODO: Uncomment and wire proxy for ${platformLabel}
// import { shouldProxyTo${capitalize(platformLabel!)}, proxyTo${capitalize(platformLabel!)} } from "@decocms/apps/${platformLabel}/utils/proxy";
` : ""}
const serverEntry = createServerEntry({ fetch: handler.fetch });

const decoWorker = createDecoWorkerEntry(serverEntry, {
  admin: {
    handleMeta,
    handleDecofileRead,
    handleDecofileReload,
    handleRender,
    corsHeaders,
  },
  // Region splits the cache so a RJ-cached response isn't served to SP visitors
  // when pages use the website/matchers/location.ts matcher. Without this, the
  // first geo-resolved response leaks across regions.
  buildSegment: (request) => {
    const cf = (request as unknown as { cf?: { regionCode?: string } }).cf;
    const regionCode = request.headers.get("cf-region-code") ?? cf?.regionCode ?? "";
    return regionCode ? { regionId: regionCode } : {};
  },
});

export default instrumentWorker(decoWorker, {
  serviceName: "${ctx.siteName}",
});
`;
}

function generateVtexWorkerEntry(ctx: MigrationContext): string {
  const vtexAccount = ctx.vtexAccount || ctx.siteName;

  return `import "./setup";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
import { instrumentWorker } from "@decocms/start/sdk/observability";
import {
  handleMeta,
  handleDecofileRead,
  handleDecofileReload,
  handleRender,
  corsHeaders,
} from "@decocms/start/admin";
import { shouldProxyToVtex, createVtexCheckoutProxy } from "@decocms/apps/vtex/utils/proxy";
import { extractVtexContext } from "@decocms/apps/vtex/middleware";
import { loadRedirects, matchRedirect } from "@decocms/start/sdk/redirects";
import { withABTesting } from "@decocms/start/sdk/abTesting";
import { loadBlocks } from "@decocms/start/cms";

// ---------------------------------------------------------------------------
// VTEX checkout proxy — configured via @decocms/apps factory
// ---------------------------------------------------------------------------

const proxyCheckout = createVtexCheckoutProxy({
  account: "${vtexAccount}",
  checkoutOrigin: "${vtexAccount}.vtexcommercestable.com.br",
  // TODO: Set secure checkout origin if different (e.g. "secure.yourdomain.com.br")
});

// Site-specific CSP directives — third-party script domains vary per site.
// MANUAL REVIEW: Add analytics, CDN, and tag manager domains.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com https://connect.facebook.net https://analytics.tiktok.com https://script.hotjar.com https://static.hotjar.com https://scripts.clarity.ms https://www.clarity.ms https://sp.vtex.com https://bat.bing.com https://s.lilstts.com https://storage.googleapis.com",
  "img-src 'self' data: https: blob:",
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' data: https:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https://www.googletagmanager.com https://*.firebaseapp.com",
  "media-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
];

const serverEntry = createServerEntry({ fetch: handler.fetch });

// ---------------------------------------------------------------------------
// CMS Redirects — loaded once at module level from .deco/blocks/
// ---------------------------------------------------------------------------
const cmsRedirects = loadRedirects(loadBlocks());

const MOBILE_RE = /mobile|android|iphone/i;

const decoWorker = createDecoWorkerEntry(serverEntry, {
  csp: CSP_DIRECTIVES,
  buildSegment: (request) => {
    const vtx = extractVtexContext(request);
    const cf = (request as unknown as { cf?: { regionCode?: string } }).cf;
    const geoRegion = request.headers.get("cf-region-code") ?? cf?.regionCode ?? "";
    return {
      device: MOBILE_RE.test(request.headers.get("user-agent") ?? "") ? "mobile" : "desktop",
      loggedIn: vtx.isLoggedIn,
      salesChannel: vtx.salesChannel,
      // Prefer VTEX regionalization regionId when present; otherwise fall back
      // to Cloudflare geo so the website/matchers/location.ts matcher gets a
      // properly segmented cache.
      regionId: (vtx as any).regionId ?? geoRegion ?? undefined,
    };
  },
  admin: {
    handleMeta,
    handleDecofileRead,
    handleDecofileReload,
    handleRender,
    corsHeaders,
  },
  proxyHandler: async (request, url) => {
    if (url.pathname === "/login" || url.pathname === "/login/" ||
        url.pathname === "/logout" || url.pathname === "/logout/") return null;
    if (!shouldProxyToVtex(url.pathname)) return null;

    try {
      return await proxyCheckout(request, url);
    } catch (err) {
      console.error("[PROXY] Failed to proxy", url.pathname, err);
      return new Response(\`Proxy error for \${url.pathname}: \${err}\`, {
        status: 502,
        headers: { "content-type": "text/plain" },
      });
    }
  },
});

// ---------------------------------------------------------------------------
// A/B wrapper — KV-driven traffic split between TanStack and legacy origin
// ---------------------------------------------------------------------------

const abTestedWorker = withABTesting(decoWorker, {
  kvBinding: "SITES_KV",
  preHandler: (request, url) => {
    const redirect = matchRedirect(url.pathname, cmsRedirects);
    if (redirect) {
      const target = url.search ? \`\${redirect.to}\${url.search}\` : redirect.to;
      return new Response(null, {
        status: redirect.status,
        headers: { Location: target },
      });
    }
    return null;
  },
  shouldBypassAB: (_request, url) => {
    if (url.pathname === "/login" || url.pathname === "/login/" ||
        url.pathname === "/logout" || url.pathname === "/logout/") return false;
    return shouldProxyToVtex(url.pathname);
  },
});

// ---------------------------------------------------------------------------
// Observability wrap (outermost layer)
//
// @decocms/start 5.0+ converged on Cloudflare-native observability:
//   - logs:    console.* -> CF Workers Logs (dashboard captures, no
//              app-side OTLP exporter)
//   - traces:  @opentelemetry/api global tracer (bridged from
//              withTracing) -> CF Workers Tracing (auto-instrumented)
//   - metrics: AE (DECO_METRICS binding only; OTLP metrics path
//              removed in 5.0 — track ClickHouse roadmap at
//              src/sdk/otelAdapters/clickhouseCollector.ts)
//
// Wire wrangler.jsonc with the canonical observability block via:
//   npx -p @decocms/start deco-cf-observability --write
// ---------------------------------------------------------------------------
export default instrumentWorker(abTestedWorker, {
  serviceName: "${ctx.siteName}",
});
`;
}

function generateRouter(): string {
  return `import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createDecoRouter } from "@decocms/start/sdk/router";
import { routeTree } from "./routeTree.gen";
import "./setup";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000 } },
});

export function getRouter() {
  return createDecoRouter({
    routeTree,
    context: { queryClient },
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
`;
}

function generateRuntime(): string {
  return `/**
 * Runtime invoke proxy — re-exports the framework canonical from @decocms/start/sdk.
 *
 * The implementation (typed RPC over /deco/invoke, dotted-path proxy, .ts
 * suffix fallback) lives in @decocms/start/sdk/invoke. This file exists so
 * existing site code can keep \`import { invoke } from "~/runtime"\` and
 * \`Runtime.invoke\` shapes without churn.
 *
 * Don't reimplement here — extend @decocms/start/sdk/invoke instead.
 */
import { invoke } from "@decocms/start/sdk";

export { invoke };

export const Runtime = { invoke };
`;
}

function generateContext(ctx: MigrationContext): string {
  return `import { createContext } from "react";

export interface AccountContextValue {
  name: string;
}

const Account = createContext<AccountContextValue>({
  name: "${ctx.siteName}",
});

export default Account;
`;
}

function generateInvoke(ctx: MigrationContext): string {
  if (ctx.platform !== "vtex") {
    return `/**
 * Site invoke — server functions placeholder.
 * TODO: Add platform-specific invoke actions here.
 */
export const invoke = {} as const;
`;
  }

  const hasVtexAuthLoader = ctx.loaderInventory.some((l) =>
    l.path.includes("vtex-auth-loader")
  );

  return `/**
 * Site invoke — extends generated VTEX actions with site-specific server functions.
 *
 * Standard VTEX actions (cart, session, masterdata, newsletter, misc) are
 * auto-generated in invoke.gen.ts. Run \`npm run generate:invoke\` to update.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { forwardResponseCookies } from "@decocms/start/sdk/cookiePassthrough";
import { vtexActions } from "./invoke.gen";
${hasVtexAuthLoader ? `import vtexAuthLoader from "../loaders/vtex-auth-loader";\n` : ""}import {
  extractVtexCookiesFromHeader,
  stripCookieDomain,
  performVtexLogout,
  parseVtexAuthJwt,
} from "@decocms/apps/vtex/utils/authHelpers";

export type { OrderForm } from "./invoke.gen";

function getVtexCookies(): string {
  return extractVtexCookiesFromHeader(getRequestHeader("cookie") ?? "");
}

${hasVtexAuthLoader ? `const _vtexAuth = createServerFn({ method: "POST" })
  .inputValidator((data: { action: string; params: Record<string, any> }) => data)
  .handler(async ({ data }): Promise<any> => {
    const result = await vtexAuthLoader({
      ...data,
      _cookies: getVtexCookies(),
    } as any);
    if (result instanceof Response) {
      const setCookies = result.headers.getSetCookie?.() ?? [];
      forwardResponseCookies(stripCookieDomain(setCookies));
      return result.json();
    }
    return result;
  });
` : ""}const _logout = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ success: boolean }> => {
    const { setCookies } = await performVtexLogout(getVtexCookies());
    forwardResponseCookies(setCookies);
    return { success: true };
  },
);

const _getUserFromJwt = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ email: string; userId: string } | null> => {
    return parseVtexAuthJwt(getRequestHeader("cookie") ?? "");
  },
);

export const invoke = {
  vtex: {
    actions: vtexActions,
  },
  site: {
    loaders: {
${hasVtexAuthLoader ? "      vtexAuth: _vtexAuth,\n" : ""}      getUserFromJwt: _getUserFromJwt,
    },
    actions: {
      logout: _logout,
    },
  },
} as const;
`;
}

function generateInvokeGen(ctx: MigrationContext): string {
  if (ctx.platform !== "vtex") {
    return `// invoke.gen.ts — no platform-specific actions to generate
export const vtexActions = {} as const;
`;
  }

  return `// Auto-generated VTEX invoke actions
// Each server function is a top-level const so TanStack Start's compiler
// can transform createServerFn().handler() into RPC stubs on the client.
import { createServerFn } from "@tanstack/react-start";
import { getOrCreateCart, addItemsToCart, updateCartItems, addCouponToCart, simulateCart, getSellersByRegion, setShippingPostalCode, updateOrderFormAttachment } from "@decocms/apps/vtex/actions/checkout";
import { createSession, editSession } from "@decocms/apps/vtex/actions/session";
import { createDocument, getDocument, patchDocument, searchDocuments, uploadAttachment } from "@decocms/apps/vtex/actions/masterData";
import { subscribe } from "@decocms/apps/vtex/actions/newsletter";
import { notifyMe } from "@decocms/apps/vtex/actions/misc";
import type { OrderForm } from "@decocms/apps/vtex/types";
import type { SimulationItem, RegionResult } from "@decocms/apps/vtex/actions/checkout";
import type { SessionData } from "@decocms/apps/vtex/actions/session";
import type { CreateDocumentResult, UploadAttachmentOpts } from "@decocms/apps/vtex/actions/masterData";
import type { SubscribeProps } from "@decocms/apps/vtex/actions/newsletter";
import type { NotifyMeProps } from "@decocms/apps/vtex/actions/misc";

function unwrapResult<T>(result: unknown): T {
  if (result && typeof result === "object" && "data" in result) {
    return (result as { data: T }).data;
  }
  return result as T;
}

const $getOrCreateCart = createServerFn({ method: "POST" })
  .inputValidator((data: { orderFormId?: string }) => data)
  .handler(async ({ data }): Promise<any> => {
    const result = await getOrCreateCart(data);
    return unwrapResult(result);
  });

const $addItemsToCart = createServerFn({ method: "POST" })
  .inputValidator((data: {
    orderFormId: string;
    orderItems: Array<{ id: string; seller: string; quantity: number }>;
  }) => data)
  .handler(async ({ data }): Promise<any> => {
    const result = await addItemsToCart(data);
    return unwrapResult(result);
  });

const $updateCartItems = createServerFn({ method: "POST" })
  .inputValidator((data: { orderFormId: string; orderItems: Array<{ index: number; quantity: number }> }) => data)
  .handler(async ({ data }): Promise<any> => {
    const result = await updateCartItems(data);
    return unwrapResult(result);
  });

const $addCouponToCart = createServerFn({ method: "POST" })
  .inputValidator((data: { orderFormId: string; text: string }) => data)
  .handler(async ({ data }): Promise<any> => {
    const result = await addCouponToCart(data);
    return unwrapResult(result);
  });

const $simulateCart = createServerFn({ method: "POST" })
  .inputValidator((data: { items: SimulationItem[]; postalCode: string; country?: string }) => data)
  .handler(async ({ data }): Promise<any> => {
    return simulateCart(data);
  });

const $getSellersByRegion = createServerFn({ method: "POST" })
  .inputValidator((data: { postalCode: string; salesChannel?: string }) => data)
  .handler(async ({ data }): Promise<any> => {
    return getSellersByRegion(data);
  });

const $setShippingPostalCode = createServerFn({ method: "POST" })
  .inputValidator((data: { orderFormId: string; postalCode: string; country?: string }) => data)
  .handler(async ({ data }): Promise<any> => {
    return setShippingPostalCode(data);
  });

const $updateOrderFormAttachment = createServerFn({ method: "POST" })
  .inputValidator((data: { orderFormId: string; attachment: string; body: Record<string, unknown> }) => data)
  .handler(async ({ data }): Promise<any> => {
    const result = await updateOrderFormAttachment(data);
    return unwrapResult(result);
  });

const $createSession = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, any>) => data)
  .handler(async ({ data }): Promise<any> => {
    const result = await createSession(data);
    return unwrapResult(result);
  });

const $editSession = createServerFn({ method: "POST" })
  .inputValidator((data: { public: Record<string, { value: string }> }) => data)
  .handler(async ({ data }): Promise<any> => {
    const result = await editSession(data);
    return unwrapResult(result);
  });

const $createDocument = createServerFn({ method: "POST" })
  .inputValidator((data: { entity: string; data: Record<string, any> }) => data)
  .handler(async ({ data }): Promise<any> => {
    return createDocument(data);
  });

const $getDocument = createServerFn({ method: "POST" })
  .inputValidator((data: { entity: string; documentId: string }) => data)
  .handler(async ({ data }): Promise<any> => {
    return getDocument(data);
  });

const $patchDocument = createServerFn({ method: "POST" })
  .inputValidator((data: { entity: string; documentId: string; data: Record<string, any> }) => data)
  .handler(async ({ data }): Promise<any> => {
    return patchDocument(data);
  });

const $searchDocuments = createServerFn({ method: "POST" })
  .inputValidator((data: { entity: string; filter: string }) => data)
  .handler(async ({ data }): Promise<any> => {
    return searchDocuments(data);
  });

const $uploadAttachment = createServerFn({ method: "POST" })
  .inputValidator((data: UploadAttachmentOpts) => data)
  .handler(async ({ data }): Promise<any> => {
    return uploadAttachment(data);
  });

const $subscribe = createServerFn({ method: "POST" })
  .inputValidator((data: SubscribeProps) => data)
  .handler(async ({ data }): Promise<any> => {
    return subscribe(data);
  });

const $notifyMe = createServerFn({ method: "POST" })
  .inputValidator((data: NotifyMeProps) => data)
  .handler(async ({ data }): Promise<any> => {
    return notifyMe(data);
  });

export const vtexActions = {
  getOrCreateCart: $getOrCreateCart as unknown as (ctx: { data: { orderFormId?: string } }) => Promise<OrderForm>,
  addItemsToCart: $addItemsToCart as unknown as (ctx: { data: { orderFormId: string; orderItems: Array<{ id: string; seller: string; quantity: number }> } }) => Promise<OrderForm>,
  updateCartItems: $updateCartItems as unknown as (ctx: { data: { orderFormId: string; orderItems: Array<{ index: number; quantity: number }> } }) => Promise<OrderForm>,
  addCouponToCart: $addCouponToCart as unknown as (ctx: { data: { orderFormId: string; text: string } }) => Promise<OrderForm>,
  simulateCart: $simulateCart,
  getSellersByRegion: $getSellersByRegion as unknown as (ctx: { data: { postalCode: string; salesChannel?: string } }) => Promise<RegionResult | null>,
  setShippingPostalCode: $setShippingPostalCode as unknown as (ctx: { data: { orderFormId: string; postalCode: string; country?: string } }) => Promise<boolean>,
  updateOrderFormAttachment: $updateOrderFormAttachment as unknown as (ctx: { data: { orderFormId: string; attachment: string; body: Record<string, unknown> } }) => Promise<OrderForm>,
  createSession: $createSession,
  editSession: $editSession as unknown as (ctx: { data: { public: Record<string, { value: string }> } }) => Promise<SessionData>,
  createDocument: $createDocument as unknown as (ctx: { data: { entity: string; data: Record<string, any> } }) => Promise<CreateDocumentResult>,
  getDocument: $getDocument,
  patchDocument: $patchDocument as unknown as (ctx: { data: { entity: string; documentId: string; data: Record<string, any> } }) => Promise<void>,
  searchDocuments: $searchDocuments,
  uploadAttachment: $uploadAttachment as unknown as (ctx: { data: UploadAttachmentOpts }) => Promise<{ ok: true }>,
  subscribe: $subscribe as unknown as (ctx: { data: SubscribeProps }) => Promise<void>,
  notifyMe: $notifyMe as unknown as (ctx: { data: NotifyMeProps }) => Promise<void>,
} as const;

export type { OrderForm } from "@decocms/apps/vtex/types";

export const invoke = {
  vtex: {
    actions: vtexActions,
  },
} as const;
`;
}

