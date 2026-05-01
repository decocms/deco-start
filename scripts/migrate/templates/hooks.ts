import type { MigrationContext } from "../types";

export function generateHooks(ctx: MigrationContext): Record<string, string> {
  const files: Record<string, string> = {};

  if (ctx.platform === "vtex") {
    files["src/hooks/useCart.ts"] = generateVtexUseCart();
  } else {
    files["src/hooks/useCart.ts"] = generateGenericUseCart();
  }

  files["src/hooks/useUser.ts"] = generateUseUser();
  files["src/hooks/useWishlist.ts"] = generateUseWishlist();

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

function generateUseUser(): string {
  return `/**
 * User Hook — wire to invoke.site.loaders for your platform's user API.
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

function generateUseWishlist(): string {
  return `/**
 * Wishlist Hook — wire to invoke.site.loaders/actions for your platform.
 *
 * For VTEX: use invoke.site.loaders.getWishlistItems and
 *           invoke.site.actions.addWishlistItem / removeWishlistItem.
 */
import { signal } from "~/sdk/signal";

const loading = signal(false);

export function useWishlist() {
  return {
    loading,
    async addItem(_productId: string, _productGroupId: string) {
      // TODO: Implement
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
