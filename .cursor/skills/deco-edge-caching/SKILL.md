---
name: deco-edge-caching
description: Configure edge caching for Deco storefronts on Cloudflare Workers using createDecoWorkerEntry, cacheHeaders, detectCacheProfile, and routeCacheDefaults from @decocms/start. Use when setting up worker-entry caching, tuning Cache-Control headers, adding cache profiles for commerce page types (PDP, PLP, search), configuring staleTime for TanStack Router routes, debugging cache HITs/MISSes, or implementing cache purge APIs.
---

# Deco Edge Caching

Complete caching infrastructure for Deco storefronts on Cloudflare Workers, provided by `@decocms/start/sdk`.

## Architecture Overview

Three caching layers work together:

| Layer | What | Where | TTL Control |
|-------|------|-------|-------------|
| **Edge cache** | Full HTML responses | Cloudflare Cache API + CDN | `cacheHeaders(profile)` via worker-entry |
| **Loader cache** | VTEX/Shopify API data | In-memory per-isolate (V8) | `createCachedLoader()` in setup.ts |
| **Client cache** | Route data after navigation | TanStack Router memory | `routeCacheDefaults(profile)` on routes |

The **worker-entry** is the authority for edge caching. Routes declare intent via `headers()` and `staleTime`, but the worker-entry overrides Cache-Control based on URL-detected profiles.

## Cache Profiles

| Profile | Browser `max-age` | Edge `s-maxage` | SWR | Client `staleTime` |
|---------|------------------|-----------------|-----|---------------------|
| `static` | 1 hour | 1 day | 1 day | 5 min |
| `product` | 60s | 5 min | 1 hour | 1 min |
| `listing` | 30s | 2 min | 10 min | 1 min |
| `search` | 0 | 60s | 5 min | 30s |
| `cart` | private | — | — | 0 |
| `private` | private | — | — | 0 |
| `none` | private | — | — | 0 |

## URL-to-Profile Detection (built-in)

| URL Pattern | Detected Profile |
|-------------|-----------------|
| `/` | `static` |
| `*/p` (ends with /p) | `product` |
| `/s`, `/s/*`, `?q=` | `search` |
| `/cart`, `/checkout`, `/account`, `/login` | `private` |
| `/api/*`, `/deco/*`, `/_server`, `/_build` | `none` |
| Everything else | `listing` (conservative default) |

## Site Worker Entry (10 lines)

```ts
// src/worker-entry.ts
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";

const serverEntry = createServerEntry({
  async fetch(request) {
    return await handler.fetch(request);
  },
});

export default createDecoWorkerEntry(serverEntry);
```

### With Custom Overrides

```ts
export default createDecoWorkerEntry(serverEntry, {
  // Override profile for specific URLs
  detectProfile: (url) => {
    if (url.pathname.startsWith("/institucional")) return "static";
    return null; // fall through to built-in detection
  },
  // Disable mobile/desktop cache key splitting
  deviceSpecificKeys: false,
  // Custom purge token env var
  purgeTokenEnv: "MY_PURGE_TOKEN",
  // Add extra bypass paths
  extraBypassPaths: ["/preview/"],
});
```

## Route Setup

```ts
import { createFileRoute } from "@tanstack/react-router";
import { cacheHeaders, routeCacheDefaults } from "@decocms/start/sdk/cacheHeaders";

export const Route = createFileRoute("/")({
  ...routeCacheDefaults("static"),
  headers: () => cacheHeaders("static"),
  loader: () => loadPage(),
  component: HomePage,
});
```

For the CMS catch-all route:

```ts
export const Route = createFileRoute("/$")({
  ...routeCacheDefaults("listing"),
  headers: () => cacheHeaders("listing"),
  loader: async ({ params }) => { /* ... */ },
  component: CmsPage,
});
```

The worker-entry overrides the route's Cache-Control with the correct profile for each URL (PDP gets `product`, search gets `search`, etc.), so the route's `headers()` serves as a fallback for client-side navigation responses via `/_server`.

## Registering Custom Patterns

```ts
// In setup.ts or worker-entry.ts
import { registerCachePattern } from "@decocms/start/sdk/cacheHeaders";

registerCachePattern({
  test: (pathname) => pathname.startsWith("/blog"),
  profile: "static",
});
```

Custom patterns evaluate before built-in ones.

## Factory Features

`createDecoWorkerEntry` provides:

1. **Cache API integration** — `caches.default.match()` / `.put()` for edge caching
2. **Device-specific keys** — mobile/desktop get separate cached HTML (`__cf_device` param)
3. **Per-URL profiles** — `detectCacheProfile(url)` selects the right Cache-Control
4. **Immutable static assets** — `/_build/assets/*-{hash}.*` get `immutable, max-age=31536000`
5. **Private path protection** — strips public Cache-Control from cart/checkout/account responses
6. **Cache API TTL fix** — stores with `max-age={sMaxAge}` since Cache API ignores `s-maxage`
7. **Purge API** — `POST /_cache/purge` with bearer token to invalidate paths
8. **Diagnostic headers** — `X-Cache: HIT|MISS` and `X-Cache-Profile: {profile}`

## Debugging Cache

```bash
# Check profile and cache status
curl -s -D - -o /dev/null "https://site.com/category-slug" | grep -iE "cache-control|x-cache"

# Expected first hit:
# cache-control: public, max-age=30, s-maxage=120, stale-while-revalidate=600
# x-cache: MISS
# x-cache-profile: listing

# Expected second hit:
# cf-cache-status: HIT
# x-cache: HIT
# age: 3

# Purge cache
curl -X POST "https://site.com/_cache/purge" \
  -H "Authorization: Bearer $PURGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paths": ["/", "/vedacao-externa"]}'
```

**Important**: Use GET requests for testing (not `curl -I` which sends HEAD). The worker-entry only caches GET requests.

## Loader Cache (Server-Side SWR)

In `setup.ts`, wrap commerce loaders with `createCachedLoader`:

```ts
import { createCachedLoader } from "@decocms/start/sdk/cachedLoader";

const cachedPLP = createCachedLoader("vtex/plp", vtexPLP, {
  policy: "stale-while-revalidate",
  maxAge: 60_000,
});
```

This is per-isolate in-memory cache (V8 Map). Resets on cold start. Includes request deduplication (single-flight) and LRU eviction at 500 entries.

## Key Constraints

- **Cache API ignores `s-maxage`** — the factory uses `max-age` equal to `sMaxAge` when storing in Cache API
- **In-memory loader cache is ephemeral** — resets when Workers isolates recycle (~30s idle)
- **Device keys add a query param** — `__cf_device=mobile|desktop` is appended to cache keys, so purging must clear both
- **Non-200 responses are never cached** — only 200 OK goes into Cache API
- **`/_server` paths always bypass cache** — TanStack Start RPC requests are never edge-cached

## Package Exports

```ts
// Headers and profiles
import { cacheHeaders, routeCacheDefaults, detectCacheProfile } from "@decocms/start/sdk/cacheHeaders";
import { getCacheProfileConfig, registerCachePattern } from "@decocms/start/sdk/cacheHeaders";

// Worker entry factory
import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";

// Loader cache
import { createCachedLoader, clearLoaderCache } from "@decocms/start/sdk/cachedLoader";
```
