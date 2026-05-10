/**
 * Built-in matchers matching deco-cx/apps website/matchers/*.
 *
 * These augment the matchers already handled inline in resolve.ts
 * (always, never, device, random, utm) with the additional matchers
 * that deco supported: cookie, cron, host, pathname, queryString,
 * location, userAgent, environment, multi, negate.
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
import { evaluateMatcher, registerMatcher } from "../cms/resolve";
import { resolveCountryCode } from "./countryNames";

// -------------------------------------------------------------------------
// Cookie matcher
// -------------------------------------------------------------------------

function cookieMatcher(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
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

function cronMatcher(rule: Record<string, unknown>, _ctx: MatcherContext): boolean {
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

function hostMatcher(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
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

function pathnameMatcher(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
  const path = ctx.path ?? "";

  // CMS "case" format: { type: "Includes" | "Equals" | "Not Includes" | "Starts With", pathname: "/..." }
  const caseObj = rule.case as { type?: string; pathname?: string } | undefined;
  if (caseObj?.pathname) {
    switch (caseObj.type) {
      case "Equals":
        return path === caseObj.pathname;
      case "Not Includes":
        return !path.includes(caseObj.pathname);
      case "Starts With":
        return path.startsWith(caseObj.pathname);
      case "Includes":
      default:
        return path.includes(caseObj.pathname);
    }
  }

  // Standard format: pattern (regex), includes (exact/glob), excludes (exact/glob)
  const pattern = rule.pattern as string | undefined;
  const includes = rule.includes as string[] | undefined;
  const excludes = rule.excludes as string[] | undefined;

  if (pattern) {
    if (!isSafePattern(pattern)) {
      console.warn(
        `[pathnameMatcher] Rejected potentially unsafe pattern: ${pattern.slice(0, 80)}`,
      );
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

  // No constraints specified — vacuously true
  if (!pattern && !includes?.length && !excludes?.length) return false;

  return true;
}

// -------------------------------------------------------------------------
// Query string matcher
// -------------------------------------------------------------------------

function queryStringMatcher(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
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
// Location matcher
// -------------------------------------------------------------------------

interface LocationRule {
  country?: string;
  regionCode?: string;
  city?: string;
}

interface GeoData {
  country: string;
  regionCode: string;
  regionName: string;
  city: string;
}

/**
 * Extract geo data from the request context.
 * Priority: request.cf (Cloudflare Workers) > geo cookies > geo headers.
 */
function getGeoData(ctx: MatcherContext): GeoData {
  // 1. Cloudflare Workers: request.cf has authoritative geo data
  const req = ctx.request;
  if (req) {
    const cf = (req as any).cf as Record<string, unknown> | undefined;
    if (cf?.country) {
      return {
        country: (cf.country as string) ?? "",
        regionCode: (cf.regionCode as string) ?? (cf.region as string) ?? "",
        regionName: (cf.region as string) ?? "",
        city: (cf.city as string) ?? "",
      };
    }
  }

  // 2. Geo cookies (set by Cloudflare middleware on Fresh/Deno sites)
  const cookies = ctx.cookies ?? {};
  const cookieCountry = cookies.__cf_geo_country ? decodeURIComponent(cookies.__cf_geo_country) : "";
  if (cookieCountry) {
    return {
      country: cookieCountry,
      regionCode: cookies.__cf_geo_region_code ? decodeURIComponent(cookies.__cf_geo_region_code) : "",
      regionName: cookies.__cf_geo_region ? decodeURIComponent(cookies.__cf_geo_region) : "",
      city: cookies.__cf_geo_city ? decodeURIComponent(cookies.__cf_geo_city) : "",
    };
  }

  // 3. Fallback: standard geo headers (Vercel, etc.)
  const headers = ctx.headers ?? {};
  return {
    country: headers["cf-ipcountry"] ?? headers["x-vercel-ip-country"] ?? "",
    regionCode: headers["cf-region"] ?? headers["x-vercel-ip-country-region"] ?? "",
    regionName: "",
    city: "",
  };
}

function matchesLocationRule(
  loc: LocationRule,
  geo: GeoData,
): boolean {
  if (loc.country) {
    const code = resolveCountryCode(loc.country);
    if (code.toUpperCase() !== geo.country.toUpperCase()) return false;
  }
  if (loc.regionCode) {
    // Match against both the short code ("SP") and full name ("São Paulo")
    // so rules authored against either format continue working.
    const ruleVal = loc.regionCode.toLowerCase();
    if (geo.regionCode.toLowerCase() !== ruleVal && geo.regionName.toLowerCase() !== ruleVal) return false;
  }
  if (loc.city && loc.city.toLowerCase() !== geo.city.toLowerCase()) return false;
  return true;
}

function locationMatcher(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
  const geo = getGeoData(ctx);
  if (!geo.country) return !((rule.includeLocations as unknown[] | undefined)?.length);

  const includeLocations = rule.includeLocations as LocationRule[] | undefined;
  const excludeLocations = rule.excludeLocations as LocationRule[] | undefined;

  if (excludeLocations?.some((loc) => matchesLocationRule(loc, geo))) {
    return false;
  }
  if (includeLocations?.length) {
    return includeLocations.some((loc) => matchesLocationRule(loc, geo));
  }
  return true;
}

// -------------------------------------------------------------------------
// User Agent matcher
// -------------------------------------------------------------------------

function userAgentMatcher(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
  const ua = ctx.userAgent ?? "";
  const includes = rule.includes as string | undefined;
  const match = rule.match as string | undefined;

  if (includes && !ua.includes(includes)) return false;
  if (match) {
    if (!isSafePattern(match)) return false;
    try {
      if (!new RegExp(match, "i").test(ua)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// -------------------------------------------------------------------------
// Environment matcher
// -------------------------------------------------------------------------

function environmentMatcher(rule: Record<string, unknown>, _ctx: MatcherContext): boolean {
  const environment = rule.environment as string | undefined;
  if (!environment) return true;

  const isProd =
    typeof process !== "undefined" && process.env?.NODE_ENV === "production";

  if (environment === "production") return isProd;
  if (environment === "development") return !isProd;
  return false;
}

// -------------------------------------------------------------------------
// Multi matcher (AND/OR combinator)
// -------------------------------------------------------------------------

function multiMatcher(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
  const op = (rule.op as string) ?? "and";
  const matchers = rule.matchers as Array<Record<string, unknown>> | undefined;

  if (!matchers?.length) return true;

  const results = matchers.map((m) => evaluateMatcher(m, ctx));
  return op === "or" ? results.some(Boolean) : results.every(Boolean);
}

// -------------------------------------------------------------------------
// Negate matcher
// -------------------------------------------------------------------------

function negateMatcher(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
  const matcher = rule.matcher as Record<string, unknown> | undefined;
  if (!matcher) return false;
  return !evaluateMatcher(matcher, ctx);
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
  registerMatcher("website/matchers/location.ts", locationMatcher);
  registerMatcher("website/matchers/userAgent.ts", userAgentMatcher);
  registerMatcher("website/matchers/environment.ts", environmentMatcher);
  registerMatcher("website/matchers/multi.ts", multiMatcher);
  registerMatcher("website/matchers/negate.ts", negateMatcher);
}
