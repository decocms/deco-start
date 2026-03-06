/**
 * Built-in matchers matching deco-cx/apps website/matchers/*.
 *
 * These augment the matchers already handled inline in resolve.ts
 * (always, never, device, random, utm) with the additional matchers
 * that deco supported: cookie, cron, host, pathname, queryString.
 *
 * Register these at startup:
 *
 * @example
 * ```ts
 * import { registerBuiltinMatchers } from "@decocms/start/matchers/builtins";
 * registerBuiltinMatchers();
 * ```
 */

import type { MatcherContext } from "../cms/resolve";
import { registerMatcher } from "../cms/resolve";

// -------------------------------------------------------------------------
// Cookie matcher
// -------------------------------------------------------------------------

function cookieMatcher(
  rule: Record<string, unknown>,
  ctx: MatcherContext,
): boolean {
  const name = rule.name as string | undefined;
  const value = rule.value as string | undefined;
  if (!name) return false;

  const cookies = ctx.cookies ?? {};
  const cookieValue = cookies[name];

  if (cookieValue === undefined) return false;
  if (value === undefined) return true;
  return cookieValue === value;
}

// -------------------------------------------------------------------------
// Cron matcher
// -------------------------------------------------------------------------

function cronMatcher(
  rule: Record<string, unknown>,
  _ctx: MatcherContext,
): boolean {
  const start = rule.start as string | undefined;
  const end = rule.end as string | undefined;

  if (!start && !end) return true;

  const now = Date.now();

  if (start) {
    const startTime = new Date(start).getTime();
    if (isNaN(startTime) || now < startTime) return false;
  }

  if (end) {
    const endTime = new Date(end).getTime();
    if (isNaN(endTime) || now > endTime) return false;
  }

  return true;
}

// -------------------------------------------------------------------------
// Host matcher
// -------------------------------------------------------------------------

function hostMatcher(
  rule: Record<string, unknown>,
  ctx: MatcherContext,
): boolean {
  const hostToMatch = rule.host as string | undefined;
  if (!hostToMatch) return false;

  const currentUrl = ctx.url;
  if (!currentUrl) return false;

  try {
    const url = new URL(currentUrl);
    return url.hostname === hostToMatch || url.host === hostToMatch;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------
// Pathname matcher
// -------------------------------------------------------------------------

const MAX_PATTERN_LENGTH = 500;
const REDOS_HEURISTIC = /(\+|\*|\{[^}]*,\})\s*(\+|\*|\{[^}]*,\})/;

function isSafePattern(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  if (REDOS_HEURISTIC.test(pattern)) return false;
  return true;
}

function pathnameMatcher(
  rule: Record<string, unknown>,
  ctx: MatcherContext,
): boolean {
  const pattern = rule.pattern as string | undefined;
  const includes = rule.includes as string[] | undefined;
  const excludes = rule.excludes as string[] | undefined;

  const path = ctx.path ?? "";

  if (pattern) {
    if (!isSafePattern(pattern)) {
      console.warn(`[pathnameMatcher] Rejected potentially unsafe pattern: ${pattern.slice(0, 80)}`);
      return false;
    }
    try {
      const regex = new RegExp(pattern);
      if (!regex.test(path)) return false;
    } catch {
      return false;
    }
  }

  if (includes && includes.length > 0) {
    const matches = includes.some((inc) => {
      if (inc.includes("*")) {
        const prefix = inc.replace(/\*+$/, "");
        return path.startsWith(prefix);
      }
      return path === inc;
    });
    if (!matches) return false;
  }

  if (excludes && excludes.length > 0) {
    const excluded = excludes.some((exc) => {
      if (exc.includes("*")) {
        const prefix = exc.replace(/\*+$/, "");
        return path.startsWith(prefix);
      }
      return path === exc;
    });
    if (excluded) return false;
  }

  return true;
}

// -------------------------------------------------------------------------
// Query string matcher
// -------------------------------------------------------------------------

function queryStringMatcher(
  rule: Record<string, unknown>,
  ctx: MatcherContext,
): boolean {
  const key = (rule.key ?? rule.param) as string | undefined;
  const value = rule.value as string | undefined;

  if (!key) return false;

  const currentUrl = ctx.url;
  if (!currentUrl) return false;

  try {
    const url = new URL(currentUrl);
    const paramValue = url.searchParams.get(key);

    if (paramValue === null) return false;
    if (value === undefined) return true;
    return paramValue === value;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------
// Registration
// -------------------------------------------------------------------------

/**
 * Register all built-in matchers with the CMS resolver.
 *
 * Call once during app setup (in setup.ts or similar).
 * These cover the matchers from deco-cx/apps that weren't
 * handled inline in resolve.ts.
 */
export function registerBuiltinMatchers(): void {
  registerMatcher("website/matchers/cookie.ts", cookieMatcher);
  registerMatcher("website/matchers/cron.ts", cronMatcher);
  registerMatcher("website/matchers/date.ts", cronMatcher);
  registerMatcher("website/matchers/host.ts", hostMatcher);
  registerMatcher("website/matchers/pathname.ts", pathnameMatcher);
  registerMatcher("website/matchers/queryString.ts", queryStringMatcher);
}
