import type { MigrationContext } from "../types.ts";

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
  return `import { useState, useEffect } from "react";
import { invoke } from "~/server/invoke";
import type { OrderForm, OrderFormItem } from "@decocms/apps/vtex/types";

export type { OrderForm, OrderFormItem };

let _orderForm: OrderForm | null = null;
let _loading = false;
let _initStarted = false;
let _initFailed = false;
const _listeners = new Set<() => void>();

function notify() {
  _listeners.forEach((fn) => fn());
}
function setOrderForm(of: OrderForm | null) {
  _orderForm = of;
  notify();
}
function setLoading(v: boolean) {
  _loading = v;
  notify();
}

function getOrderFormIdFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/checkout\\.vtex\\.com__orderFormId=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function setOrderFormIdCookie(id: string) {
  if (typeof document === "undefined") return;
  document.cookie = \`checkout.vtex.com__orderFormId=\${encodeURIComponent(id)}; path=/; max-age=\${7 * 24 * 3600}; SameSite=Lax\`;
}

async function ensureOrderForm(): Promise<string> {
  if (_orderForm?.orderFormId) return _orderForm.orderFormId;

  const existing = getOrderFormIdFromCookie();
  const of = await invoke.vtex.actions.getOrCreateCart({
    data: { orderFormId: existing || undefined },
  });
  setOrderForm(of);
  if (of?.orderFormId) setOrderFormIdCookie(of.orderFormId);
  return of.orderFormId;
}

export function itemToAnalyticsItem(item: OrderFormItem & { coupon?: string }, index: number) {
  return {
    item_id: item.productId,
    item_group_id: item.productId,
    item_name: item.name ?? item.skuName ?? "",
    item_variant: item.skuName,
    item_brand: item.additionalInfo?.brandName ?? "",
    price: (item.sellingPrice ?? item.price ?? 0) / 100,
    discount: Number(((item.listPrice - item.sellingPrice) / 100).toFixed(2)),
    quantity: item.quantity,
    coupon: item.coupon,
    affiliation: item.seller,
    index,
  };
}

export function resetCart() {
  _orderForm = null;
  _loading = false;
  _initStarted = false;
  _initFailed = false;
  notify();
}

export function useCart() {
  const [, forceRender] = useState(0);

  useEffect(() => {
    const listener = () => forceRender((n) => n + 1);
    _listeners.add(listener);

    if (!_orderForm && !_initStarted) {
      _initStarted = true;
      const ofId = getOrderFormIdFromCookie();
      setLoading(true);
      invoke.vtex.actions
        .getOrCreateCart({ data: { orderFormId: ofId || undefined } })
        .then((of: OrderForm) => {
          setOrderForm(of);
          if (of?.orderFormId) setOrderFormIdCookie(of.orderFormId);
        })
        .catch((err: unknown) => {
          console.error("[useCart] init failed:", err);
          if (!_orderForm) {
            _initFailed = true;
            notify();
          }
        })
        .finally(() => setLoading(false));
    }

    return () => {
      _listeners.delete(listener);
    };
  }, []);

  return {
    cart: {
      get value() { return _orderForm; },
      set value(v: OrderForm | null) { setOrderForm(v); },
    },

    loading: {
      get value() { return _loading; },
      set value(v: boolean) { setLoading(v); },
    },

    initFailed: {
      get value() { return _initFailed; },
    },

    addItem: async (params: { id: string; seller: string; quantity?: number }) => {
      setLoading(true);
      try {
        const ofId = await ensureOrderForm();
        const updated = await invoke.vtex.actions.addItemsToCart({
          data: {
            orderFormId: ofId,
            orderItems: [{ id: params.id, seller: params.seller, quantity: params.quantity ?? 1 }],
          },
        });
        setOrderForm(updated);
        if (updated?.orderFormId) setOrderFormIdCookie(updated.orderFormId);
      } catch (err) {
        console.error("[useCart] addItem failed:", err);
        throw err;
      } finally {
        setLoading(false);
      }
    },

    addItems: async (params: {
      orderItems: Array<{ id: string; seller: string; quantity: number }>;
    }) => {
      setLoading(true);
      try {
        const ofId = await ensureOrderForm();
        const updated = await invoke.vtex.actions.addItemsToCart({
          data: { orderFormId: ofId, orderItems: params.orderItems },
        });
        setOrderForm(updated);
        if (updated?.orderFormId) setOrderFormIdCookie(updated.orderFormId);
      } catch (err) {
        console.error("[useCart] addItems failed:", err);
        throw err;
      } finally {
        setLoading(false);
      }
    },

    updateItems: async (params: { orderItems: Array<{ index: number; quantity: number }> }) => {
      const ofId = _orderForm?.orderFormId || getOrderFormIdFromCookie();
      if (!ofId) return;
      setLoading(true);
      try {
        const updated = await invoke.vtex.actions.updateCartItems({
          data: { orderFormId: ofId, orderItems: params.orderItems },
        });
        setOrderForm(updated);
      } catch (err) {
        console.error("[useCart] updateItems failed:", err);
      } finally {
        setLoading(false);
      }
    },

    removeItem: async (index: number) => {
      const ofId = _orderForm?.orderFormId || getOrderFormIdFromCookie();
      if (!ofId) return;
      setLoading(true);
      try {
        const updated = await invoke.vtex.actions.updateCartItems({
          data: { orderFormId: ofId, orderItems: [{ index, quantity: 0 }] },
        });
        setOrderForm(updated);
      } catch (err) {
        console.error("[useCart] removeItem failed:", err);
      } finally {
        setLoading(false);
      }
    },

    addCouponsToCart: async ({ text }: { text: string }) => {
      const ofId = _orderForm?.orderFormId || getOrderFormIdFromCookie();
      if (!ofId) return;
      setLoading(true);
      try {
        const updated = await invoke.vtex.actions.addCouponToCart({
          data: { orderFormId: ofId, text },
        });
        setOrderForm(updated);
      } catch (err) {
        console.error("[useCart] addCoupon failed:", err);
      } finally {
        setLoading(false);
      }
    },

    sendAttachment: async (params: { attachment: string; body: Record<string, unknown> }) => {
      const ofId = _orderForm?.orderFormId || getOrderFormIdFromCookie();
      if (!ofId) return;
      setLoading(true);
      try {
        const updated = await invoke.vtex.actions.updateOrderFormAttachment({
          data: {
            orderFormId: ofId,
            attachment: params.attachment,
            body: params.body,
          },
        });
        setOrderForm(updated);
      } catch (err) {
        console.error("[useCart] sendAttachment failed:", err);
      } finally {
        setLoading(false);
      }
    },

    simulate: async (data: {
      items: Array<{ id: string; quantity: number; seller: string }>;
      postalCode: string;
      country: string;
    }) => {
      return await invoke.vtex.actions.simulateCart({
        data: {
          items: data.items.map((i) => ({
            id: i.id,
            quantity: i.quantity,
            seller: i.seller,
          })),
          postalCode: data.postalCode,
          country: data.country,
        },
      });
    },

    mapItemsToAnalyticsItems: (orderForm: OrderForm | null) => {
      return (orderForm?.items || []).map((item, index) => itemToAnalyticsItem(item, index));
    },
  };
}
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
