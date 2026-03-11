# Cookie & Auth Patterns for VTEX apps-start

Reference for cookie propagation and authentication patterns in the TanStack Start port.

## vtexFetchWithCookies

Standard `vtexFetch` discards response headers. For any mutation that generates `Set-Cookie`:

```typescript
export interface VtexFetchResult<T> {
  data: T;
  setCookies: string[];
}

export async function vtexFetchWithCookies<T>(
  path: string,
  init?: RequestInit,
): Promise<VtexFetchResult<T>> {
  const response = await vtexFetchResponse(path, init);
  const data = await response.json() as T;
  const setCookies: string[] = [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") setCookies.push(value);
  });
  if (setCookies.length === 0 && typeof response.headers.getSetCookie === "function") {
    setCookies.push(...response.headers.getSetCookie());
  }
  return { data, setCookies };
}
```

Use in: `checkout.ts`, `auth.ts`, `session.ts` (create/edit).

## buildAuthCookieHeader

VTEX IO GraphQL at `{account}.myvtex.com` requires both cookie names:

```typescript
// vtexId.ts
export const VTEX_AUTH_COOKIE = "VtexIdclientAutCookie";

export function buildAuthCookieHeader(authCookie: string, account: string): string {
  if (authCookie.includes("=")) return authCookie;
  return `${VTEX_AUTH_COOKIE}=${authCookie}; ${VTEX_AUTH_COOKIE}_${account}=${authCookie}`;
}
```

Usage in any authenticated GraphQL action:

```typescript
import { buildAuthCookieHeader } from "../utils/vtexId";
import { getVtexConfig } from "../client";

const { account } = getVtexConfig();
const result = await vtexIOGraphQL<T>(
  { query: MY_MUTATION, variables },
  { cookie: buildAuthCookieHeader(authCookie, account) },
);
```

Files that use this pattern:
- `actions/address.ts` — gql helper
- `actions/misc.ts` — gql helper
- `actions/newsletter.ts` — gql helper
- `actions/profile.ts` — gql helper
- `actions/wishlist.ts` — buildCookieHeader
- `actions/session.ts` — deleteSession
- `utils/enrichment.ts` — simulation auth

Files that use `VTEX_AUTH_COOKIE` directly (as header name, not cookie):
- `actions/misc.ts` — submitReview sends `{ [VTEX_AUTH_COOKIE]: authCookie }` as HTTP header (Reviews API quirk)

## DEFAULT_EXPECTED_SECTIONS

VTEX returns incomplete OrderForm without explicit sections. Always include:

```typescript
export const DEFAULT_EXPECTED_SECTIONS = [
  "items",
  "totalizers",
  "clientProfileData",
  "shippingData",
  "paymentData",
  "sellers",
  "messages",
  "marketingData",
  "clientPreferencesData",
  "storePreferencesData",
  "giftRegistryData",
  "ratesAndBenefitsData",
  "openTextField",
  "commercialConditionData",
  "customData",
];
```

Used in:
- `actions/checkout.ts` — all cart mutations
- `loaders/cart.ts` — getCart POST body
- `hooks/useCart.ts` — client-side fetchCart POST body

## Intelligent Search Cookies

VTEX Intelligent Search requires tracking cookies. Generate in middleware if missing:

```typescript
// middleware.ts
const vtexIsSession = cookies.get("vtex_is_session") ?? crypto.randomUUID();
const vtexIsAnonymous = cookies.get("vtex_is_anonymous") ?? crypto.randomUUID();
```

Pass to `intelligentSearch()` via `opts.cookieHeader`:

```typescript
const data = await intelligentSearch<T>(path, params, {
  cookieHeader: `vtex_is_session=${session}; vtex_is_anonymous=${anonymous}`,
  locale: "pt-BR",
});
```

## HttpOnly Cookie Rule

`VtexIdclientAutCookie` is HttpOnly — invisible to `document.cookie`.

Client-side hooks must NOT check for this cookie. Instead:

```typescript
// useUser.ts — correct pattern
async function fetchUser(): Promise<VtexUser> {
  const res = await fetch(
    "/api/sessions?items=profile.email,profile.firstName,profile.lastName,profile.id",
    { credentials: "include" },
  );
  // Parse session response for user data
}
```

## salesChannel Injection Points

| Component | How sc is injected |
|-----------|-------------------|
| `client.ts` intelligentSearch | Auto from `getVtexConfig().salesChannel` |
| `hooks/useCart.ts` | Reads `VTEXSC` cookie via `document.cookie` |
| `loaders/cart.ts` | From `getVtexConfig().salesChannel` |
| `loaders/catalog.ts` | From `getVtexConfig().salesChannel` |
| `loaders/legacy.ts` | `buildSearchParams()` includes `sc` |
| `actions/checkout.ts` | Helper `scParam()` / `appendSc()` |
| `middleware.ts` | Reads `VTEXSC` cookie from request |
