# Shared Utils — `/utils/` Reference

The root `/utils/` directory provides platform-agnostic utilities used by all apps.

## `http.ts` — Typed HTTP Client

### `createHttpClient<T>(options)`

Creates a Proxy-based HTTP client typed against an interface `T` where keys follow the pattern `"VERB /path/:param"`.

```typescript
import { createHttpClient } from "../utils/http.ts";

interface MyAPI {
  "GET /users/:id": {
    response: User;
    searchParams: { fields?: string };
  };
  "POST /users": {
    response: User;
    body: { name: string; email: string };
  };
}

const client = createHttpClient<MyAPI>({
  base: "https://api.example.com",
  headers: new Headers({ "Authorization": "Bearer ..." }),
  fetcher: fetchSafe,            // Optional custom fetcher
  processHeaders: removeDirtyCookies, // Optional header processor
});

// Usage — fully typed params, body, and response
const res = await client["GET /users/:id"]({ id: "123", fields: "name" });
const user = await res.json(); // typed as User
```

### Interface Pattern for Typed Endpoints

```typescript
interface API {
  "VERB /path/:required/:optional?/*wildcard": {
    response: ResponseType;        // Return type of .json()
    body: BodyType;                // Required for POST/PUT/PATCH
    searchParams: {                // Query string parameters
      required: string;
      optional?: number;
    };
  };
}
```

- URL params with `:` are extracted from the first argument
- Remaining keys become query string params
- `body` auto-serializes objects to JSON

### `HttpError`

```typescript
class HttpError extends Error {
  status: number;
}
```

### `nullOnNotFound`

```typescript
const product = await client["GET /product/:id"]({ id }).catch(nullOnNotFound);
// Returns null for 404, rethrows other errors
```

---

## `graphql.ts` — GraphQL Client

### `createGraphqlClient(options)`

```typescript
import { createGraphqlClient, gql } from "../utils/graphql.ts";

const client = createGraphqlClient({
  endpoint: "https://api.example.com/graphql",
  fetcher: fetchSafe,
});

const data = await client.query<ResponseType, VariablesType>({
  query: gql`query GetUser($id: ID!) { user(id: $id) { name } }`,
  variables: { id: "123" },
  operationName: "GetUser",  // optional
  fragments: [fragmentStr],  // optional — appended to query
});
```

### `gql` Template Tag

```typescript
const MY_QUERY = gql`
  query GetProducts($first: Int!) {
    products(first: $first) { id name }
  }
`;
```

---

## `fetch.ts` — Safe Fetch with Retry

### `fetchSafe(input, init?)`

Wraps `fetch` with:
- Retry on connection closed errors (1 retry, exponential backoff)
- Throws `HttpError` on non-OK responses
- Handles 301/302 with `redirect: "manual"`

### `fetchAPI<T>(input, init?)`

Convenience that sets `Accept: application/json` and returns `response.json()`.

### `STALE`

```typescript
export const STALE = {
  deco: { cache: "stale-while-revalidate" },
} as const;

// Usage: fetch(url, { ...init, ...STALE })
```

---

## `cookie.ts` — Cookie Utilities

### `proxySetCookie(from, to, toDomain?)`

Copies Set-Cookie headers from one response to another, optionally rewriting the domain.

```typescript
proxySetCookie(vtexResponse.headers, ctx.response.headers, req.url);
```

### `getFlagsFromCookies(cookies)`

Extracts Deco feature flags from the `DECO_SEGMENT` cookie.

---

## `normalize.ts` — String Sanitization

| Function | Purpose |
|----------|---------|
| `removeScriptChars(str)` | Removes `+`, brackets, slashes, dots, diacritics |
| `removeNonLatin1Chars(str)` | Strips non-ASCII and quotes |
| `removeNonAscChars(str)` | Same as above (alias) |
| `removeDirtyCookies(headers)` | Sanitizes the `cookie` header — removes brackets and diacritics |

Used as `processHeaders` in HTTP clients to prevent malformed cookies from breaking API calls.

---

## Other Utils

| File | Purpose |
|------|---------|
| `lru.ts` | LRU cache with `get`, `set`, `delete` |
| `shortHash.ts` | `hashString` (SHA-256 async), `hashStringSync` (simple hash) |
| `pool.ts` | Resource pool with `acquire`/`release` (uses Deferred) |
| `worker.ts` | Web Worker abstraction (Comlink-style `postMessage` RPC) |
| `dataURI.ts` | Converts scripts to `data:` URIs for inline `<script>` tags |
| `capitalize.ts` | Capitalizes first letter of each word |
| `deferred.ts` | `__DECO_FBT` and `shouldForceRender` for async rendering |

---

## Commerce Utils (`/commerce/utils/`)

| File | Purpose |
|------|---------|
| `canonical.ts` | `canonicalFromBreadcrumblist(b)` — extracts URL from last breadcrumb item |
| `constants.ts` | `DEFAULT_IMAGE` — placeholder ImageObject for products without images |
| `filters.ts` | `parseRange("10:100")` → `{ from: 10, to: 100 }`, `formatRange(10, 100)` → `"10:100"` |
| `productToAnalyticsItem.ts` | `mapProductToAnalyticsItem({ product, breadcrumbList, price, ... })` → `AnalyticsItem` |
| `stateByZip.ts` | `getStateFromZip("01001000")` → `"SP"` — maps Brazilian ZIP to state |
