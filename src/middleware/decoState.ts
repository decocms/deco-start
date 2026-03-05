/**
 * Per-request Deco state that the middleware pipeline builds up
 * and passes through the request lifecycle.
 */
import { createServerTimings, type ServerTimings } from "../sdk/serverTimings";
import type { Flag } from "../types/index";

export interface DecoState {
  /** Site name / identifier. */
  site: string;
  /** Per-request Server-Timing tracker. */
  timings: ServerTimings;
  /** Active feature flags for this request. */
  flags: Flag[];
  /** Whether the request is from a deco admin origin. */
  isAdmin: boolean;
  /** Whether debug mode is enabled (via `?__d=true` or admin). */
  debug: boolean;
  /** Start time of the request (ms). */
  startedAt: number;
}

export function buildDecoState(request: Request, site?: string): DecoState {
  const url = new URL(request.url);
  const origin = request.headers.get("origin") || request.headers.get("referer") || "";

  const ADMIN_ORIGINS = [
    "https://admin.deco.cx",
    "https://v0-admin.deco.cx",
    "https://play.deco.cx",
    "https://admin-cx.deco.page",
    "https://deco.chat",
    "https://admin.decocms.com",
    "https://decocms.com",
  ];

  const isAdmin =
    origin.includes("localhost") ||
    origin.includes("127.0.0.1") ||
    ADMIN_ORIGINS.some((d) => origin.startsWith(d));

  const debug = url.searchParams.has("__d") || isAdmin;

  return {
    site: site || process.env.DECO_SITE || "storefront",
    timings: createServerTimings(),
    flags: [],
    isAdmin,
    debug,
    startedAt: performance.now(),
  };
}
