# Platform Hooks — Factory Pattern

> **Canonical reference for `createUseCart` / `createUseUser` /
> `createUseWishlist` from `@decocms/apps/vtex/hooks`.** These factories
> ship the legacy invoke-based hook semantics that migrated Fresh sites
> depend on — module-level singleton state, listener-based re-render,
> awaitable async actions, signal-shaped accessors. Sites consume them
> as 5-line shims.

This doc replaces the pre-W12 "manual `createServerFn` per VTEX endpoint"
approach in
[`platform-hooks/README.md`](./platform-hooks/README.md). If you scaffolded
a site before Wave 12 (≤ `@decocms/apps@2.x` / `@decocms/start@2.18`), see
"Migrating off the manual approach" at the bottom.

---

## What the factories own

| Concern | Where it lives |
|---|---|
| Module-level singleton state (`cart`, `user`, `wishlist`) | Inside the factory closure |
| `useEffect` + `forceRender(c => c + 1)` re-render pattern | Factory |
| Signal-shaped accessors (`cart.value`, `user.value`) | Factory |
| Awaitable mutations (`await addItem(...)`) | Factory |
| `itemToAnalyticsItem` helper (cart) | Factory |
| Wishlist arg swap (`productId` ↔ `productGroupId`) | Factory |
| **VTEX HTTP calls** | NOT in the factory — provided by the `invoke` proxy you pass in |

The factory only wires state + listeners. The site provides an `invoke`
object whose shape is structurally typed against
`CreateUseCartInvoke` / `CreateUseUserInvoke` / `CreateUseWishlistInvoke`
(exported next to each factory). The migration template generates an
`invoke` proxy in `src/server/invoke.ts` that meets all three shapes
without any extra wiring.

---

## Site-local shim (the entire file)

### `src/hooks/useCart.ts`

```ts
import { createUseCart } from "@decocms/apps/vtex/hooks/createUseCart";
import { invoke } from "~/server/invoke";

export type { OrderForm, OrderFormItem } from "@decocms/apps/vtex/types";

export const { useCart, resetCart, itemToAnalyticsItem } = createUseCart({
  invoke,
});
```

### `src/hooks/useUser.ts`

```ts
import { createUseUser } from "@decocms/apps/vtex/hooks/createUseUser";
import { invoke } from "~/server/invoke";

export type { Person } from "@decocms/apps/vtex/loaders/user";

export const { useUser, resetUser } = createUseUser({ invoke });
```

### `src/hooks/useWishlist.ts`

```ts
import { createUseWishlist } from "@decocms/apps/vtex/hooks/createUseWishlist";
import { invoke } from "~/server/invoke";

export type { WishlistItem } from "@decocms/apps/vtex/loaders/wishlist";

export const { useWishlist, resetWishlist } = createUseWishlist({ invoke });
```

That's the whole hook — no `createServerFn`, no VTEX URLs, no `AppKey`
plumbing. `npm run migrate` scaffolds these three files automatically
when `--platform vtex` is set; if you regenerate, the migration template
in `scripts/migrate/templates/hooks.ts` is the source of truth.

---

## Why a factory and not a single hook?

> Two reasons that come up repeatedly when reviewing migration PRs.

1. **`useCart` already exists in apps.** The canonical `vtex/hooks/useCart.ts`
   is built on TanStack Query and exposes the `Minicart` shape — that is
   the shape new code should target. The factory exists strictly so
   already-migrated UIs keep working without a rewrite. Both can coexist
   in one site.
2. **Singletons can't live in a shared package without leaking across
   sites.** The factory call instantiates a fresh module-level state per
   site. Importing `useCart` directly from apps would share state across
   any sites that ran in the same Worker (matters less in practice, but
   it's the architectural reason the factory exists).

The factory boundary is also the seam where we'd later wire
`@tanstack/store` if we wanted to — the API shape is signal-compatible
already.

---

## Non-VTEX platforms

Sites that target Wake / Shopify / VNDA / Linx / Nuvemshop still need a
hook surface that AddToCartButtons can consume. Until each platform has
its own factory in `@decocms/apps`, scaffold a no-op shim:

```ts
// src/hooks/useCart.ts (custom platform)
import { signal } from "@decocms/start/sdk/signal";

const cart = signal<unknown>(null);
const loading = signal(false);

export function useCart() {
  return {
    cart,
    loading,
    async getCart() {
      // TODO: call your platform's cart API via ~/server/invoke
      return null;
    },
    async addItems(_items: unknown[]) {
      // TODO
    },
    async updateItems(_items: unknown[]) {
      // TODO
    },
    setCart(next: unknown) {
      cart.value = next;
    },
  };
}

export default useCart;
```

`@decocms/start/sdk/signal` (re-exported via `~/sdk/signal` after
migration) gives you the same `.value` getter/setter the factory uses,
so AddToCart UI components don't need to know which platform is wired.

The migration template's `generateGenericUseCart()` emits this stub when
`--platform` is `custom` (or any non-VTEX value).

---

## Migrating off the manual approach (pre-W12 sites)

If your site contains files like `src/lib/vtex-cart-server.ts` or hand-rolled `createServerFn` blocks for VTEX endpoints in `src/hooks/useCart.ts`, the post-cleanup audit will not auto-fix them — the manual code accumulated 6+ months of site-specific edits and the per-site judgment call about "what's still needed?" is real. The mechanical part:

1. Replace the entire body of `src/hooks/useCart.ts` with the 5-line factory shim above.
2. Delete `src/lib/vtex-cart-server.ts` (the migration template's `src/server/invoke.gen.ts` provides equivalent server functions wrapping `@decocms/apps/vtex/actions/checkout`).
3. Verify `src/server/invoke.ts` exports the proxy shape the factory needs (cart actions under `invoke.vtex.actions`). The migration template scaffolds this; older sites may need to add the missing entries by hand.
4. Run `npm run typecheck` — TypeScript will surface any callsites that referenced removed helpers (e.g. local `getOrCreateCart` shims).
5. Repeat for `useUser` / `useWishlist`.

For `useUser`, the analog of step 2 is removing any local `currentUser` /
`getUser` server functions in favor of `@decocms/apps/vtex/loaders/user`
exposed via `invoke.vtex.loaders.user()`. For `useWishlist`, the
canonical surface is `@decocms/apps/vtex/{actions,loaders}/wishlist`.

If you find yourself wanting to add behaviour to a factory (extra cart
actions, custom analytics events) rather than ripping out the factory and going back to a manual hook:

- **Extra read paths** → expose a new loader from
  `@decocms/apps/vtex/loaders/*`, register it in `~/server/invoke.ts`,
  call from your component (the factory doesn't need to know).
- **Extra write paths** → ditto for `@decocms/apps/vtex/actions/*`.
- **Cross-cutting business logic** (e.g. PIX-specific offer pricing) →
  this is the kind of seam that justifies a parallel `useOffer` factory.
  Talk to the apps maintainers; opening up a factory's plugin slots is a
  one-PR change in apps, not a per-site rewrite.

---

## `useSuggestions` (search autocomplete) — the same pattern at framework layer

`createUseSuggestions` lives in `@decocms/start/sdk/useSuggestions`
(not apps), because the queue + cancel + invoke-fetch primitive is
not commerce-specific. It debounces and serialises calls to
`/deco/invoke/<__resolveType>` and exposes signal-shaped state —
exactly the shape both casaevideo and baggagio independently
invented in their site-local `src/sdk/useSuggestions.ts`.

### Site-local shim (the entire file)

```ts
// src/sdk/useSuggestions.ts
import { createUseSuggestions } from "@decocms/start/sdk/useSuggestions";
import * as Sentry from "@sentry/react";
import type { Suggestion } from "@decocms/apps/commerce/types";

export const { useSuggestions } = createUseSuggestions<Suggestion>({
  onError: (err) => Sentry.captureException(err),
});
```

The call sites stay byte-identical:

```ts
const { setQuery, payload, loading } = useSuggestions(loader);
```

### Why a factory and not a plain hook

Same two reasons as the apps factories:

1. **State isolation per call.** Each `createUseSuggestions()`
   instantiates a fresh `payload` / `loading` / queue tuple. Sites
   with multiple independent suggestion streams (e.g. searchbar +
   category jumper) each call the factory and bind their own
   `useSuggestions`.
2. **Type narrowing at the boundary.** The factory takes `<T>` once;
   the returned hook is already specialised, so callers don't re-pass
   generics. Sites pick `Suggestion` (VTEX), `Suggestions` (Shopify),
   or any custom shape at the factory boundary.

### What the factory owns

| Concern | Where it lives |
|---|---|
| Module-level signals (`payload`, `loading`) per stream | Factory closure |
| Serial in-flight queue | Factory closure |
| Latest-query cancel guard | Factory closure |
| `fetch('/deco/invoke/<resolveType>', { body: { query, …extraProps } })` | Factory |
| `onError(error, query)` Sentry/OTEL hook | Site (passed at instantiation) |
| `console.error('[useSuggestions] fetch failed:', error)` | Factory (always runs) |
| Suggestion payload type | Site (factory generic `<T>`) |

### Migrating off the hand-rolled hook

If your site has a 50-line `src/sdk/useSuggestions.ts` with module-level
`signal`s and a `latestQuery` variable, the post-cleanup audit's
`local-framework-duplicate` rule flags it (warn-only, since the
per-site type parameter and `onError` wiring need site-specific
decisions). The mechanical migration:

1. Replace the entire file with the 5-line factory shim above.
2. Pick the right `<T>` for your site:
   - VTEX: `Suggestion` from `@decocms/apps/commerce/types`
   - Sites with custom intelligent-search loaders: the loader's
     payload type (e.g. `IntelligenseSearch`)
3. Decide on `onError` — pass `(err) => Sentry.captureException(err)`
   if you wired Sentry; omit it otherwise. The factory always logs
   to console after `onError` returns, so unhandled cases stay
   visible.
4. Run `npm run typecheck` — call sites stay byte-identical.

The advanced `_internal` field on the factory return value exposes
the raw signals + a non-React `setQuery` and a `drain()` promise.
Sites use it for SSR pre-fetch helpers and tests; you almost never
need it.

---

## Related

- `scripts/migrate/templates/hooks.ts` — the template that emits the
  cart/user/wishlist shims.
- `apps-start/vtex/hooks/createUseCart.ts` /
  `createUseUser.ts` / `createUseWishlist.ts` — the platform factories
  themselves; each docstring is the authoritative API reference.
- `deco-start/src/sdk/useSuggestions.ts` — the
  `createUseSuggestions` factory (framework layer, platform-agnostic).
- `references/platform-hooks/README.md` — historical reference for the
  pre-W12 manual approach (kept for sites that haven't migrated yet).
