/**
 * Server-side device detection via RequestContext.
 *
 * @example
 * ```tsx
 * // In a section loader or server function:
 * import { detectDevice } from "@decocms/start/sdk/useDevice";
 *
 * export function loader(props: Props, req: Request) {
 *   const device = detectDevice(req.headers.get("user-agent") ?? "");
 *   return { ...props, device };
 * }
 *
 * // Or via RequestContext (no request argument needed):
 * import { useDevice } from "@decocms/start/sdk/useDevice";
 *
 * export function loader(props: Props) {
 *   const device = useDevice();
 *   return { ...props, isMobile: device === "mobile" };
 * }
 * ```
 */

import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
} from "react";
import { RequestContext } from "./requestContext";

export type Device = "mobile" | "tablet" | "desktop";

/**
 * React context for the resolved device. Populated by `<DeviceProvider>` at
 * the top of the framework tree (DecoPageRenderer mounts it for sites that
 * use the standard wiring). Once set, `useDevice()` reads from here in
 * preference to `AsyncLocalStorage`, which is known to be unreliable across
 * streaming SSR Suspense boundaries on Cloudflare Workers.
 */
export const DeviceContext = createContext<Device | null>(null);

// Android phones include "Mobile" in their UA; Android tablets do not.
// Check TABLET_RE first so `android(?!.*mobile)` captures tablets before
// the MOBILE_RE `android.*mobile` branch matches phones.
export const MOBILE_RE = /mobile|android.*mobile|iphone|ipod|webos|blackberry|opera mini|iemobile/i;
export const TABLET_RE = /ipad|tablet|kindle|silk|playbook|android(?!.*mobile)/i;

/**
 * Simple mobile-or-not check (mobile + tablet = true).
 * Use this for cache key splitting or any context where you
 * only need a mobile/desktop binary decision.
 */
export function isMobileUA(userAgent: string): boolean {
  return MOBILE_RE.test(userAgent) || TABLET_RE.test(userAgent);
}

/**
 * Detect device type from a User-Agent string.
 * Pure function — no side effects, works anywhere.
 */
export function detectDevice(userAgent: string): Device {
  if (TABLET_RE.test(userAgent)) return "tablet";
  if (MOBILE_RE.test(userAgent)) return "mobile";
  return "desktop";
}

/**
 * Get the current device type. Works everywhere:
 * - Server (loader, middleware, server function): reads User-Agent from RequestContext.
 * - Client (component, event handler): uses `window.innerWidth` breakpoints.
 *
 * @example
 * ```tsx
 * import { useDevice } from "@decocms/start/sdk/useDevice";
 *
 * // In a component:
 * const device = useDevice(); // "mobile" | "tablet" | "desktop"
 *
 * // In a loader:
 * export function loader(props: Props) {
 *   const device = useDevice();
 *   return { ...props, isMobile: device === "mobile" };
 * }
 * ```
 */
function resolveDeviceFromRuntime(): Device {
  // Server: use RequestContext UA header
  if (typeof document === "undefined") {
    const ctx = RequestContext.current;
    if (!ctx) return "desktop";
    const ua = ctx.request.headers.get("user-agent") ?? "";
    return detectDevice(ua);
  }
  // Client: use navigator.userAgent for consistency with server-side UA detection.
  // Using viewport width would produce different results between SSR and
  // hydration (server sees UA, client sees pixels), causing hydration mismatch.
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return detectDevice(ua);
}

export function useDevice(): Device {
  // Prefer the value resolved by <DeviceProvider> at the framework root —
  // safe across streaming-SSR Suspense boundaries where AsyncLocalStorage
  // can lose the request context. The try/catch keeps backward compat with
  // callers outside a React render (loaders, server functions, tests
  // without the framework root), where useContext throws "Invalid hook
  // call" — those callers fall through to the original runtime resolution.
  try {
    const fromContext = useContext(DeviceContext);
    if (fromContext) return fromContext;
  } catch {
    // Not in a React render — fall through.
  }
  return resolveDeviceFromRuntime();
}

/**
 * Wraps children in a `DeviceContext` populated by resolving the device once
 * here, at a point in the React tree where `AsyncLocalStorage` is reliable.
 * Any descendant calling `useDevice()` reads from this context instead of
 * re-resolving through ALS — preventing the "wrong device value cached at
 * the edge" failure mode that produces React #418 hydration mismatches.
 *
 * Mount this near the top of the React tree. `DecoPageRenderer` already
 * mounts it automatically; sites with custom roots can mount it explicitly:
 *
 * @example
 * ```tsx
 * <DeviceProvider>
 *   <App />
 * </DeviceProvider>
 * ```
 *
 * Pass an explicit `value` to override detection (useful for tests or
 * admin preview where the runtime UA isn't meaningful).
 */
export function DeviceProvider(
  props: { children: ReactNode; value?: Device },
): ReactNode {
  const device = props.value ?? resolveDeviceFromRuntime();
  return createElement(
    DeviceContext.Provider,
    { value: device },
    props.children,
  );
}

/**
 * Check if the current request is from a mobile device.
 */
export function checkMobile(): boolean {
  const ctx = RequestContext.current;
  if (!ctx) return false;
  return detectDevice(ctx.request.headers.get("user-agent") ?? "") === "mobile";
}

/**
 * Check if the current request is from a tablet device.
 */
export function checkTablet(): boolean {
  const ctx = RequestContext.current;
  if (!ctx) return false;
  return detectDevice(ctx.request.headers.get("user-agent") ?? "") === "tablet";
}

/**
 * Check if the current request is from a desktop device.
 */
export function checkDesktop(): boolean {
  const ctx = RequestContext.current;
  if (!ctx) return true;
  return detectDevice(ctx.request.headers.get("user-agent") ?? "") === "desktop";
}

