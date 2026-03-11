# Client-Side Patterns

How Deco storefronts handle client-side interactivity via islands, the invoke proxy, signals, analytics, and SDK utilities.

## Invoke Proxy (`runtime.ts`)

Every site creates a typed invoke proxy that bridges client-side code to server loaders/actions:

```typescript
// runtime.ts
import { proxy } from "@deco/deco/web";
import type { Manifest } from "./manifest.gen.ts";
import type { Manifest as VTEXManifest } from "apps/vtex/manifest.gen.ts";

export const invoke = proxy<Manifest & VTEXManifest>();
```

Merging `Manifest & VTEXManifest` gives typed access to both site-level and VTEX loaders/actions.

### Usage Patterns

**Direct typed call:**

```typescript
import { invoke } from "../runtime.ts";

const products = await invoke.vtex.loaders.legacy.productList({
  fq: `productId:${id}`,
  count: 1,
});
```

**Key-based call (dynamic loader from CMS):**

```typescript
const suggestions = await invoke({
  key: __resolveType,  // e.g., "vtex/loaders/intelligentSearch/suggestions.ts"
  props: { query, count: 5 },
});
```

This pattern is used when the loader key comes from a `Resolved<T>` prop set in the CMS, allowing the admin to choose which loader provides data.

**Action call:**

```typescript
const user = await invoke.site.actions.checkUser();
const orders = await invoke.site.loaders.listActiveOrders();
```

## Islands Architecture

Islands are Preact components that hydrate on the client. They're the boundary between server-rendered HTML and client-side interactivity.

### When to Use Islands

| Use Island | Use Section/Component |
|------------|----------------------|
| Click handlers, form inputs | Static display |
| Client-side state (signals) | Server-rendered data |
| API calls (invoke) | CMS-configured layout |
| Animations, IntersectionObserver | SEO-critical content |

### Island File Convention

Islands live in `islands/` and are registered in `fresh.gen.ts`:

```typescript
// islands/CartRetrofit/AddToCartButton.tsx
import { useSignal } from "@preact/signals";
import { useCart } from "apps/vtex/hooks/useCart.ts";
import { sendAnalyticsEvent } from "$store/sdk/analyticsRetrofit.tsx";

interface Props {
  skuId: string;
  sellerId: string;
  productName: string;
}

export default function AddToCartButton({ skuId, sellerId, productName }: Props) {
  const loading = useSignal(false);
  const { addItems } = useCart();

  const handleClick = async () => {
    loading.value = true;
    await addItems({ orderItems: [{ id: skuId, seller: sellerId, quantity: 1 }] });
    sendAnalyticsEvent({ name: "add_to_cart", params: { items: [{ item_name: productName }] } });
    loading.value = false;
  };

  return (
    <button onClick={handleClick} disabled={loading.value}>
      {loading.value ? "Adding..." : "Add to Cart"}
    </button>
  );
}
```

## Signals (`@preact/signals`)

Deco sites use Preact signals for reactive client-side state. Common patterns:

### Global UI State

```typescript
// sdk/useUIRetrofit.ts
import { signal } from "@preact/signals";

const displayCart = signal(false);
const displayMenu = signal(false);
const displaySearchDrawer = signal(false);
const displayWishlistModal = signal(false);

export const useUI = () => ({
  displayCart,
  displayMenu,
  displaySearchDrawer,
  displayWishlistModal,
});
```

Islands import `useUI()` to toggle drawers, modals, and overlays:

```typescript
const { displayCart } = useUI();
displayCart.value = true;  // opens cart drawer
```

### Loading / Pagination State

```typescript
// sdk/useShowMoreRetrofit.ts
import { signal } from "@preact/signals";

const currentPage = signal(0);
const loading = signal(false);

export const useShowMore = () => ({ currentPage, loading });
```

### Local Component State

```typescript
import { useSignal } from "@preact/signals";

export default function SizeSelector() {
  const selectedSize = useSignal<string | null>(null);
  const expandText = useSignal(false);

  return (
    <div>
      <button onClick={() => (expandText.value = !expandText.value)}>
        {expandText.value ? "Less" : "More"}
      </button>
      {/* size buttons update selectedSize.value */}
    </div>
  );
}
```

## usePartialSection (Infinite Scroll)

`usePartialSection` enables server-rendered partial updates without full page navigation. Used for "Load More" in PLPs:

```typescript
// components/searchRetrofit/Result.tsx
import { usePartialSection } from "deco/hooks/usePartialSection.ts";

function LoadMoreButton({ nextPage }: { nextPage: string }) {
  return (
    <button
      {...usePartialSection({
        href: nextPage,
        mode: "append",  // appends new content below existing
      })}
    >
      Load More
    </button>
  );
}
```

How it works:
1. Button click triggers a fetch to `/deco/render` with the section's resolve chain
2. Server renders the section with updated props (next page)
3. Response HTML is appended to the DOM (in `append` mode)
4. No client-side JS needed for the content itself

## Analytics

### Event Dispatch

Two systems work together:

```typescript
// sdk/analyticsRetrofit.tsx
export function sendEvent(event: AnalyticsEvent) {
  globalThis.window.DECO.events.dispatch(event);
}
```

```typescript
// components/scriptRetrofit/sendAnalyticsEvent.tsx
export function sendAnalyticsEvent(event: AnalyticsEvent) {
  // 1. Push to GTM dataLayer
  globalThis.dataLayer?.push({ event: event.name, ecommerce: event.params });
  // 2. Dispatch to Deco events system
  globalThis.window.DECO?.events?.dispatch(event);
}
```

### Event Components

**SendEventOnClick** -- fires when element is clicked:

```tsx
<SendEventOnClick event={{
  name: "select_item",
  params: { items: [{ item_id: product.sku, item_name: product.name }] }
}} id={elementId} />
```

Injects a script that adds a click listener to the element.

**SendEventOnLoad** -- fires when component mounts:

```tsx
<SendEventOnLoad event={{
  name: "view_item_list",
  params: { items: products.map(productToAnalyticsItem) }
}} />
```

**IntersectionObserver-based** -- fires when element is visible:

```tsx
<SendAnalyticsEventOnLoad rootId={elementId} event={{
  name: "view_promotion",
  params: { creative_name: bannerName }
}} />
```

### Data Attributes

Product cards use `data-deco` and `data-product-*` for tracking:

```tsx
<a href={url} data-deco="view-product" data-product-id={productId} data-product-name={name}>
  ...
</a>
```

### VTEX Search Events

```typescript
// sdk/useSearchEvents.ts
// Sends events to VTEX SP (search personalization):
// - search.query -- when user searches
// - search.autocomplete.query -- autocomplete queries
// - search.click -- when user clicks a search result
// - session.ping -- heartbeat
// - page.confirmation -- page view
```

## Cart / Wishlist / User Hooks

These come from the VTEX app (`apps/vtex/hooks/`):

### useCart

```typescript
import { useCart } from "apps/vtex/hooks/useCart.ts";

const { cart, addItems, updateItems, loading } = useCart();
```

Provides reactive cart state with mutations. Automatically syncs with VTEX OrderForm API.

### useWishlist

```typescript
import { useWishlist } from "apps/vtex/hooks/useWishlist.ts";

const { addItem, removeItem, getItem, loading } = useWishlist();

const isInWishlist = useComputed(() => !!getItem({ productId, skuId }));
```

### useUser

```typescript
import { useUser } from "apps/vtex/hooks/useUser.ts";

const { user } = useUser();
```

Sites often wrap this with a custom `useCheckUser` that caches in sessionStorage:

```typescript
// hooks/useCheckUser.ts
export function useCheckUser() {
  const cached = sessionStorage.getItem("user");
  if (cached) return JSON.parse(cached);
  const user = await invoke.site.actions.checkUser();
  sessionStorage.setItem("user", JSON.stringify(user));
  return user;
}
```

## SDK Utilities

Common SDK utilities found in production sites:

| Utility | Purpose |
|---------|---------|
| `useUI` | Global UI state signals (cart drawer, menu, search, wishlist modal) |
| `formatPrice` | `Intl.NumberFormat` with BRL/locale caching |
| `useOffer` | Extract price, listPrice, installments, availability from `AggregateOffer` |
| `useLazyLoad` | IntersectionObserver hook returning `[isVisible, setTarget]` |
| `useAddToCart` | Combines `useCart` + `useUI` + analytics for add-to-cart flow |
| `useSuggestions` | Debounced autocomplete via invoke + signals |
| `useVariantPossibilities` | Map product variants by spec (color, size) for selector UI |
| `useSizes` | Ordered size map (PP, P, M, G, GG) from variants |
| `useColumns` | Grid column count signals for PLP layout toggle |
| `useShowMore` | Pagination signals for infinite scroll |
| `useWindowSize` | Window dimensions with resize listener |
| `useIdRetrofit` | Unique ID generator (Fresh/Preact workaround) |
| `fetchStockBySku` | Batch SKU stock check via VTEX API |

## TanStack Migration Notes

When migrating these patterns to TanStack Start:

| Fresh/Preact Pattern | TanStack Equivalent |
|---------------------|---------------------|
| `invoke` proxy | Direct function imports + React Query |
| `@preact/signals` | `@tanstack/react-store` or `useState` |
| Islands | Regular React components (all hydrated) |
| `usePartialSection` | TanStack Router search params + React Query |
| `sendAnalyticsEvent` | Same pattern, use `useEffect` for load events |
| `useCart` / `useWishlist` | React Query mutations from `apps-start/vtex/hooks/` |
