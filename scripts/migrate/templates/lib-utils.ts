import type { MigrationContext } from "../types.ts";

/**
 * Generates src/lib/ utility wrappers that provide signature-compatible
 * stubs for VTEX utilities. The old stack (deco-cx/apps) exports functions
 * with different signatures than @decocms/apps-start, and some types
 * (VTEXCommerceStable, LabelledFuzzy) don't exist at all. These wrappers
 * bridge the gap so custom loaders continue to compile and run.
 */
export function generateLibUtils(_ctx: MigrationContext): Record<string, string> {
  return {
    "src/lib/vtex-transform.ts": LIB_VTEX_TRANSFORM,
    "src/lib/vtex-intelligent-search.ts": LIB_VTEX_INTELLIGENT_SEARCH,
    "src/lib/vtex-segment.ts": LIB_VTEX_SEGMENT,
    "src/lib/http-utils.ts": LIB_HTTP_UTILS,
    "src/lib/vtex-client.ts": LIB_VTEX_CLIENT,
    "src/lib/fetch-utils.ts": LIB_FETCH_UTILS,
    "src/lib/vtex-fetch.ts": LIB_VTEX_FETCH,
    "src/lib/vtex-id.ts": LIB_VTEX_ID,
    "src/lib/graphql-utils.ts": LIB_GRAPHQL_UTILS,
    "src/lib/filter-navigate.ts": LIB_FILTER_NAVIGATE,
  };
}

const LIB_VTEX_TRANSFORM = `import type { Product } from "@decocms/apps/commerce/types";

export function toProduct(vtexProduct: any): Product {
  return vtexProduct as Product;
}
`;

const LIB_VTEX_INTELLIGENT_SEARCH = `export function getISCookiesFromBag(_req?: any): Record<string, string> {
  return {};
}

export function isFilterParam(key: string): boolean {
  return key.startsWith("filter.");
}

export function toPath(facets: { key: string; value: string }[]): string {
  return facets.map((f) => \`\${f.key}/\${f.value}\`).join("/");
}

export function withDefaultFacets(
  facets: { key: string; value: string }[],
  defaults?: any,
): { key: string; value: string }[] {
  if (Array.isArray(defaults)) {
    return [...defaults, ...facets];
  }
  return [...facets];
}

export function withDefaultParams(
  params: any,
  defaults?: Record<string, string>,
): any {
  if (params instanceof URLSearchParams) {
    if (defaults) {
      for (const [key, value] of Object.entries(defaults)) {
        if (!params.has(key)) {
          params.set(key, value);
        }
      }
    }
    return params;
  }
  return { ...params, ...defaults };
}
`;

const LIB_VTEX_SEGMENT = `export function getSegmentFromBag(_req?: any): Record<string, unknown> | null {
  return null;
}

export function withSegmentCookie(..._args: any[]): any {
  for (const arg of _args) {
    if (arg instanceof Headers) {
      return arg;
    }
  }
  return new Headers();
}
`;

const LIB_HTTP_UTILS = `/**
 * Drop-in replacement for the typed HTTP client from deco-cx/apps.
 * Supports both simple \`.get(path)\` / \`.post(path, body)\` calls AND
 * the indexed pattern \`client["GET /api/path"]({params}, {init})\`
 * used by legacy loaders.
 */
export function createHttpClient<_T = any>(options: {
  base: string;
  headers?: Record<string, string> | Headers;
  fetcher?: typeof fetch;
}) {
  const base = options.base.replace(/\\/$/, "");
  const defaultHeaders: Record<string, string> =
    options.headers instanceof Headers
      ? Object.fromEntries(options.headers.entries())
      : (options.headers || {});

  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop) {
      if (prop === "get") {
        return async <R = any>(path: string, init?: RequestInit): Promise<R> => {
          const res = await fetch(\`\${base}\${path}\`, {
            ...init,
            headers: { ...defaultHeaders, ...(init?.headers as Record<string, string>) },
          });
          return res.json();
        };
      }
      if (prop === "post") {
        return async <R = any>(path: string, body: unknown, init?: RequestInit): Promise<R> => {
          const res = await fetch(\`\${base}\${path}\`, {
            method: "POST",
            ...init,
            headers: {
              "Content-Type": "application/json",
              ...defaultHeaders,
              ...(init?.headers as Record<string, string>),
            },
            body: JSON.stringify(body),
          });
          return res.json();
        };
      }
      if (typeof prop === "string" && /^(GET|POST|PUT|PATCH|DELETE)\\s+/.test(prop)) {
        const spaceIdx = prop.indexOf(" ");
        const method = prop.slice(0, spaceIdx);
        let apiPath = prop.slice(spaceIdx + 1);

        return async (params: Record<string, any> = {}, init?: RequestInit) => {
          const cleanParams = { ...params };

          const starMatch = apiPath.match(/\\*(\\w+)/);
          if (starMatch) {
            const paramName = starMatch[1];
            if (cleanParams[paramName] != null) {
              apiPath = apiPath.replace(\`*\${paramName}\`, String(cleanParams[paramName]));
              delete cleanParams[paramName];
            } else {
              apiPath = apiPath.replace(/\\/\\*\\w+/, "");
            }
          }

          let url = \`\${base}\${apiPath}\`;

          if (method === "GET") {
            const sp = new URLSearchParams();
            for (const [k, v] of Object.entries(cleanParams)) {
              if (v !== undefined && v !== null) sp.set(k, String(v));
            }
            const qs = sp.toString();
            if (qs) url += (url.includes("?") ? "&" : "?") + qs;
          }

          const fetchInit: RequestInit = {
            method,
            ...init,
            headers: {
              ...defaultHeaders,
              ...(init?.headers instanceof Headers
                ? Object.fromEntries(init.headers.entries())
                : (init?.headers as Record<string, string>)),
            },
            ...(method !== "GET" && Object.keys(cleanParams).length > 0
              ? { body: JSON.stringify(cleanParams) }
              : {}),
          };

          const res = await fetch(url, fetchInit);
          return { json: () => res.json(), ok: res.ok, status: res.status, headers: res.headers };
        };
      }
      return undefined;
    },
  };

  return new Proxy({} as Record<string, unknown>, handler) as any;
}
`;

const LIB_VTEX_CLIENT = `export interface VTEXCommerceStable {
  account: string;
  environment?: string;
}
`;

const LIB_FETCH_UTILS = `export const STALE = {
  "Cache-Control": "public, max-age=120, stale-while-revalidate=600",
};
`;

const LIB_VTEX_FETCH = `export async function fetchSafe(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (!response.ok) {
    console.error(\`VTEX fetch failed: \${response.status} \${response.statusText}\`);
  }
  return response;
}
`;

const LIB_VTEX_ID = `export function parseCookie(cookieStr?: string | null): Record<string, string> {
  if (!cookieStr) return {};
  return Object.fromEntries(
    cookieStr.split(";").map((c) => {
      const [key, ...rest] = c.trim().split("=");
      return [key, rest.join("=")];
    }),
  );
}
`;

const LIB_GRAPHQL_UTILS = `export function createGraphqlClient(options: {
  endpoint: string;
  headers?: Record<string, string>;
}) {
  return {
    async query<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
      const res = await fetch(options.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
        body: JSON.stringify({ query, variables }),
      });
      const json = await res.json();
      return json.data;
    },
  };
}
`;

const LIB_FILTER_NAVIGATE = `/**
 * Converts a VTEX filter URL string (e.g. "?filter.brand=x&filter.price=10:50")
 * into a clean search string without internal params like \`payload\`.
 * Returns "" or "?filter.brand=x&..." ready to append to pathname.
 */
export function toFilterSearchString(filterUrl: string): string {
  const str = filterUrl.startsWith("?") ? filterUrl.slice(1) : filterUrl;
  if (!str) return "";

  const params = new URLSearchParams(str);
  params.delete("payload");

  const clean = params.toString();
  return clean ? \`?\${clean}\` : "";
}
`;
