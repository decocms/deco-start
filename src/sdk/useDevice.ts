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

import { RequestContext } from "./requestContext";

export type Device = "mobile" | "tablet" | "desktop";

// Android phones include "Mobile" in their UA; Android tablets do not.
// Check TABLET_RE first so `android(?!.*mobile)` captures tablets before
// the MOBILE_RE `android.*mobile` branch matches phones.
const MOBILE_RE = /mobile|android.*mobile|iphone|ipod|webos|blackberry|opera mini|iemobile/i;
const TABLET_RE = /ipad|tablet|kindle|silk|playbook|android(?!.*mobile)/i;

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
 * Get the current device type via RequestContext.
 *
 * Must be called within a `RequestContext.run()` scope (i.e., during
 * request handling). Falls back to "desktop" outside request scope.
 */
export function useDevice(): Device {
  const ctx = RequestContext.current;
  if (!ctx) return "desktop";
  const ua = ctx.request.headers.get("user-agent") ?? "";
  return detectDevice(ua);
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
