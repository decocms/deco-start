import type { MigrationContext } from "../types";

export function generateHooks(ctx: MigrationContext): Record<string, string> {
  const files: Record<string, string> = {};

  if (ctx.platform === "vtex") {
    files["src/hooks/useCart.ts"] = generateVtexUseCart();
    files["src/hooks/useUser.ts"] = generateVtexUseUser();
    files["src/hooks/useWishlist.ts"] = generateVtexUseWishlist();
  } else {
    files["src/hooks/useCart.ts"] = generateGenericUseCart();
    files["src/hooks/useUser.ts"] = generateGenericUseUser();
    files["src/hooks/useWishlist.ts"] = generateGenericUseWishlist();
  }

  return files;
}

function generateVtexUseCart(): string {
  // The legacy invoke-based useCart hook is now a 5-line factory call —
  // the heavy lifting (singleton state, listener pattern, async actions,
  // analytics helpers) lives in @decocms/apps/vtex/hooks/createUseCart.
  return `import { createUseCart } from "@decocms/apps/vtex/hooks/createUseCart";
import { invoke } from "~/server/invoke";

export type { OrderForm, OrderFormItem } from "@decocms/apps/vtex/types";

export const { useCart, resetCart, itemToAnalyticsItem } = createUseCart({
  invoke,
});
`;
}

function generateGenericUseCart(): string {
  return `/**
 * Cart Hook stub — implement for your platform.
 *
 * Wire invoke calls from ~/server/invoke to your commerce platform's
 * cart API (addItem, updateItem, getCart, etc.).
 */
import { signal } from "~/sdk/signal";

const cart = signal<any>(null);
const loading = signal(false);

export function useCart() {
  return {
    cart,
    loading,
    async getCart() {
      // TODO: Implement for your platform
      return null;
    },
    async addItems(_items: any[]) {
      // TODO: Implement
    },
    async updateItems(_items: any[]) {
      // TODO: Implement
    },
    setCart(newCart: any) {
      cart.value = newCart;
    },
  };
}

export default useCart;
`;
}

// VTEX path — these are five-line factory shims. The heavy lifting
// (singleton state, listener pattern, async actions, signal-shaped
// accessors, legacy arg-swap conventions) lives in
// @decocms/apps/vtex/hooks/createUseUser and createUseWishlist.
function generateVtexUseUser(): string {
  return `import { createUseUser } from "@decocms/apps/vtex/hooks/createUseUser";
import { invoke } from "~/server/invoke";

export type { Person } from "@decocms/apps/vtex/loaders/user";

export const { useUser, resetUser } = createUseUser({ invoke });
`;
}

function generateVtexUseWishlist(): string {
  return `import { createUseWishlist } from "@decocms/apps/vtex/hooks/createUseWishlist";
import { invoke } from "~/server/invoke";

export type { WishlistItem } from "@decocms/apps/vtex/loaders/wishlist";

export const { useWishlist, resetWishlist } = createUseWishlist({ invoke });
`;
}

// Non-VTEX fallback — keeps the legacy signal-based stub shape so any
// generic platform port that already consumes `~/hooks/useUser` keeps
// type-checking. Sites must wire their own platform-specific impl.
function generateGenericUseUser(): string {
  return `/**
 * User Hook — wire to invoke.site.loaders for your platform's user API.
 *
 * VTEX sites get a real factory from @decocms/apps/vtex/hooks/createUseUser;
 * see migration template hooks.ts for the canonical five-line shim.
 */
import { signal } from "~/sdk/signal";

export interface User {
  "@id": string;
  email: string;
  givenName?: string;
  familyName?: string;
}

const user = signal<User | null>(null);
const loading = signal(false);

export function useUser() {
  return { user, loading };
}

export default useUser;
`;
}

function generateGenericUseWishlist(): string {
  return `/**
 * Wishlist Hook — wire to invoke.site.loaders/actions for your platform.
 *
 * VTEX sites get a real factory from @decocms/apps/vtex/hooks/createUseWishlist;
 * see migration template hooks.ts for the canonical five-line shim.
 */
import { signal } from "~/sdk/signal";

const loading = signal(false);

export function useWishlist() {
  return {
    loading,
    async addItem(_productId: string, _productGroupId: string) {
      // TODO: Implement for your platform
    },
    async removeItem(_productId: string) {
      // TODO: Implement
    },
    getItem(_productId: string): boolean {
      return false;
    },
  };
}

export default useWishlist;
`;
}
