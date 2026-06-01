import { beforeEach, describe, expect, it } from "vitest";
import type { MatcherContext } from "../cms/resolve";
import { evaluateMatcher } from "../cms/resolve";
import { registerBuiltinMatchers } from "./builtins";

const LOCATION_KEY = "website/matchers/location.ts";

beforeEach(() => {
  registerBuiltinMatchers();
});

function ctxFromCookies(cookies: Record<string, string>): MatcherContext {
  return { cookies };
}

function ctxFromCf(cf: Record<string, unknown>): MatcherContext {
  const request = new Request("https://example.com/");
  Object.defineProperty(request, "cf", { value: cf, configurable: true });
  return { request };
}

function ctxFromHeaders(headers: Record<string, string>): MatcherContext {
  return {
    request: new Request("https://example.com/", { headers }),
  };
}

function match(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
  return evaluateMatcher({ ...rule, __resolveType: LOCATION_KEY }, ctx);
}

describe("locationMatcher — typed mode (Location)", () => {
  it("matches when regionCode equals Cloudflare's cf-region-code (SP)", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP", "cf-ipcountry": "BR" });
    expect(match({ includeLocations: [{ regionCode: "SP" }] }, ctx)).toBe(true);
  });

  it("matches a raw numeric regionCode (e.g. '47') for parity with deco-cx/apps", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "47", "cf-ipcountry": "BR" });
    expect(match({ includeLocations: [{ regionCode: "47" }] }, ctx)).toBe(true);
  });

  it("is case-insensitive on regionCode", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP" });
    expect(match({ includeLocations: [{ regionCode: "sp" }] }, ctx)).toBe(true);
  });

  it("does NOT match a region NAME against cf-region-code (parity with original)", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP" });
    expect(
      match({ includeLocations: [{ regionCode: "São Paulo" }] }, ctx),
    ).toBe(false);
  });

  it("does not match when the region differs", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP" });
    expect(match({ includeLocations: [{ regionCode: "RJ" }] }, ctx)).toBe(false);
  });

  it("AND's multiple fields on the same entry (regionCode + country)", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP", "cf-ipcountry": "BR" });
    expect(
      match(
        { includeLocations: [{ regionCode: "SP", country: "BR" }] },
        ctx,
      ),
    ).toBe(true);
    expect(
      match(
        { includeLocations: [{ regionCode: "SP", country: "AR" }] },
        ctx,
      ),
    ).toBe(false);
  });

  it("resolves country aliases (Brasil → BR)", () => {
    const ctx = ctxFromHeaders({ "cf-ipcountry": "BR", "cf-region-code": "SP" });
    expect(
      match({ includeLocations: [{ country: "Brasil" }] }, ctx),
    ).toBe(true);
  });

  it("OR's across multiple include entries", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "RJ" });
    expect(
      match(
        {
          includeLocations: [{ regionCode: "SP" }, { regionCode: "RJ" }],
        },
        ctx,
      ),
    ).toBe(true);
  });
});

describe("locationMatcher — empty / shape edge cases", () => {
  it("empty includeLocations array → match (no constraint)", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP" });
    expect(match({ includeLocations: [] }, ctx)).toBe(true);
  });

  it("missing includeLocations → match", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP" });
    expect(match({}, ctx)).toBe(true);
  });

  it("entry {} inside includeLocations matches everyone (parity with original)", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP", "cf-ipcountry": "BR" });
    expect(match({ includeLocations: [{}] }, ctx)).toBe(true);
  });

  it("entry {} inside excludeLocations does NOT exclude anyone (parity)", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP", "cf-ipcountry": "BR" });
    expect(match({ excludeLocations: [{}] }, ctx)).toBe(true);
  });

  it("excludeLocations short-circuits over includeLocations", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP" });
    expect(
      match(
        {
          includeLocations: [{ regionCode: "SP" }],
          excludeLocations: [{ regionCode: "SP" }],
        },
        ctx,
      ),
    ).toBe(false);
  });

  it("includeLocations with [{regionCode}] fails when geo is empty", () => {
    expect(
      match({ includeLocations: [{ regionCode: "SP" }] }, {}),
    ).toBe(false);
  });
});

describe("locationMatcher — Map mode (haversine)", () => {
  it("matches when source coords are within target radius", () => {
    // Target: São Paulo center, 5km. Source: ~500m away.
    const ctx = ctxFromHeaders({
      "cf-iplatitude": "-23.5510",
      "cf-iplongitude": "-46.6340",
    });
    expect(
      match(
        { includeLocations: [{ coordinates: "-23.5505,-46.6333,5000" }] },
        ctx,
      ),
    ).toBe(true);
  });

  it("does NOT match when source coords are outside the radius", () => {
    // Target: São Paulo, 5km. Source: Rio (~360km away).
    const ctx = ctxFromHeaders({
      "cf-iplatitude": "-22.9068",
      "cf-iplongitude": "-43.1729",
    });
    expect(
      match(
        { includeLocations: [{ coordinates: "-23.5505,-46.6333,5000" }] },
        ctx,
      ),
    ).toBe(false);
  });

  it("Map-only rule does NOT match when source has no coordinates", () => {
    // Deliberate divergence from deco-cx/apps: upstream lets coord-only rules
    // vacuously pass when the visitor has no lat/lng, which matches every
    // such visitor — a footgun in production. We require both sides to have
    // coordinates before the haversine check passes.
    const ctx = ctxFromHeaders({ "cf-region-code": "SP" });
    expect(
      match(
        { includeLocations: [{ coordinates: "-23.5505,-46.6333,5000" }] },
        ctx,
      ),
    ).toBe(false);
  });

  it("AND's coordinates with regionCode on the same entry", () => {
    // Source: SP coords, region=SP.
    const ctx = ctxFromHeaders({
      "cf-region-code": "SP",
      "cf-iplatitude": "-23.5510",
      "cf-iplongitude": "-46.6340",
    });
    // Entry asks for region=SP AND within 5km of SP center — matches.
    expect(
      match(
        {
          includeLocations: [
            { regionCode: "SP", coordinates: "-23.5505,-46.6333,5000" },
          ],
        },
        ctx,
      ),
    ).toBe(true);
    // Entry asks for region=SP AND within 5km of Rio — fails on coords.
    expect(
      match(
        {
          includeLocations: [
            { regionCode: "SP", coordinates: "-22.9068,-43.1729,5000" },
          ],
        },
        ctx,
      ),
    ).toBe(false);
  });
});

describe("locationMatcher — data source fallbacks", () => {
  it("reads from request.cf when headers are absent", () => {
    const ctx = ctxFromCf({ country: "BR", regionCode: "SP" });
    expect(match({ includeLocations: [{ regionCode: "SP" }] }, ctx)).toBe(true);
  });

  it("reads from __cf_geo_* cookies as fallback", () => {
    const ctx = ctxFromCookies({
      __cf_geo_country: "BR",
      __cf_geo_region_code: "SP",
    });
    expect(match({ includeLocations: [{ regionCode: "SP" }] }, ctx)).toBe(true);
  });

  it("decodes URL-encoded cookie values (e.g. city with accent)", () => {
    const ctx = ctxFromCookies({
      __cf_geo_country: "BR",
      __cf_geo_city: encodeURIComponent("São Paulo"),
    });
    expect(
      match({ includeLocations: [{ city: "São Paulo" }] }, ctx),
    ).toBe(true);
  });

  it("headers take precedence over request.cf and cookies", () => {
    const request = new Request("https://example.com/", {
      headers: { "cf-region-code": "SP" },
    });
    Object.defineProperty(request, "cf", {
      value: { regionCode: "RJ", country: "BR" },
      configurable: true,
    });
    const ctx: MatcherContext = {
      request,
      cookies: { __cf_geo_region_code: "MG" },
    };
    expect(match({ includeLocations: [{ regionCode: "SP" }] }, ctx)).toBe(true);
    expect(match({ includeLocations: [{ regionCode: "RJ" }] }, ctx)).toBe(false);
  });
});
