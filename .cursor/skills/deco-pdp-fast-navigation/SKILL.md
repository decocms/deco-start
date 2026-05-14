---
name: deco-pdp-fast-navigation
description: Make PDP navigation feel instant in Deco TanStack Start storefronts. Combines TanStack Router intent prefetch with cache reuse, eager sections for atomic page swap, reserved-height LoadingFallback to eliminate CLS, and createCachedLoader for heavy loaders (thumbnail format detection, Vimeo oEmbed). Use when product card click → PDP open feels slow, when there is visible flicker/skeleton flash on navigation, or when PDP loader has many parallel fetches and click feels several seconds slow.
---

# PDP Fast Navigation

Patterns for making product card → PDP navigation feel instant in Deco storefronts on TanStack Start. The reference case: a storefront whose PDP loader had 7 parallel server fetches and product cards using `<a href>` (no prefetch). Each click had a multi-second perceived delay. Applying the five levers below brought it to sub-second perceived navigation.

## When to Use This Skill

- Click on a product card → PDP open feels noticeably slow (>1s perceived)
- PDP shows a skeleton/empty shell that flashes before content arrives
- Footer "jumps" up to the header then down again when PDP content loads (CLS)
- Product cards use `<a href>` instead of TanStack's `<Link>`
- PDP loader has `Promise.all` with many parallel API calls
- HAR or Network tab shows repeated HEAD requests for thumbnail format detection

---

## The Four Levers

These four optimizations compound — applying all of them is what makes PDP feel instant.

| Lever | What it solves | Effort |
|-------|----------------|--------|
| 1. `<Link preload="intent">` on cards | No prefetch at all | Drop-in replace `<a href>` |
| 2. `eager: true` on PDP sections | Avoids "empty shell flash" on navigation | Add export + regen sections |
| 3. `createDecoRouter` with `defaultPreloadStaleTime` | Preload result is reused on click, not refetched | One config object |
| 4. `createCachedLoader` on heavy loaders | Repeated fetches across navigations | Wrap loader function |

If you only apply 1 and 2, navigation may still feel slow because the preload result is not reused on click. Levers 3 and 4 close that gap.

---

## Lever 1 — Replace `<a href>` with `<Link preload="intent">` in Product Cards

The default behavior of TanStack Router's `<Link preload="intent">` is to prefetch the target route on hover (desktop) and on touchstart (mobile) after a ~50ms debounce. This warms the route loader before the user even clicks.

### Before

```tsx
import { relative } from "@decocms/apps/commerce/sdk/url";

function ProductCard({ product }) {
  const relativeUrl = relative(product.url);
  return (
    <a href={relativeUrl} aria-label="view product" className="...">
      <Image src={...} />
    </a>
  );
}
```

### After

```tsx
import { Link } from "@tanstack/react-router";
import { relative } from "@decocms/apps/commerce/sdk/url";

function ProductCard({ product }) {
  const relativeUrl = relative(product.url);
  return (
    <Link to={relativeUrl} preload="intent" aria-label="view product" className="...">
      <Image src={...} />
    </Link>
  );
}
```

### Notes

- `<Link to={string}>` accepts a relative URL directly — TanStack handles the splat (`/$`) param parsing internally. No need to decompose into `{ to: "/$", params: { _splat } }`.
- `<Link>` renders an `<a href>` in the DOM, so SSR/SEO/no-JS still work.
- Apply to **every variant of the card**: main grid card, mini card in search dropdown, card on PDP shelves, etc. A single missed card means missed prefetch.

### How to Find All Cards

```bash
rg '<a href=\{relativeUrl\}|<a href=\{relative\(' src/components/product/ -l
```

---

## Lever 2 — Mark Critical PDP Sections as `eager`

By default, Deco sections that export `LoadingFallback` are treated as **deferred**: when the user navigates to the PDP, the framework renders the new URL immediately, shows the `LoadingFallback`, and replaces it with the real content when the loader resolves. This causes two visible "steps":

1. URL changes → user sees an empty shell (the `LoadingFallback`)
2. Loader resolves → content fills in, pushing the page layout around

Marking the section as `eager: true` changes the behavior to **atomic**:

1. URL changes → the **current page stays visible** until the new page's loader fully resolves
2. New page swaps in already-complete

This eliminates the "two-step" feel. Combined with `<Link preload="intent">` and `defaultPreloadStaleTime`, the swap can happen instantly because the data was already fetched on hover.

### How

Add this export at the bottom of each critical PDP section file:

```tsx
// src/sections/Product/ProductDetails.tsx

export function LoadingFallback() {
  // see Lever 5 below — reserve height even though eager hides it most of the time
  return <div className="min-h-[1100px] lg:min-h-[716px] w-full" />;
}

export const eager = true;
```

Then regenerate the sections registry:

```bash
bun run generate:sections
```

The output should confirm the `eager` flag:

```
"site/sections/Product/ProductDetails.tsx": { eager: true, hasLoadingFallback: true },
```

### When NOT to Mark as Eager

- **Below-the-fold sections** like related products, reviews, cross-sell shelves — these can stay deferred. Marking them eager makes the user wait for non-critical data before seeing the PDP.
- **Sections with truly optional data** — anything that the user does not see in the first viewport.

Rule of thumb: only mark `eager` what is **above the fold and critical to the product purchase decision**. The main product container, image gallery, price/CTA — yes. Cross-sell shelves, reviews, bundles — no.

---

## Lever 3 — Configure `createDecoRouter` with `defaultPreloadStaleTime`

This is the **highest-leverage change** for perceived speed.

### The Problem

By default, the TanStack Router `defaultPreloadStaleTime` is short, so a prefetch fired on hover may be considered stale by the time the user clicks — causing a **second fetch** on click. The hover prefetch becomes wasted work.

### The Fix

Pass `defaultPreloadStaleTime` (and `defaultPreloadGcTime` for memory) to `createDecoRouter`:

```tsx
// src/router.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createDecoRouter } from "@decocms/start/sdk/router";
import { routeTree } from "./routeTree.gen";
import "./setup";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000 } },
});

export function getRouter() {
  return createDecoRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 60_000,
    defaultPreloadGcTime: 5 * 60_000,
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}
```

### What Changes

- **Hover** → prefetch fires after 50ms → result cached for 60s
- **Click within 60s** → router serves from cache → **navigation is instant**, no second fetch
- **Click after 60s** → router refetches (cache expired)

For e-commerce, 60s is a sweet spot: typical hover → click latency is <1s, but users may return to a category page and click a different product within a minute. The cache covers both flows.

### Available Options on `createDecoRouter`

```ts
interface CreateDecoRouterOptions {
  defaultPreload?: "intent" | "viewport" | "render" | false;
  defaultPreloadStaleTime?: number;    // recommend 60_000 for commerce
  defaultPreloadGcTime?: number;       // recommend 5 * 60_000
  defaultPreloadDelay?: number;        // hover debounce, default ~50ms
  defaultStaleTime?: number;           // applies to all loaders
  defaultPendingMs?: number;           // delay before pending UI shows
  defaultPendingMinMs?: number;        // min duration of pending UI
  // ... routeTree, scrollRestoration, trailingSlash, context, Wrap
}
```

---

## Lever 4 — Use `createCachedLoader` for Heavy Loaders

Even with prefetch and eager sections, the loader still has to complete at least once per worker lifetime per product. If the loader does multiple HTTP HEAD requests (thumbnail format detection) or external API calls (Vimeo oEmbed), these become the bottleneck.

Use `createCachedLoader` from `@decocms/start/sdk/cachedLoader` — it provides SWR caching, single-flight dedup, stale-if-error fallback, and LRU eviction out of the box. Do **not** roll your own LRU.

### Pattern

```ts
// src/loaders/checkAndReturnThumbnail360.ts
import { createCachedLoader } from "@decocms/start/sdk/cachedLoader";

interface Props { productID: string; }

const rawLoader = async ({ productID }: Props): Promise<string | null> => {
  if (!productID) return null;
  return await findValidImageExtension(productID);
};

export default createCachedLoader("checkAndReturnThumbnail360", rawLoader, {
  policy: "stale-while-revalidate",
  maxAge: 24 * 60 * 60_000, // 24h — thumbnail format rarely changes per product
  keyFn: (props) => (props as Props).productID ?? "",
});
```

### What `createCachedLoader` Gives You

- **Single-flight dedup:** concurrent requests for the same key share one fetch
- **SWR:** serve stale immediately, refresh in background
- **Stale-if-error:** on origin failure, fall back to stale entry within a window
- **LRU eviction:** cap of 500 entries by default
- **Profile presets:** pass `"product"` or `"listing"` instead of explicit options

### What to Cache

| Loader | Cache key | Profile / maxAge | Why |
|--------|-----------|------------------|-----|
| Thumbnail format detection | productID | 24h | Format rarely changes per product |
| Vimeo/YouTube oEmbed | contentUrl | 24h | Metadata never changes for published videos |
| Cross-sell / related products | productID + type | `"product"` (~5 min) | Hot path on PDPs |

### Also: Reduce Work, Not Just Cache It

If the loader is doing avoidable work, fix that first. Example: a thumbnail loader checking 6 extensions (`.jpg`, `.webp`, `.png`, `.jpeg`, `.bmp`, `.tiff`) — production catalogs almost always use `.jpg` or `.webp`. Reducing the list to 2 cut first-load cost by 66% before the cache even kicks in:

```ts
const extensionImageList = [".jpg", ".webp"];
```

---

## Lever 5 — Reserved-Height LoadingFallback (Anti-CLS)

If you keep some sections deferred (Lever 2 only on a subset), the `LoadingFallback` must reserve approximate height — otherwise the footer flies up to the header, then content arrives and pushes everything down. This is a massive CLS hit.

### Bad

```tsx
export function LoadingFallback() {
  return null; // or <div className="h-0 w-0" />
}
```

### Good

```tsx
export function LoadingFallback() {
  // Reserve approximate PDP height for both mobile and desktop
  return <div className="min-h-[1100px] lg:min-h-[716px] w-full" />;
}
```

### How to Pick the Height

- Inspect the rendered PDP in DevTools, get the main container height
- Use `min-h-` not `h-` to allow for content larger than expected
- Use Tailwind responsive variants (`lg:min-h-[...]`) since mobile is usually taller (vertical stacked layout)
- For shelves, use the slider height (typically ~400-500px)

### When Combined with Eager

If a section is `eager: true`, the `LoadingFallback` is rarely shown (only during SSR streaming gaps). Reserving height is still good defense — it costs nothing and protects against edge cases like slow first-paint.

---

## End-to-End Verification

After applying all five levers, validate in DevTools:

1. **Prefetch fires on hover**
   - Open DevTools → Network tab → filter `_serverFn`
   - Hover a product card for ~100ms
   - You should see a request to the catch-all route fire within ~50ms

2. **Click within 60s uses cache**
   - After hovering, wait 1-2 seconds
   - Click the card
   - **No new request should fire** — the loader response is served from the router's preload cache
   - PDP appears already populated (eager + cache = atomic swap)

3. **No CLS on navigation**
   - Use Chrome's Performance tab → Web Vitals
   - Navigate to a PDP, observe CLS metric
   - Should be < 0.05 (Good range)
   - The footer should not visibly "jump"

4. **Cold worker first hit**
   - Open an incognito window (cold worker, empty cache)
   - Navigate to a PDP
   - Should still feel fast — the 360 loader does 2 HEADs instead of 6, Vimeo fetches once, etc.

5. **Second visit to same PDP**
   - Navigate to PDP A → back → PDP A again
   - Second navigation should be measurably faster than first (`createCachedLoader` SWR hit)

---

## Trade-offs and Risks

| Choice | Trade-off |
|--------|-----------|
| `eager: true` on PDP | Page stays on current URL longer; relies on `NavigationProgress` for feedback. Acceptable if loader is <1s after prefetch hits cache. |
| `defaultPreloadStaleTime: 60_000` | Users on slow connections may see stale price/stock for up to 60s. Acceptable for retail; tune lower for flash sales. |
| `createCachedLoader` SWR | Cache survives the worker lifetime, not cold starts. First request after a cold start pays the full cost; subsequent requests within `maxAge` are instant. |
| Reducing thumbnail formats to 2 | Catalogs with legacy `.png`/`.tiff` 360 images break. Verify your catalog before applying. |

---

## Files Typically Modified

```
src/router.tsx                                   # Lever 3
src/sections/Product/<MainContainer>.tsx         # Lever 2 + 5
src/sections/Product/<MobileContainer>.tsx       # Lever 2 + 5
src/sections/Product/<AboveFoldShelf>.tsx        # Lever 2
src/sections/Product/<BelowFoldShelf>.tsx        # Lever 5 only
src/components/product/card/ProductCard.tsx      # Lever 1
src/components/product/card/<other variants>.tsx # Lever 1
src/loaders/<heavyLoader>.ts                     # Lever 4
src/server/cms/sections.gen.ts                   # regenerated after Lever 2
```

---

## Next Steps If Still Slow

If after all five levers the PDP still feels slow, the bottleneck is now the loader itself. Profile the remaining parallel calls:

```ts
// Add timing logs to identify the slowest fetch
const start = Date.now();
const result = await someLoader();
console.log(`someLoader took ${Date.now() - start}ms`);
```

Common next-step optimizations:

- **Move non-critical loaders to separate deferred sections.** Cross-sell, accessories, attachments, similar products can each become their own deferred section so they don't block the eager main container.
- **Wrap cross-sell results in `createCachedLoader`** with the `"product"` profile.
- **Reduce simulate calls.** VTEX's simulate endpoint is slow; if you only need price/stock, fetch it less aggressively.

---

## Related Skills

| Skill | Purpose |
|-------|---------|
| `deco-variant-selection-perf` | Avoid double-fetch on variant clicks (related navigation pattern) |
| `deco-cms-layout-caching` | Cache Header/Footer to avoid layout re-resolution on every navigation |
| `deco-vtex-fetch-cache` | SWR-style in-flight dedup for VTEX API calls (HTTP layer) |
| `deco-loader-n-plus-1-detector` | Find loops doing N+1 API calls in section loaders |
| `deco-edge-caching` | Configure Cloudflare Worker cache for commerce pages |
| `deco-cms-route-config` | `cmsRouteConfig` + `ignoreSearchParams` for stable cache keys |
