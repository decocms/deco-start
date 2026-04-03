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
  const isVtex = ctx.platform === "vtex";

  if (isVtex) {
    return generateVtexWorkerEntry(ctx);
  }

  const isCommerce = ctx.platform !== "custom";
  const platformLabel = isCommerce ? ctx.platform : null;

  return `/**
 * Cloudflare Worker entry point.
 *
 * Wraps TanStack Start with admin protocol handlers and edge caching.
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
${isCommerce ? `
// TODO: Uncomment and wire proxy for ${platformLabel}
// import { shouldProxyTo${capitalize(platformLabel!)}, proxyTo${capitalize(platformLabel!)} } from "@decocms/apps/${platformLabel}/utils/proxy";
` : ""}
const serverEntry = createServerEntry({ fetch: handler.fetch });

export default createDecoWorkerEntry(serverEntry, {
  admin: {
    handleMeta,
    handleDecofileRead,
    handleDecofileReload,
    handleRender,
    corsHeaders,
  },
});
`;
}

function generateVtexWorkerEntry(ctx: MigrationContext): string {
  return `/**
 * Cloudflare Worker entry point — VTEX storefront.
 *
 * Handles admin protocol, VTEX checkout proxy, CSP,
 * segment building, and edge caching.
 *
 * MANUAL REVIEW: Add site-specific CSP domains (analytics, CDN, tag managers).
 */
import "./setup";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
import { detectDevice } from "@decocms/start/sdk/useDevice";
import {
  handleMeta,
  handleDecofileRead,
  handleDecofileReload,
  handleRender,
  corsHeaders,
} from "@decocms/start/admin";
import { extractVtexContext } from "@decocms/apps/vtex/middleware";
import {
  shouldProxyToVtex,
  createVtexCheckoutProxy,
} from "@decocms/apps/vtex/utils/proxy";
import { getVtexConfig } from "@decocms/apps/vtex";

const serverEntry = createServerEntry({ fetch: handler.fetch });

const CSP_DIRECTIVES = [
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' *.vtex.com.br *.vteximg.com.br *.vtexassets.com",
  "img-src 'self' data: blob: *.vteximg.com.br *.vtexassets.com *.vtexcommercestable.com.br",
  "connect-src 'self' *.vtex.com.br *.vtexcommercestable.com.br *.vtexassets.com",
  "frame-src 'self' *.vtex.com.br",
  "style-src 'self' 'unsafe-inline' fonts.googleapis.com",
  "font-src 'self' fonts.gstatic.com data:",
  // TODO: Add site-specific domains (analytics, CDN, tag managers)
];

const { account } = getVtexConfig();

const vtexProxy = createVtexCheckoutProxy({
  account,
  checkoutOrigin: \`\${account}.vtexcommercestable.com.br\`,
  // TODO: Set your secure checkout origin if different from default
  // checkoutOrigin: "secure.yourdomain.com.br",
});

const decoWorker = createDecoWorkerEntry(serverEntry, {
  admin: {
    handleMeta,
    handleDecofileRead,
    handleDecofileReload,
    handleRender,
    corsHeaders,
  },

  csp: CSP_DIRECTIVES,

  buildSegment: (request) => {
    const vtx = extractVtexContext(request);
    const device = detectDevice(request.headers.get("user-agent") ?? "");

    return {
      device,
      ...(vtx.isLoggedIn ? { loggedIn: true } : {}),
      ...(vtx.salesChannel !== "1" ? { salesChannel: vtx.salesChannel } : {}),
      ...(vtx.regionId ? { regionId: vtx.regionId } : {}),
    };
  },

  proxyHandler: async (request, url) => {
    const { pathname } = url;

    // CMS-managed routes — don't proxy
    if (pathname === "/login" || pathname === "/logout") return null;

    // VTEX checkout and API proxy
    if (shouldProxyToVtex(pathname)) {
      return vtexProxy(request, url);
    }

    return null;
  },
});

export default decoWorker;

// ─── A/B Testing + Redirects (uncomment when ready) ─────────────────
// import { withABTesting } from "@decocms/start/sdk/abTesting";
// import { loadBlocks } from "@decocms/start/cms";
// import { loadRedirects, matchRedirect } from "@decocms/start/sdk/redirects";
//
// const cmsRedirects = loadRedirects(loadBlocks());
//
// export default withABTesting(decoWorker, {
//   kvBinding: "AB_TESTING",
//   preHandler: (request) => {
//     const url = new URL(request.url);
//     const redirect = matchRedirect(url.pathname, cmsRedirects);
//     if (redirect) {
//       return new Response(null, {
//         status: redirect.type === "temporary" ? 307 : 301,
//         headers: { Location: redirect.to },
//       });
//     }
//     return null;
//   },
//   shouldBypassAB: (_request, url) => shouldProxyToVtex(url.pathname),
// });
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
 * Runtime invoke proxy.
 *
 * Turns nested property access into a typed RPC call to /deco/invoke.
 * Converts dot-notation paths to slash-separated keys:
 *   invoke.vtex.loaders.productList(props)
 *   → POST /deco/invoke/vtex/loaders/productList
 *
 * The .ts suffix variant is also tried if the primary key isn't found
 * (registered loaders may have ".ts" extensions in their keys).
 */
function createNestedInvokeProxy(path: string[] = []): any {
  return new Proxy(
    Object.assign(async (props: any) => {
      const key = path.join("/");
      for (const k of [key, \`\${key}.ts\`]) {
        const response = await fetch(\`/deco/invoke/\${k}\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(props ?? {}),
        });
        if (response.status === 404) continue;
        if (!response.ok) {
          throw new Error(\`invoke(\${k}) failed: \${response.status}\`);
        }
        return response.json();
      }
      throw new Error(\`invoke(\${key}) failed: handler not found\`);
    }, {}),
    {
      get(_target: any, prop: string) {
        if (prop === "then" || prop === "catch" || prop === "finally") {
          return undefined;
        }
        return createNestedInvokeProxy([...path, prop]);
      },
    },
  );
}

export const invoke = createNestedInvokeProxy() as any;

export const Runtime = {
  invoke,
};
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
