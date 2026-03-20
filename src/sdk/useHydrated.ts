/**
 * Re-export of TanStack Router's `useHydrated` hook.
 *
 * Returns `false` during SSR and on the first client render (before hydration),
 * then `true` for all subsequent renders. Use this instead of
 * `typeof document === "undefined"` checks for conditional rendering.
 *
 * @example
 * ```tsx
 * import { useHydrated } from "@decocms/start/sdk/useHydrated";
 *
 * function CartButton() {
 *   const hydrated = useHydrated();
 *   if (!hydrated) return <CartSkeleton />;
 *   return <InteractiveCart />;
 * }
 * ```
 */
export { useHydrated } from "@tanstack/react-router";
