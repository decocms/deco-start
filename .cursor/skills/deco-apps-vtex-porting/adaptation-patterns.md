# Adaptation Patterns: deco-cx/apps → apps-start

How to convert each Deno/Fresh/Deco pattern to TanStack/Node equivalents.

## 1. App Factory → configureVtex()

### Original (apps/vtex/mod.ts)
```typescript
import { createHttpClient } from "../utils/http.ts";
import { createGraphqlClient } from "../utils/graphql.ts";

export default function VTEX({ account, publicUrl, salesChannel, appKey, appToken }: Props) {
  const vcsDeprecated = createHttpClient<VTEXCommerceStable>({
    base: publicUrl,
    processHeaders: removeDirtyCookies,
    fetcher: fetchSafe,
  });
  const io = createGraphqlClient({
    endpoint: `${publicUrl}/api/io/_v/private/graphql/v1`,
  });
  const state = { account, publicUrl, salesChannel, vcsDeprecated, io, /* 5 more clients */ };
  return { state, manifest, middleware };
}
```

### Port (apps-start/vtex/client.ts)
```typescript
let vtexConfig: VtexConfig;

export function configureVtex(config: VtexConfig) {
  vtexConfig = config;
}

export function getVtexConfig(): VtexConfig {
  return vtexConfig;
}

export async function vtexFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { account, publicUrl } = getVtexConfig();
  const baseUrl = publicUrl || `https://${account}.vtexcommercestable.com.br`;
  const res = await fetch(`${baseUrl}${path}`, init);
  return res.json();
}
```

**Key difference**: No typed Proxy, no processHeaders, no fetchSafe retry. Consider adding:
- URL sanitization from `fetchVTEX.ts`
- Retry on connection closed
- removeDirtyCookies for cookie headers

## 2. Loader Signature

### Original
```typescript
// loaders/intelligentSearch/productDetailsPage.ts
import { AppContext } from "../../mod.ts";
import type { ProductDetailsPage } from "../../../commerce/types.ts";

export interface Props { slug: string; }

const loader = async (props: Props, req: Request, ctx: AppContext): Promise<ProductDetailsPage | null> => {
  const { vcsDeprecated, salesChannel } = ctx;
  const segment = getSegmentFromBag(ctx);
  // Use typed client: ctx.vcsDeprecated["GET /api/..."]({...})
};
export default loader;
```

### Port
```typescript
// inline-loaders/productDetailsPage.ts
import { vtexFetch, getVtexConfig } from "../client";
import type { ProductDetailsPage } from "../../commerce/types/commerce";

interface Props { slug?: string; }

export default async function vtexProductDetailsPage(props: Props): Promise<ProductDetailsPage | null> {
  const config = getVtexConfig();
  // Use vtexFetch: await vtexFetch<T>("/api/...");
}
```

**Key differences**:
- No `req`, no `ctx` params
- Named export function instead of anonymous `const loader = ...`
- Config from `getVtexConfig()` instead of `ctx`
- No segment from bag — must pass explicitly or read from cookies

## 3. Action Signature

### Original
```typescript
// actions/cart/addItems.ts
export interface Props {
  orderItems: Array<{ id: string; quantity: number; seller: string }>;
}
const action = async (props: Props, req: Request, ctx: AppContext): Promise<OrderForm> => {
  const { orderFormId, cookie } = parseCookie(req.headers);
  const segment = getSegmentFromBag(ctx);
  const response = await ctx.vcsDeprecated["POST /api/checkout/pub/orderForm/:orderFormId/items"](
    { orderFormId, sc: segment?.payload?.channel, allowedOutdatedData: ["paymentData"] },
    { body: { orderItems: props.orderItems }, headers: { cookie } },
  );
  proxySetCookie(response.headers, ctx.response.headers, req.url);
  return response.json();
};
export default action;
```

### Port
```typescript
// actions/checkout.ts
export async function addItems(
  orderFormId: string, cookie: string, orderItems: OrderItem[], sc?: string,
): Promise<VtexFetchResult<OrderForm>> {
  const params = new URLSearchParams();
  if (sc) params.set("sc", sc);
  params.set("allowedOutdatedData", "paymentData");
  return vtexFetchWithCookies<OrderForm>(
    `/api/checkout/pub/orderForm/${orderFormId}/items?${params}`,
    {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ orderItems, expectedOrderFormSections: DEFAULT_EXPECTED_SECTIONS }),
    },
  );
}
```

**Key differences**:
- Returns `VtexFetchResult<T>` with `{ data, setCookies }` (caller handles cookie propagation)
- No `proxySetCookie` — the storefront layer decides how to set cookies
- Parameters are explicit (no `req.headers` parsing inside — caller provides them)

## 4. Middleware (ctx.bag → Function Params)

### Original
```typescript
// middleware.ts — sets per-request state in ctx.bag
export const middleware = (_props: unknown, req: Request, ctx: AppMiddlewareContext) => {
  const cookies = getCookies(req.headers);
  setSegmentBag(cookies, req, ctx);        // ctx.bag.set(SEGMENT, wrappedSegment)
  setISCookiesBag(cookies, ctx);           // ctx.bag.set(IS_COOKIES, { session, anonymous })
  return ctx.next!();
};

// Then in loaders:
const segment = getSegmentFromBag(ctx);    // ctx.bag.get(SEGMENT)
```

### Port
```typescript
// middleware.ts — extracts context for downstream use
export function extractVtexContext(cookieHeader: string) {
  const config = getVtexConfig();
  const cookies = parseCookieString(cookieHeader);
  const segment = buildSegmentFromCookies(cookies);
  const isSession = cookies.get("vtex_is_session") ?? crypto.randomUUID();
  const isAnonymous = cookies.get("vtex_is_anonymous") ?? crypto.randomUUID();
  return { ...config, segment, isSession, isAnonymous };
}

// In loaders — pass context explicitly:
export default async function productList(props: Props) {
  const config = getVtexConfig();
  const data = await intelligentSearch<T>(path, params, {
    cookieHeader: `vtex_is_session=${session}`,
  });
}
```

**Key difference**: No global per-request storage. Context is either:
1. Passed explicitly through function params
2. Read from singleton config (for static values like `account`, `salesChannel`)

## 5. Hooks (Signals → React Query)

### Original (Preact Signals + Serial Queue)
```typescript
// hooks/context.ts
import { signal } from "@preact/signals";
const cart = signal<OrderForm | null>(null);
const loading = signal(true);

const enqueue = (cb) => {
  abort();
  loading.value = true;
  queue = queue.then(async () => {
    const result = await cb(controller.signal);
    cart.value = result.cart || cart.value;
    loading.value = false;
  });
};

// hooks/useCart.ts
const addItems = enqueue("vtex/actions/cart/addItems.ts");
export const useCart = () => ({ cart, loading, addItems });
```

### Port (React Query)
```typescript
// hooks/useCart.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export function useCart() {
  const queryClient = useQueryClient();

  const { data: cart, isLoading } = useQuery({
    queryKey: ["vtex-cart"],
    queryFn: fetchCart,
    staleTime: 0,
  });

  const addItems = useMutation({
    mutationFn: addItemsToCart,
    onSuccess: (newCart) => {
      queryClient.setQueryData(["vtex-cart"], newCart);
    },
  });

  return { cart, loading: isLoading, addItems };
}
```

**Key advantages of React Query version**:
- Built-in loading/error/success states
- Automatic refetching on mount/focus
- Optimistic updates via `setQueryData`
- No manual abort controller management
- Devtools integration

## 6. Typed HTTP Client → vtexFetch

### Original
```typescript
// Uses Proxy-based typed client
const response = await ctx.vcsDeprecated
  ["POST /api/checkout/pub/orderForm/:orderFormId/coupons"](
    { orderFormId: cart.orderFormId, sc: channel },
    { body: { text: couponCode } },
  );
```

### Port
```typescript
// Direct fetch with string URL
const orderForm = await vtexFetch<OrderForm>(
  `/api/checkout/pub/orderForm/${orderFormId}/coupons?sc=${sc}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: couponCode }),
  },
);
```

**Lost**: Type safety on URL params, response type, and body type. Mitigate by keeping the same function structure as the original.

## 7. GraphQL Client

### Original
```typescript
const { io } = ctx;
const data = await io.query<WishlistResponse, Variables>({
  query: MY_QUERY,
  variables: { id },
}, { headers: { cookie } });
```

### Port
```typescript
import { vtexIOGraphQL } from "../client";
const data = await vtexIOGraphQL<WishlistResponse>(
  { query: MY_QUERY, variables: { id } },
  { cookie: buildAuthCookieHeader(authCookie, account) },
);
```

## 8. Cookie Propagation

### Original
```typescript
import { proxySetCookie } from "../utils/cookies.ts";
const response = await ctx.vcsDeprecated["POST /api/..."](params, opts);
proxySetCookie(response.headers, ctx.response.headers, req.url);
return response.json();
```

### Port
```typescript
import { vtexFetchWithCookies } from "../client";
const result = await vtexFetchWithCookies<OrderForm>(url, opts);
// result.data = the JSON response
// result.setCookies = string[] of Set-Cookie headers
// Caller (storefront) is responsible for setting these cookies on the response
return result;
```

## 9. Deno Standard Library

| Original (Deno std) | Port (Node/Browser) |
|---------------------|---------------------|
| `getCookies(headers)` from `std/http/cookie.ts` | Manual parsing or `cookie` npm package |
| `setCookie(headers, cookie)` from `std/http/cookie.ts` | `res.headers.append("Set-Cookie", ...)` |
| `getSetCookies(headers)` from `std/http/cookie.ts` | `response.headers.getSetCookie()` |
| `btoa(str)` / `atob(str)` | Same (global in Node 16+) |
| `crypto.randomUUID()` | Same (global in Node 19+) |
| `Deno.env.get("VAR")` | `process.env.VAR` |

## 10. Import Specifiers

| Original | Port |
|----------|------|
| `from "./mod.ts"` | `from "./mod"` (no .ts extension) |
| `from "../../commerce/types.ts"` | `from "../../commerce/types/commerce"` |
| `from "std/http/mod.ts"` | Remove, use built-in or npm |
| `from "@deco/deco"` | Remove — no framework |
| `from "$fresh/runtime.ts"` | Remove — `typeof document !== "undefined"` |

## Summary: Porting Checklist Per File

When porting any file from `deco-cx/apps/vtex/` to `apps-start/vtex/`:

1. [ ] Copy the business logic (API calls, data transformations)
2. [ ] Replace `ctx.*` with `getVtexConfig().*` or explicit params
3. [ ] Replace typed client calls with `vtexFetch`/`vtexFetchWithCookies`
4. [ ] Replace `io.query` with `vtexIOGraphQL`
5. [ ] Replace `proxySetCookie` with returning `{ data, setCookies }`
6. [ ] Replace Deno std cookie functions with manual parsing
7. [ ] Remove `.ts` from import paths
8. [ ] Remove `@deco/deco` and `$fresh` imports
9. [ ] Keep the same VTEX API URLs and parameters
10. [ ] Keep the same schema.org transform.ts usage
11. [ ] Add `salesChannel` where original has it
12. [ ] Add `expectedOrderFormSections` where original has it
