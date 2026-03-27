import type { MigrationContext } from "../types.ts";

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
  return `/**
 * Cloudflare Worker entry point.
 *
 * For a simple site without VTEX proxy or A/B testing, this is a thin wrapper
 * around the TanStack Start handler. Add proxy logic, security headers, or
 * A/B testing as needed.
 */
import { createDecoWorkerEntry } from "@decocms/start/worker";

const handler = createDecoWorkerEntry({
  siteName: "${ctx.siteName}",
});

export default handler;
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
