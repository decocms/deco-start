/**
 * Sticky matcher session layer — mirrors deco/blocks/matcher.ts.
 *
 * Persists matcher results in `deco_matcher_*` cookies (30 days) so A/B
 * variants stay consistent across page loads. Aggregates active flags into
 * `deco_segment` for analytics (OneDollarStats in apps-start).
 */

import { forwardResponseCookies } from "../sdk/cookiePassthrough";
import { type Cookie, setResponseCookie } from "../sdk/cookie";
import { RequestContext } from "../sdk/requestContext";

export const DECO_MATCHER_PREFIX = "deco_matcher_";
export const DECO_SEGMENT = "deco_segment";
export const DECO_MATCHER_HEADER_QS_OVERRIDE = "x-deco-matchers-override";

const MATCHER_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days
const SEPARATOR = "@";

export type ResolveChainEntry = { type: "prop" | "resolvable"; value: string };

export interface MatcherFlag {
  name: string;
  value: boolean;
  isSegment: boolean;
  sticky: boolean;
  cacheable?: boolean;
}

export interface MatcherStickyMeta {
  sticky?: "session";
  cacheable?: boolean;
  sessionKey?: (rule: Record<string, unknown>) => string | null;
}

/** Built-in matcher modules that declare sticky/cacheable at the module level. */
export const MATCHER_MODULE_META: Record<string, MatcherStickyMeta> = {
  "website/matchers/random.ts": {
    sticky: "session",
    cacheable: true,
    sessionKey: (rule) =>
      typeof rule.traffic === "number" ? String(rule.traffic) : "0.5",
  },
};

const charByType = { resolvable: "@", prop: "." } as const;

/** Minimal MurmurHash3 32-bit — matches deco/blocks/matcher.ts cookie naming. */
class MurmurHash3 {
  private h = 0;

  hash(str: string): void {
    for (let i = 0; i < str.length; i++) {
      this.h = Math.imul(this.h ^ str.charCodeAt(i), 3432918353);
      this.h = (this.h << 13) | (this.h >>> 19);
      this.h = Math.imul(this.h, 461845907);
    }
  }

  result(): number {
    this.h ^= this.h >>> 16;
    this.h = Math.imul(this.h, 2246822507);
    this.h ^= this.h >>> 13;
    this.h = Math.imul(this.h, 3266489909);
    this.h ^= this.h >>> 16;
    return this.h >>> 0;
  }
}

export const cookieValue = {
  build: (id: string, result: boolean) =>
    `${btoa(id)}${SEPARATOR}${result ? 1 : 0}`,
  boolean: (str: string): boolean | undefined => {
    const parts = (str ?? "").split(SEPARATOR);
    if (parts.length < 2) return undefined;
    return parts[1] === "1";
  },
};

/** Build the stable matcher id from a resolve chain (deco parity). */
export function buildUniqueId(chain: ResolveChainEntry[]): {
  uniqueId: string;
  isSegment: boolean;
} {
  let uniqueId = "";
  let isSegment = true;

  for (let i = chain.length - 1; i >= 0; i--) {
    const { type, value } = chain[i];
    if (type === "prop" || type === "resolvable") {
      uniqueId =
        `${value}${uniqueId.length > 0 ? charByType[type] : ""}` + uniqueId;
    }
    if (type === "resolvable") {
      isSegment = uniqueId === value;
      break;
    }
  }

  return { uniqueId, isSegment };
}

export function parseMatcherOverrides(
  request?: Request,
): Record<string, boolean> {
  if (!request) return {};

  const fromHeaders = (): Record<string, boolean> | undefined => {
    const val = request.headers.get(DECO_MATCHER_HEADER_QS_OVERRIDE);
    if (!val) return undefined;
    const values: Record<string, boolean> = {};
    for (const keyValue of val.split(" ")) {
      const [key, value] = keyValue.split("=");
      if (key) values[key] = value === "1";
    }
    return values;
  };

  const fromQS = (): Record<string, boolean> | undefined => {
    const url = new URL(request.url);
    if (!url.searchParams.has(DECO_MATCHER_HEADER_QS_OVERRIDE)) return undefined;
    const values: Record<string, boolean> = {};
    for (const val of url.searchParams.getAll(DECO_MATCHER_HEADER_QS_OVERRIDE)) {
      const [key, value] = val.split("=");
      if (key) values[key] = value === "1";
    }
    return values;
  };

  return fromHeaders() ?? fromQS() ?? {};
}

function getStickyMeta(
  resolveType: string,
  rule: Record<string, unknown>,
): MatcherStickyMeta | undefined {
  const moduleMeta = MATCHER_MODULE_META[resolveType];
  if (moduleMeta?.sticky === "session") return moduleMeta;
  if (rule.sticky === "session") {
    return {
      sticky: "session",
      cacheable: rule.cacheable === true,
      sessionKey: moduleMeta?.sessionKey,
    };
  }
  return undefined;
}

function buildCookieName(
  uniqueId: string,
  sessionKeySuffix: string,
): string {
  const h = new MurmurHash3();
  h.hash(uniqueId);
  return `${DECO_MATCHER_PREFIX}${h.result()}${sessionKeySuffix}`;
}

function appendSetCookie(cookie: Cookie): void {
  const headers = new Headers();
  setResponseCookie(headers, cookie);
  const serialized = headers.getSetCookie?.()?.[0];
  if (!serialized) return;

  forwardResponseCookies([serialized]);

  const ctx = RequestContext.current;
  if (ctx) {
    ctx.responseHeaders.append("set-cookie", serialized);
  }
}

/** Whether a cookie name is framework-managed (safe for edge cache). */
export function isFrameworkCookieName(name: string): boolean {
  return name.startsWith(DECO_MATCHER_PREFIX) || name === DECO_SEGMENT;
}

/**
 * Evaluate a matcher with optional sticky session persistence.
 * Returns the boolean match result and records a flag for deco_segment.
 */
export function evaluateWithStickiness(
  resolveType: string,
  rule: Record<string, unknown>,
  chain: ResolveChainEntry[],
  cookies: Record<string, string>,
  request: Request | undefined,
  runMatcher: () => boolean,
  flags: MatcherFlag[],
): boolean {
  const meta = getStickyMeta(resolveType, rule);
  const { uniqueId, isSegment } = buildUniqueId(chain);

  const overrides = parseMatcherOverrides(request);
  if (uniqueId && overrides[uniqueId] !== undefined) {
    const result = overrides[uniqueId];
    flags.push({
      name: uniqueId,
      value: result,
      isSegment,
      sticky: meta?.sticky === "session",
      cacheable: meta?.cacheable,
    });
    return result;
  }

  if (!meta || meta.sticky !== "session" || !uniqueId) {
    const result = runMatcher();
    flags.push({
      name: uniqueId || resolveType,
      value: result,
      isSegment,
      sticky: false,
      cacheable: meta?.cacheable,
    });
    return result;
  }

  const sessionKeySuffix = meta.sessionKey?.(rule)
    ? `_${meta.sessionKey(rule)}`
    : "";
  const cookieName = buildCookieName(uniqueId, sessionKeySuffix);
  const isMatchFromCookie = cookieValue.boolean(cookies[cookieName] ?? "");

  let result: boolean;
  if (isMatchFromCookie !== undefined) {
    result = isMatchFromCookie;
  } else {
    result = runMatcher();
    appendSetCookie({
      name: cookieName,
      value: cookieValue.build(uniqueId, result),
      path: "/",
      maxAge: MATCHER_COOKIE_MAX_AGE,
      sameSite: "Lax",
    });
  }

  flags.push({
    name: uniqueId,
    value: result,
    isSegment,
    sticky: true,
    cacheable: meta.cacheable,
  });

  return result;
}

interface DecoSegment {
  active?: string[];
  inactiveDrawn?: string[];
}

function parseDecoSegment(raw: string): DecoSegment {
  try {
    return JSON.parse(decodeURIComponent(raw)) as DecoSegment;
  } catch {
    try {
      return JSON.parse(raw) as DecoSegment;
    } catch {
      return {};
    }
  }
}

/**
 * Update `deco_segment` from collected matcher flags — mirrors
 * deco/runtime/middleware.ts segment aggregation.
 */
export function applyDecoSegmentCookie(
  requestCookies: Record<string, string>,
  flags: MatcherFlag[],
): void {
  if (flags.length === 0) return;

  const cookieSegment = parseDecoSegment(requestCookies[DECO_SEGMENT] ?? "");
  const active = new Set(cookieSegment.active ?? []);
  const inactiveDrawn = new Set(cookieSegment.inactiveDrawn ?? []);

  for (const flag of flags) {
    if (flag.isSegment && flag.sticky) {
      if (flag.value) {
        active.add(flag.name);
        inactiveDrawn.delete(flag.name);
      } else {
        active.delete(flag.name);
        inactiveDrawn.add(flag.name);
      }
    }
  }

  const hasFlags = active.size > 0 || inactiveDrawn.size > 0;
  if (!hasFlags) return;

  const newSegment = {
    active: [...active].sort(),
    inactiveDrawn: [...inactiveDrawn].sort(),
  };
  const value = JSON.stringify(newSegment);
  const prevRaw = requestCookies[DECO_SEGMENT] ?? "";
  const prevParsed = parseDecoSegment(prevRaw);
  const prevValue = JSON.stringify({
    active: [...(prevParsed.active ?? [])].sort(),
    inactiveDrawn: [...(prevParsed.inactiveDrawn ?? [])].sort(),
  });

  if (prevValue === value) return;

  appendSetCookie({
    name: DECO_SEGMENT,
    value: encodeURIComponent(value),
    path: "/",
    maxAge: MATCHER_COOKIE_MAX_AGE,
    sameSite: "Lax",
  });
}
