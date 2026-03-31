import type { MigrationContext } from "../types.ts";

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function generateServerEntry(
  ctx: MigrationContext,
): Record<string, string> {
  return {
    "src/server.ts": generateServer(),
    "src/worker-entry.ts": generateWorkerEntry(ctx),
    "src/router.tsx": generateRouter(),
    "src/runtime.ts": generateRuntime(),
    "src/context.ts": generateContext(ctx),
  };
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
  const isCommerce = ctx.platform !== "custom";
  const proxyImport = isCommerce
    ? `\n// Uncomment to enable checkout/API proxy for ${ctx.platform}:
// import { shouldProxyTo${ctx.platform === "vtex" ? "Vtex" : capitalize(ctx.platform)}, proxyTo${ctx.platform === "vtex" ? "Vtex" : capitalize(ctx.platform)} } from "@decocms/apps/${ctx.platform}/utils/proxy";\n`
    : "";

  const proxyOption = isCommerce
    ? `
  // Uncomment to enable checkout/API proxy for ${ctx.platform}:
  // proxyHandler: (request, url) => {
  //   if (shouldProxyTo${ctx.platform === "vtex" ? "Vtex" : capitalize(ctx.platform)}(url.pathname)) {
  //     return proxyTo${ctx.platform === "vtex" ? "Vtex" : capitalize(ctx.platform)}(request);
  //   }
  //   return null;
  // },`
    : "";

  const segmentOption = ctx.platform === "vtex"
    ? `
  // Uncomment for per-sales-channel/region cache segmentation:
  // buildSegment: (request) => {
  //   const ua = request.headers.get("user-agent") ?? "";
  //   return {
  //     device: /mobile|android|iphone/i.test(ua) ? "mobile" : "desktop",
  //     // loggedIn: true bypasses cache automatically
  //   };
  // },`
    : "";

  return `/**
 * Cloudflare Worker entry point.
 *
 * Wraps TanStack Start with admin protocol handlers and edge caching.
 * For commerce sites, uncomment proxyHandler and buildSegment options.
 */
import "./setup";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
import {
  handleMeta,
  handleDecofileRead,
  handleDecofileReload,
  handleRender,
  corsHeaders,
} from "@decocms/start/admin";
${proxyImport}
const serverEntry = createServerEntry({ fetch: handler.fetch });

export default createDecoWorkerEntry(serverEntry, {
  admin: {
    handleMeta,
    handleDecofileRead,
    handleDecofileReload,
    handleRender,
    corsHeaders,
  },${proxyOption}${segmentOption}
});
`;
}

function generateRouter(): string {
  return `import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import type { SearchSerializer, SearchParser } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import "./setup";

const parseSearch: SearchParser = (searchStr) => {
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

const stringifySearch: SearchSerializer = (search) => {
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
  return str ? \`?\${str}\` : "";
};

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    parseSearch,
    stringifySearch,
  });
  return router;
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
 * Runtime invoke proxy — turns nested property access into typed RPC calls.
 *
 *   invoke.vtex.loaders.productList(props)
 *   → POST /deco/invoke/vtex/loaders/productList
 */
import { createAppInvoke } from "@decocms/start/sdk/invoke";

export const invoke = createAppInvoke();
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
