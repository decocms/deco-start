# Matchers: Architecture & Migration

## Part 1: Architecture

Internal documentation for the matcher system in `@decocms/start` + `deco-cx/apps`.

### When to Use This Reference

- Creating a new custom matcher (server-side or client-side)
- Debugging A/B tests or flags not activating
- Fixing CLS caused by unregistered/unknown matchers
- Understanding how flags evaluate variants (first-match wins)
- Implementing geo-targeted content with Cloudflare Workers
- Adding location, device, or session-based content variants

---

### What Is a Matcher?

A **matcher** is a serializable function registered in the CMS that evaluates boolean conditions about the current HTTP request. Matchers power:

1. **A/B testing** — show Variant A to 50% of users, Variant B to the rest
2. **Feature flags** — enable features by device, region, cookie, or query param
3. **Personalization** — different content per location, session, or user segment

In the CMS JSON (decofile), a matcher looks like:

```json
{
  "__resolveType": "website/flags/multivariate.ts",
  "variants": [
    {
      "rule": { "__resolveType": "website/matchers/device.ts", "mobile": true },
      "value": { "__resolveType": "site/sections/HeroMobile.tsx" }
    },
    {
      "rule": null,
      "value": { "__resolveType": "site/sections/HeroDesktop.tsx" }
    }
  ]
}
```

The `rule` is evaluated server-side during page resolution. **First variant that matches wins.**

---

### Architecture Overview

```
Request
  └─ resolveDecoPage()
       └─ For each multivariate flag:
            └─ evaluateMatcher(rule, matcherCtx)
                 ├─ Inline matchers: always, never, device, random, date
                 ├─ Custom registry: registerMatcher(key, fn)  ← setup.ts
                 └─ Unknown key → returns false + console.warn  ← CLS risk!
```

**Critical insight**: Unknown matchers return `false`. If `website/matchers/location.ts` is not registered, ALL location-based variants default to `false`, causing every user to see the "no match" variant — which can trigger React Reconnect events and severe CLS.

---

### MatcherContext

Defined in `@decocms/start/src/cms/resolve.ts`:

```typescript
export interface MatcherContext {
  userAgent?: string;                    // User-Agent header value
  url?: string;                          // Full URL with query string
  path?: string;                         // URL pathname only
  cookies?: Record<string, string>;      // Parsed cookies (key → value)
  headers?: Record<string, string>;      // All request headers
  request?: Request;                     // Raw Request object
}
```

**Important**: `cookies` is the most reliable field for custom matchers. The `request` object is not always populated by `cmsRoute.ts`. When injecting data from Cloudflare Workers, use the **cookie injection pattern** (see custom-matcher-guide.md).

---

### Evaluation Engine: `evaluateMatcher()`

Located in `@decocms/start/src/cms/resolve.ts`:

1. If no rule → returns `true` (default variant, always matches)
2. Extracts `__resolveType` from the rule object
3. **Inline matchers** (hardcoded switch): `always`, `never`, `device`, `random`, `date`
4. **Named block references**: recursively resolves the block, then evaluates
5. **Custom registry** (`G.__deco.customMatchers`): looks up `customMatchers[resolveType]` and calls it
6. **Unknown type**: returns `false` + logs a `console.warn`

```typescript
// Pseudo-code of evaluateMatcher:
function evaluateMatcher(rule, ctx) {
  if (!rule) return true; // no rule = default
  const type = rule.__resolveType;
  switch (type) {
    case "website/matchers/always.ts": return true;
    case "website/matchers/never.ts":  return false;
    case "website/matchers/device.ts": return evaluateDevice(rule, ctx);
    case "website/matchers/random.ts": return Math.random() < rule.traffic;
    case "website/matchers/date.ts":   return evaluateDate(rule);
    default:
      const fn = G.__deco.customMatchers[type];
      if (fn) return fn(rule, ctx);
      console.warn(`Unknown matcher: ${type}`); // → returns false!
      return false;
  }
}
```

---

### Registering Matchers: Setup

Call `registerBuiltinMatchers()` + any custom matchers in `src/setup.ts`, before the app serves requests:

```typescript
// src/setup.ts
import { registerBuiltinMatchers } from "@decocms/start/matchers/builtins";
import { registerLocationMatcher } from "./matchers/location";

registerBuiltinMatchers();    // registers cookie, cron, host, pathname, queryString
registerLocationMatcher();    // registers website/matchers/location.ts
```

**`registerMatcher(key, fn)` API:**

```typescript
import { registerMatcher } from "@decocms/start/cms";

registerMatcher("website/matchers/my-custom.ts", (rule, ctx) => {
  // rule: the CMS config object for this matcher
  // ctx: MatcherContext with { cookies, path, userAgent, url, headers }
  return Boolean(ctx.cookies?.["feature-flag"] === "enabled");
});
```

---

### Built-in Matchers Reference

| Matcher | Key | What it checks |
|---------|-----|----------------|
| Always | `website/matchers/always.ts` | Always `true` |
| Never | `website/matchers/never.ts` | Always `false` |
| Device | `website/matchers/device.ts` | Mobile/desktop detection via User-Agent |
| Random | `website/matchers/random.ts` | `Math.random() < traffic` (A/B split) |
| Date | `website/matchers/date.ts` | Current time within start/end window |
| Cookie | `website/matchers/cookie.ts` | Cookie name === value |
| Cron | `website/matchers/cron.ts` | Cron schedule window |
| Host | `website/matchers/host.ts` | Hostname matches |
| Pathname | `website/matchers/pathname.ts` | Path regex include/exclude lists |
| QueryString | `website/matchers/queryString.ts` | Query param (equals/greater/includes/exists) |
| Location | `website/matchers/location.ts` | Country, region, city (**needs registration!**) |
| UserAgent | `website/matchers/userAgent.ts` | User-Agent regex |
| Environment | `website/matchers/environment.ts` | Production vs development |
| Multi | `website/matchers/multi.ts` | AND/OR combinator of other matchers |
| Negate | `website/matchers/negate.ts` | Inverts another matcher result |
| PostHog | `posthog/matchers/featureFlag.ts` | PostHog feature flags |

### Device Matcher

```typescript
// Rule props:
{ mobile?: boolean; desktop?: boolean }

// Evaluates via User-Agent detection
// Example: show section only on mobile
{ "__resolveType": "website/matchers/device.ts", "mobile": true }
```

### Random Matcher (A/B Testing)

```typescript
// Rule props:
{ traffic: number; sticky?: "session" }

// traffic: 0.0 to 1.0 (e.g., 0.5 = 50%)
// sticky: "session" → stores result in cookie for 30 days (consistent UX)
{ "__resolveType": "website/matchers/random.ts", "traffic": 0.5, "sticky": "session" }
```

### Cookie Matcher

```typescript
// Rule props:
{ name: string; value: string }

// Checks if ctx.cookies[name] === value
{ "__resolveType": "website/matchers/cookie.ts", "name": "ab-test", "value": "variant-a" }
```

### Pathname Matcher

```typescript
// Rule props:
{ includePatterns?: string[]; excludePatterns?: string[] }

// Each pattern is a regex tested against ctx.path
{ "__resolveType": "website/matchers/pathname.ts", "includePatterns": ["^/categoria/"] }
```

### QueryString Matcher

```typescript
// Rule props:
{ name: string; value?: string; operator: "equals" | "greater" | "includes" | "exists" }

{ "__resolveType": "website/matchers/queryString.ts", "name": "preview", "operator": "exists" }
```

### Location Matcher (requires registration)

```typescript
// Rule props from deco-cx/apps:
interface LocationRule {
  includeLocations?: Array<{ country?: string; regionCode?: string; city?: string }>;
  excludeLocations?: Array<{ country?: string; regionCode?: string; city?: string }>;
}

// country: full country name (e.g., "Brasil", "Brazil")
// regionCode: full state/region name from Cloudflare (e.g., "São Paulo", "Paraná")
// city: city name (case-insensitive)
```

---

### Creating Custom Matchers

#### Pattern 1: Cookie-based (simplest)

```typescript
// src/matchers/preview-mode.ts
import { registerMatcher } from "@decocms/start/cms";

export function registerPreviewMatcher(): void {
  registerMatcher("website/matchers/preview-mode.ts", (rule, ctx) => {
    return ctx.cookies?.["preview"] === "true";
  });
}
```

#### Pattern 2: Header-based

```typescript
import { registerMatcher } from "@decocms/start/cms";

export function registerInternalMatcher(): void {
  registerMatcher("website/matchers/internal.ts", (rule, ctx) => {
    const ip = ctx.headers?.["cf-connecting-ip"] ?? "";
    const allowedIPs = (rule as { ips?: string[] }).ips ?? [];
    return allowedIPs.includes(ip);
  });
}
```

#### Pattern 3: Cloudflare Geo (server-side location)

This pattern solves the #1 CLS cause: `website/matchers/location.ts` returning `false` for all users because it isn't registered.

**Step 1**: Inject CF geo data as cookies in `worker-entry.ts`:

```typescript
// src/worker-entry.ts
function injectGeoCookies(request: Request): Request {
  const cf = (request as unknown as { cf?: Record<string, string> }).cf;
  if (!cf) return request;
  const parts: string[] = [];
  if (cf.region)  parts.push(`__cf_geo_region=${encodeURIComponent(cf.region)}`);
  if (cf.country) parts.push(`__cf_geo_country=${encodeURIComponent(cf.country)}`);
  if (cf.city)    parts.push(`__cf_geo_city=${encodeURIComponent(cf.city)}`);
  if (!parts.length) return request;
  const existing = request.headers.get("cookie") ?? "";
  const combined = existing ? `${existing}; ${parts.join("; ")}` : parts.join("; ");
  const headers = new Headers(request.headers);
  headers.set("cookie", combined);
  return new Request(request, { headers });
}

// In export default { fetch }:
return await handler.fetch(injectGeoCookies(request));
```

**Step 2**: Read cookies in the matcher (`src/matchers/location.ts`):

```typescript
import { registerMatcher } from "@decocms/start/cms";

// Cloudflare cf.country gives ISO code (e.g., "BR")
// CMS stores full names (e.g., "Brasil") — need mapping
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  Brasil: "BR", Brazil: "BR",
  Argentina: "AR", Chile: "CL",
  Colombia: "CO", Mexico: "MX",
  Peru: "PE", Uruguay: "UY",
  "United States": "US", USA: "US",
};

interface LocationRule {
  country?: string;
  regionCode?: string;
  city?: string;
}

function matchesRule(loc: LocationRule, region: string, country: string, city: string): boolean {
  if (loc.country) {
    const code = COUNTRY_NAME_TO_CODE[loc.country] ?? loc.country;
    if (code !== country) return false;
  }
  if (loc.regionCode && loc.regionCode !== region) return false;
  if (loc.city && loc.city.toLowerCase() !== city.toLowerCase()) return false;
  return true;
}

export function registerLocationMatcher(): void {
  registerMatcher("website/matchers/location.ts", (rule, ctx) => {
    const cookies = ctx.cookies ?? {};
    const region  = cookies.__cf_geo_region  ? decodeURIComponent(cookies.__cf_geo_region)  : "";
    const country = cookies.__cf_geo_country ? decodeURIComponent(cookies.__cf_geo_country) : "";
    const city    = cookies.__cf_geo_city    ? decodeURIComponent(cookies.__cf_geo_city)    : "";

    const r = rule as { includeLocations?: LocationRule[]; excludeLocations?: LocationRule[] };

    if (r.excludeLocations?.some(loc => matchesRule(loc, region, country, city))) return false;
    if (r.includeLocations?.length) {
      return r.includeLocations.some(loc => matchesRule(loc, region, country, city));
    }
    return true;
  });
}
```

**Step 3**: Register in `src/setup.ts`:

```typescript
import { registerBuiltinMatchers } from "@decocms/start/matchers/builtins";
import { registerLocationMatcher } from "./matchers/location";

registerBuiltinMatchers();
registerLocationMatcher();
```

---

### Flags & Variants: How Resolution Works

```
resolveDecoPage()
  └─ resolveVariants() for each multivariate block
       └─ for (const variant of variants):
            if (evaluateMatcher(variant.rule, matcherCtx)):
              return variant.value  // FIRST MATCH WINS, stops here
       └─ return undefined (no match — section not rendered)
```

**Variant ordering rules:**
- More specific rules go first (e.g., device + location combined)
- Default/fallback variant goes last with `rule: null`
- If NO variant matches (all rules `false`, no `null` rule), the entire section is omitted

**Session stickiness** (Random matcher):
- `sticky: "session"` stores the matched variant in a cookie (`deco_sticky_<hash>`)
- Cookie expires in 30 days
- Ensures the same user always sees the same variant

---

### Debugging Matchers

#### Check if matcher is registered

Look for console warnings at startup:
```
[deco] Unknown matcher: website/matchers/location.ts
```

#### Diagnose from Chrome Trace

- Open `chrome://tracing` and load a recorded trace
- Look for **"React Reconnect"** events — each one = a subtree remount
- 10+ reconnects on the same page → likely an unregistered matcher causing all variants to resolve to `false`, then the client re-renders when JS loads and re-evaluates

#### Force a variant via query string

Use `?__deco_matcher_override[key]=true` (if supported by the framework version) to test specific variants without real traffic.

#### Verify Cloudflare geo data

Add a debug endpoint or check cookies in DevTools:
- `__cf_geo_country` → e.g., `BR`
- `__cf_geo_region` → e.g., `S%C3%A3o%20Paulo` (URL-encoded "São Paulo")
- `__cf_geo_city` → e.g., `Curitiba`

---

### Common Pitfalls

| Problem | Root cause | Fix |
|---------|-----------|-----|
| All location variants show wrong content | `location.ts` not registered → always `false` | Register in `setup.ts` |
| CLS score spike + React Reconnect events | Unregistered matcher → server renders variant A, client re-renders variant B | Register all matchers used in CMS |
| Random A/B test inconsistent per page load | Not using `sticky: "session"` | Add `"sticky": "session"` to rule |
| Geo matcher works locally but not in production | CF geo data not available in local dev | Mock `__cf_geo_*` cookies locally |
| Pathname matcher regex syntax error | REDOS vulnerability check rejects pattern | Simplify regex, avoid catastrophic backtracking |
| `request` undefined in MatcherContext | `cmsRoute.ts` doesn't populate it | Use `ctx.cookies` or `ctx.headers` instead |

---

### Key Source Files

| File | Location |
|------|----------|
| `evaluateMatcher`, `registerMatcher`, `MatcherContext` | `@decocms/start/src/cms/resolve.ts` |
| `registerBuiltinMatchers` | `@decocms/start/src/matchers/builtins.ts` |
| Built-in matcher implementations | `deco-cx/apps/website/matchers/*.ts` |
| PostHog matcher | `@decocms/start/src/matchers/posthog.ts` |
| Example: server-side location matcher | `src/matchers/location.ts` |
| Example: CF geo cookie injection | `src/worker-entry.ts` → `injectGeoCookies()` |
| Matcher registration call site | `src/setup.ts` |

---

## Part 2: Migration Guide

Complete guide to migrate ALL matcher types from Fresh/Deno to TanStack Start / Cloudflare Workers.

### When to Use This Reference

- Migrating a deco site from Fresh/Deno to TanStack Start
- Setting up matchers in a new TanStack storefront
- A/B tests or feature flags stopped working after migration
- Location matcher returns `false` for everyone (most common post-migration bug)
- Need to implement a matcher that isn't in `registerBuiltinMatchers()`

---

### Key Architecture Differences

| Aspect | Fresh/Deno | TanStack Start |
|--------|-----------|----------------|
| Context type | `MatchContext` | `MatcherContext` |
| Request access | `ctx.request: Request` | `ctx.request?` (unreliable, often undefined) |
| CF geo data | Read directly from CF headers | Inject as cookies in `worker-entry.ts` |
| CF headers available | `cf-ipcountry`, `cf-ipcity`, `cf-region-code` | Not in `MatcherContext`, inject via cookies |
| Device detection | `ctx.device: "mobile"\|"tablet"\|"desktop"` | Parse from `ctx.userAgent` (string) |
| Environment check | `Deno.env.get("DENO_DEPLOYMENT_ID")` | `process.env.NODE_ENV` or `ctx.headers` |
| Cron parsing | `https://deno.land/x/croner@6.0.3` | Inline date-range check (no cron lib) |
| Registration | Automatic via block manifest | Must call `registerMatcher(key, fn)` in setup.ts |
| Builtins | Included by default | Must call `registerBuiltinMatchers()` in setup.ts |
| MatchContext fields | `{ request, device, siteId }` | `{ userAgent, url, path, cookies, headers, request? }` |

---

### MatcherContext Interface (TanStack Start)

```typescript
// @decocms/start/src/cms/resolve.ts
export interface MatcherContext {
  userAgent?: string;                    // User-Agent header value
  url?: string;                          // Full URL with query string (e.g. "https://site.com/path?q=1")
  path?: string;                         // Pathname only (e.g. "/path")
  cookies?: Record<string, string>;      // Parsed cookies
  headers?: Record<string, string>;      // All request headers
  request?: Request;                     // Raw Request (not always populated!)
}
```

---

### Migration Status per Matcher

| Matcher | In `registerBuiltinMatchers()`? | Migration needed? | Notes |
|---------|--------------------------------|-------------------|-------|
| `always.ts` | No (inline) | No | Hardcoded in `evaluateMatcher` |
| `never.ts` | No (inline) | No | Hardcoded in `evaluateMatcher` |
| `device.ts` | No (inline) | No | Hardcoded, uses `ctx.userAgent` |
| `random.ts` | No (inline) | No | Hardcoded |
| `date.ts` | Yes (as cron alias) | No | Registered in builtins |
| `cron.ts` | Yes | No | Registered in builtins |
| `cookie.ts` | Yes | No | Registered in builtins |
| `host.ts` | Yes | No | Registered in builtins |
| `pathname.ts` | Yes | Partial | Props shape changed (see below) |
| `queryString.ts` | Yes | Partial | Props shape changed (see below) |
| `location.ts` | **No** | **YES** | Biggest CLS risk — see full guide |
| `userAgent.ts` | **No** | **YES** | Must register manually |
| `environment.ts` | **No** | **YES** | Deno API → Node/CF equivalent |
| `multi.ts` | **No** | **YES** | Must register manually |
| `negate.ts` | **No** | **YES** | Must register manually |
| `site.ts` | **No** | **Not needed** | Site-specific, skip or skip if unused |
| PostHog | Yes (posthog.ts) | Partial | Needs adapter config |

---

### Step 1: Setup File

All matchers must be registered before any request is served:

```typescript
// src/setup.ts
import { registerBuiltinMatchers } from "@decocms/start/matchers/builtins";
import { registerLocationMatcher } from "./matchers/location";
import { registerUserAgentMatcher } from "./matchers/userAgent";
import { registerEnvironmentMatcher } from "./matchers/environment";
import { registerMultiMatcher } from "./matchers/multi";
import { registerNegateMatcher } from "./matchers/negate";

// Always call this first — registers cookie, cron/date, host, pathname, queryString
registerBuiltinMatchers();

// Register any matchers used in CMS that aren't in builtins:
registerLocationMatcher();
registerUserAgentMatcher();
registerEnvironmentMatcher();
registerMultiMatcher();
registerNegateMatcher();
```

**Critical**: If any matcher used in the CMS is not registered, `evaluateMatcher` returns `false` + logs a warning. This causes ALL variants using that matcher to show the wrong content and can trigger React Reconnect events (CLS).

---

### Step 2: Cloudflare Geo Cookie Injection

The Fresh version of `location.ts` reads CF headers directly from `ctx.request`. In TanStack Start, `MatcherContext` doesn't expose headers reliably — inject CF geo data as cookies in `worker-entry.ts` **before** TanStack Start processes the request.

```typescript
// src/worker-entry.ts
function injectGeoCookies(request: Request): Request {
  const cf = (request as unknown as { cf?: Record<string, string> }).cf;
  if (!cf) return request;
  const parts: string[] = [];
  if (cf.region)    parts.push(`__cf_geo_region=${encodeURIComponent(cf.region)}`);
  if (cf.country)   parts.push(`__cf_geo_country=${encodeURIComponent(cf.country)}`);
  if (cf.city)      parts.push(`__cf_geo_city=${encodeURIComponent(cf.city)}`);
  if (cf.latitude)  parts.push(`__cf_geo_lat=${encodeURIComponent(cf.latitude)}`);
  if (cf.longitude) parts.push(`__cf_geo_lng=${encodeURIComponent(cf.longitude)}`);
  if (!parts.length) return request;
  const existing = request.headers.get("cookie") ?? "";
  const combined = existing ? `${existing}; ${parts.join("; ")}` : parts.join("; ");
  const headers = new Headers(request.headers);
  headers.set("cookie", combined);
  return new Request(request, { headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return await handler.fetch(injectGeoCookies(request), env, ctx);
  }
};
```

**CF data available** (from `request.cf` in Cloudflare Workers):
- `cf.country` — ISO 2-letter code (`"BR"`, `"US"`)
- `cf.region` — Full state/region name (`"São Paulo"`, `"Paraná"`)
- `cf.city` — City name (`"Curitiba"`)
- `cf.latitude` — Decimal latitude
- `cf.longitude` — Decimal longitude
- `cf.regionCode` — Short region code (some regions) (`"SP"`)

> Note: Fresh used CF **headers** (`cf-ipcountry`, `cf-ipcity`, etc.). TanStack Start uses `request.cf` object injected as cookies. Both come from Cloudflare but via different mechanisms.

---

### Step 3: Implement Each Missing Matcher

#### `location.ts` — Geographic targeting

**Fresh behavior**: Reads `cf-ipcity`, `cf-ipcountry`, `cf-region-code`, lat/lng headers. Supports coordinate radius matching.

**TanStack behavior**: Reads from injected cookies `__cf_geo_*`. CMS stores country as full names ("Brasil"), CF provides ISO codes ("BR") — needs a mapping table.

```typescript
// src/matchers/location.ts
import { registerMatcher } from "@decocms/start/cms";

// CF country codes → CMS country name mapping
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  Brasil: "BR",     Brazil: "BR",
  Argentina: "AR",  Chile: "CL",
  Colombia: "CO",   Mexico: "MX",
  Peru: "PE",       Uruguay: "UY",
  Paraguay: "PY",   Bolivia: "BO",
  Ecuador: "EC",    Venezuela: "VE",
  "United States": "US", USA: "US",
  Spain: "ES",      Portugal: "PT",
};

interface LocationRule {
  country?: string;
  regionCode?: string;  // Full region name (e.g., "São Paulo", "Paraná")
  city?: string;
}

function matchesRule(
  loc: LocationRule,
  region: string,
  country: string,
  city: string
): boolean {
  if (loc.country) {
    const code = COUNTRY_NAME_TO_CODE[loc.country] ?? loc.country;
    if (code !== country) return false;
  }
  if (loc.regionCode && loc.regionCode !== region) return false;
  if (loc.city && loc.city.toLowerCase() !== city.toLowerCase()) return false;
  return true;
}

export function registerLocationMatcher(): void {
  registerMatcher("website/matchers/location.ts", (rule, ctx) => {
    const cookies = ctx.cookies ?? {};
    const region  = cookies.__cf_geo_region  ? decodeURIComponent(cookies.__cf_geo_region)  : "";
    const country = cookies.__cf_geo_country ? decodeURIComponent(cookies.__cf_geo_country) : "";
    const city    = cookies.__cf_geo_city    ? decodeURIComponent(cookies.__cf_geo_city)    : "";

    const r = rule as {
      includeLocations?: LocationRule[];
      excludeLocations?: LocationRule[];
    };

    // Exclude list takes priority
    if (r.excludeLocations?.some(loc => matchesRule(loc, region, country, city))) {
      return false;
    }
    // Include list: must match at least one
    if (r.includeLocations?.length) {
      return r.includeLocations.some(loc => matchesRule(loc, region, country, city));
    }
    // No rules = match all
    return true;
  });
}
```

> **Coordinate radius matching** (from Fresh): The Fresh version supports `Map { coordinates: "lat,lng,radius_m" }` using haversine distance. This is rare in practice — skip unless the CMS actually uses coordinate rules.

---

#### `userAgent.ts` — Browser/OS targeting

**Fresh behavior**: Reads `ctx.request.headers.get("user-agent")`. Supports `includes` (string) and `match` (regex).

**TanStack behavior**: Read from `ctx.userAgent`.

```typescript
// src/matchers/userAgent.ts
import { registerMatcher } from "@decocms/start/cms";

export function registerUserAgentMatcher(): void {
  registerMatcher("website/matchers/userAgent.ts", (rule, ctx) => {
    const ua = ctx.userAgent ?? "";
    const r = rule as { includes?: string; match?: string };

    if (r.includes && !ua.includes(r.includes)) return false;
    if (r.match) {
      try {
        if (!new RegExp(r.match, "i").test(ua)) return false;
      } catch {
        return false;
      }
    }
    return true;
  });
}
```

---

#### `environment.ts` — Production vs development

**Fresh behavior**: Checks `Deno.env.get("DENO_DEPLOYMENT_ID")`.

**TanStack behavior**: Check `process.env.NODE_ENV` or a custom env var. In Cloudflare Workers, use a binding or `ctx.headers`.

```typescript
// src/matchers/environment.ts
import { registerMatcher } from "@decocms/start/cms";

function isProduction(): boolean {
  // Cloudflare Workers: check for production deployment
  // Adjust based on how your site sets this
  if (typeof process !== "undefined" && process.env.NODE_ENV) {
    return process.env.NODE_ENV === "production";
  }
  // Fallback: check for a custom header or env var
  return false;
}

export function registerEnvironmentMatcher(): void {
  registerMatcher("website/matchers/environment.ts", (rule, ctx) => {
    const r = rule as { environment: "production" | "development" };
    const prod = isProduction();
    if (r.environment === "production") return prod;
    if (r.environment === "development") return !prod;
    return false;
  });
}
```

> Alternatively, inject an `__env` cookie in `worker-entry.ts` with the environment name.

---

#### `multi.ts` — AND/OR combinator

**Fresh behavior**: Recursively calls each `Matcher` function with `MatchContext`.

**TanStack behavior**: Must recursively call `evaluateMatcher` for each sub-matcher. Import it from the framework.

```typescript
// src/matchers/multi.ts
import { registerMatcher } from "@decocms/start/cms";
// Import the internal evaluateMatcher — check if exported by your version
// If not exported, implement inline evaluation

export function registerMultiMatcher(): void {
  registerMatcher("website/matchers/multi.ts", (rule, ctx) => {
    const r = rule as {
      op: "or" | "and";
      matchers: Array<Record<string, unknown>>;
    };

    if (!r.matchers?.length) return true;

    // Evaluate each sub-matcher rule using the same ctx
    // We need to call evaluateMatcher recursively — check your @decocms/start version
    // If evaluateMatcher is exported:
    // import { evaluateMatcher } from "@decocms/start/cms";
    // const results = r.matchers.map(m => evaluateMatcher(m, ctx));

    // Fallback: evaluate inline using registered matchers
    const G = globalThis as unknown as {
      __deco?: { customMatchers?: Record<string, (r: unknown, c: unknown) => boolean> }
    };
    const registry = G.__deco?.customMatchers ?? {};

    const results = r.matchers.map(m => {
      const subRule = m as Record<string, unknown>;
      const type = subRule.__resolveType as string | undefined;
      if (!type) return true;
      const fn = registry[type];
      if (!fn) return false;
      return fn(subRule, ctx);
    });

    return r.op === "and" ? results.every(Boolean) : results.some(Boolean);
  });
}
```

> Check your `@decocms/start` version — newer versions may export `evaluateMatcher` for reuse.

---

#### `negate.ts` — Invert any matcher

**Fresh behavior**: Calls inner `Matcher` function and inverts.

**TanStack behavior**: Same recursive evaluation as multi.

```typescript
// src/matchers/negate.ts
import { registerMatcher } from "@decocms/start/cms";

export function registerNegateMatcher(): void {
  registerMatcher("website/matchers/negate.ts", (rule, ctx) => {
    const r = rule as { matcher?: Record<string, unknown> };
    if (!r.matcher) return false;

    const G = globalThis as unknown as {
      __deco?: { customMatchers?: Record<string, (r: unknown, c: unknown) => boolean> }
    };
    const registry = G.__deco?.customMatchers ?? {};
    const type = r.matcher.__resolveType as string | undefined;
    if (!type) return false;
    const fn = registry[type];
    if (!fn) return false;
    return !fn(r.matcher, ctx);
  });
}
```

---

### Step 4: Props Shape Differences for Builtins

Even registered matchers have prop shape differences between Fresh and TanStack Start. Check CMS JSON against the TanStack implementation.

#### `pathname.ts` — Props changed

**Fresh Props**:
```typescript
{
  case: {
    type: "Equals" | "Includes" | "Template";
    pathname: string;
    negate?: boolean;
  }
}
```

**TanStack Props** (builtins.ts):
```typescript
{
  pattern?: string;       // Regex pattern
  includes?: string[];    // Exact paths or wildcard (path/* prefix)
  excludes?: string[];    // Exact paths or wildcard
}
```

**Migration**: The CMS JSON uses the Fresh props shape. The TanStack builtins handle a different (simpler) shape. If your CMS has the Fresh-style `case` object, the TanStack builtin won't match it — you must register a custom implementation matching the Fresh shape.

```typescript
// src/matchers/pathname-compat.ts — Fresh-compatible pathname matcher
import { registerMatcher } from "@decocms/start/cms";

function templateToRegex(template: string): RegExp {
  const pattern = template
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // escape
    .replace(/\\:\w+/g, '[^/]+')               // :slug → [^/]+
    .replace(/\\*/g, '.*');                    // * → .*
  return new RegExp(`^${pattern}$`);
}

export function registerPathnameCompatMatcher(): void {
  registerMatcher("website/matchers/pathname.ts", (rule, ctx) => {
    const r = rule as { case?: { type: string; pathname?: string; negate?: boolean } };
    const path = ctx.path ?? "";

    if (!r.case?.pathname) return true;
    const { type, pathname, negate } = r.case;

    let match = false;
    switch (type) {
      case "Equals":   match = path === pathname; break;
      case "Includes": match = path.includes(pathname); break;
      case "Template": match = templateToRegex(pathname).test(path); break;
      default: match = false;
    }

    return negate ? !match : match;
  });
}
```

> Only add this compatibility shim if your CMS actually uses the Fresh-style `case` object. Check your decofile JSON first.

#### `queryString.ts` — Props changed

**Fresh Props**:
```typescript
{
  conditions: Array<{
    param: string;
    case: {
      type: "Equals" | "Greater" | "Lesser" | "GreaterOrEquals" | "LesserOrEquals" | "Includes" | "Exists";
      value?: string;
    }
  }>
}
```

**TanStack Props** (builtins.ts):
```typescript
{
  key?: string;    // or "param"
  param?: string;  // query param name
  value?: string;  // optional value to match
}
```

If your CMS uses the `conditions` array shape, register a compatibility matcher:

```typescript
// src/matchers/querystring-compat.ts
import { registerMatcher } from "@decocms/start/cms";

export function registerQueryStringCompatMatcher(): void {
  registerMatcher("website/matchers/queryString.ts", (rule, ctx) => {
    const r = rule as { conditions?: Array<{ param: string; case: { type: string; value?: string } }> };
    if (!r.conditions?.length) return true;

    const url = ctx.url ? new URL(ctx.url) : null;
    if (!url) return false;

    return r.conditions.every(({ param, case: c }) => {
      const raw = url.searchParams.get(param);
      const val = raw ?? "";
      const cval = c.value ?? "";
      switch (c.type) {
        case "Exists":           return raw !== null;
        case "Equals":           return val === cval;
        case "Includes":         return val.includes(cval);
        case "Greater":          return Number(val) > Number(cval);
        case "Lesser":           return Number(val) < Number(cval);
        case "GreaterOrEquals":  return Number(val) >= Number(cval);
        case "LesserOrEquals":   return Number(val) <= Number(cval);
        default:                 return false;
      }
    });
  });
}
```

---

### Step 5: PostHog Matcher

The TanStack Start framework ships a PostHog bridge in `@decocms/start/src/matchers/posthog.ts`. Configure it with a server-side adapter:

```typescript
// src/setup.ts
import { registerMatcher } from "@decocms/start/cms";
import {
  configurePostHogMatcher,
  createPostHogMatcher,
  createServerPostHogAdapter,
} from "@decocms/start/matchers/posthog";
import { PostHog } from "posthog-node";

// Create a PostHog Node client (server-side)
const posthogClient = new PostHog(process.env.POSTHOG_API_KEY!, {
  host: "https://app.posthog.com",
});

export async function setupPostHogMatcher(distinctId: string): Promise<void> {
  const adapter = createServerPostHogAdapter(posthogClient, distinctId);
  configurePostHogMatcher(adapter);
  registerMatcher("posthog/matchers/featureFlag.ts", createPostHogMatcher());
}
```

---

### Complete `src/setup.ts` Example

```typescript
// src/setup.ts — register ALL matchers before serving requests
import { setAsyncRenderingConfig } from "@decocms/start/async-rendering";
import { registerBuiltinMatchers } from "@decocms/start/matchers/builtins";
import { registerLocationMatcher } from "./matchers/location";
import { registerUserAgentMatcher } from "./matchers/userAgent";
import { registerEnvironmentMatcher } from "./matchers/environment";
import { registerMultiMatcher } from "./matchers/multi";
import { registerNegateMatcher } from "./matchers/negate";

// Register all built-in matchers (cookie, cron/date, host, pathname, queryString)
registerBuiltinMatchers();

// Register matchers not in builtins — add only those used in your CMS
registerLocationMatcher();    // Critical if CMS uses location-based content
registerUserAgentMatcher();   // If CMS uses userAgent rules
registerEnvironmentMatcher(); // If CMS uses production/development flags
registerMultiMatcher();       // If CMS uses AND/OR combinator rules
registerNegateMatcher();      // If CMS uses negated matcher rules

// Async rendering config
setAsyncRenderingConfig({
  respectCmsLazy: true,
  alwaysEager: ["Header", "Footer", "Theme"],
});
```

---

### Complete `src/worker-entry.ts` Example

```typescript
// src/worker-entry.ts — inject CF geo data before TanStack Start processes request
import { createWorkerEntry } from "@decocms/start";
import "../src/setup"; // Ensure matchers are registered

const handler = createWorkerEntry();

function injectGeoCookies(request: Request): Request {
  const cf = (request as unknown as { cf?: Record<string, string> }).cf;
  if (!cf) return request;
  const parts: string[] = [];
  if (cf.region)    parts.push(`__cf_geo_region=${encodeURIComponent(cf.region)}`);
  if (cf.country)   parts.push(`__cf_geo_country=${encodeURIComponent(cf.country)}`);
  if (cf.city)      parts.push(`__cf_geo_city=${encodeURIComponent(cf.city)}`);
  if (cf.latitude)  parts.push(`__cf_geo_lat=${encodeURIComponent(cf.latitude)}`);
  if (cf.longitude) parts.push(`__cf_geo_lng=${encodeURIComponent(cf.longitude)}`);
  if (!parts.length) return request;
  const existing = request.headers.get("cookie") ?? "";
  const combined = existing ? `${existing}; ${parts.join("; ")}` : parts.join("; ");
  const headers = new Headers(request.headers);
  headers.set("cookie", combined);
  return new Request(request, { headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return await handler.fetch(injectGeoCookies(request), env, ctx);
  }
};
```

---

### Debugging After Migration

#### 1. Check startup logs for unregistered matchers

```
console.warn: Unknown matcher type: website/matchers/location.ts
```

Every warning = one matcher returning `false` for all users = potential CLS.

#### 2. Check Chrome Trace for React Reconnect

- Record a trace at `chrome://tracing`
- Look for **"React Reconnect"** events — each = a React subtree that remounted
- Cause: server renders variant A (matcher returns false) → client JS evaluates differently → remounts
- Fix: register all matchers so server and client agree

#### 3. Verify CF geo cookies

Open DevTools → Application → Cookies:
- `__cf_geo_country` = `BR` (ISO code)
- `__cf_geo_region` = `S%C3%A3o%20Paulo` (URL-encoded "São Paulo")
- `__cf_geo_city` = `Curitiba`

If cookies are missing → `injectGeoCookies()` isn't running or CF isn't populating `request.cf` (only available in production Cloudflare Workers, not `wrangler dev`).

#### 4. Test locally with mock cookies

For local development, set mock geo cookies in `injectGeoCookies()` when `cf` is undefined:

```typescript
function injectGeoCookies(request: Request): Request {
  const cf = (request as unknown as { cf?: Record<string, string> }).cf;
  // In local dev, simulate a location
  const geoData = cf ?? {
    country: "BR",
    region: "Paraná",
    city: "Curitiba",
  };
  // ... rest of implementation
}
```

---

### Matcher Feature Parity Checklist

Use this checklist when migrating a site:

- [ ] `registerBuiltinMatchers()` called in `setup.ts`
- [ ] `injectGeoCookies()` added to `worker-entry.ts`
- [ ] `registerLocationMatcher()` added to `setup.ts` (if site uses location rules)
- [ ] `registerUserAgentMatcher()` added (if site uses userAgent rules)
- [ ] `registerEnvironmentMatcher()` added (if site uses env flags)
- [ ] `registerMultiMatcher()` added (if site uses AND/OR combinator)
- [ ] `registerNegateMatcher()` added (if site uses negate)
- [ ] Check CMS decofiles for `pathname.ts` prop shape (Fresh uses `case` object, TanStack uses `pattern`/`includes`)
- [ ] Check CMS decofiles for `queryString.ts` prop shape (Fresh uses `conditions[]`, TanStack uses `key`/`value`)
- [ ] Verify no "Unknown matcher" warnings in startup logs
- [ ] Verify no "React Reconnect" events in Chrome Trace
- [ ] Test geo-targeted content from different locations (or mock cookies locally)
