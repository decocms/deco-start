/**
 * Phase 2 (D-11) coverage for the metric surface — canonical label set,
 * cache_layer, commerce_request_duration_ms. The Phase 1 logger/trace
 * tests live under `src/sdk/logger.test.ts` and `src/sdk/otel.test.ts`;
 * this file focuses on the middleware-level helpers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureMeter,
  type MeterAdapter,
  MetricNames,
  recordCacheMetric,
  recordCommerceMetric,
  recordRequestMetric,
  statusClassFor,
} from "./observability";

interface Counter {
  name: string;
  value: number;
  labels?: Record<string, unknown>;
}
interface Histogram {
  name: string;
  value: number;
  labels?: Record<string, unknown>;
}

function captureMeter(): {
  adapter: MeterAdapter;
  counters: Counter[];
  histograms: Histogram[];
} {
  const counters: Counter[] = [];
  const histograms: Histogram[] = [];
  const adapter: MeterAdapter = {
    counterInc(name, value, labels) {
      counters.push({ name, value: value ?? 1, labels });
    },
    histogramRecord(name, value, labels) {
      histograms.push({ name, value, labels });
    },
  };
  return { adapter, counters, histograms };
}

describe("statusClassFor", () => {
  it("maps 2xx / 3xx / 4xx / 5xx to canonical class labels", () => {
    expect(statusClassFor(200)).toBe("2xx");
    expect(statusClassFor(204)).toBe("2xx");
    expect(statusClassFor(301)).toBe("3xx");
    expect(statusClassFor(404)).toBe("4xx");
    expect(statusClassFor(500)).toBe("5xx");
    expect(statusClassFor(503)).toBe("5xx");
  });

  it("returns 'unknown' for out-of-range / NaN / non-numeric inputs", () => {
    expect(statusClassFor(-1)).toBe("unknown");
    expect(statusClassFor(99)).toBe("unknown");
    expect(statusClassFor(600)).toBe("unknown");
    expect(statusClassFor(Number.NaN)).toBe("unknown");
    expect(statusClassFor(Infinity)).toBe("unknown");
  });
});

describe("recordRequestMetric — canonical labels (D-11)", () => {
  afterEach(() => {
    // Reset meter so other tests start clean.
    configureMeter({ counterInc: () => {} });
  });

  it("stamps method + route_pattern + status + status_class by default", () => {
    const { adapter, counters, histograms } = captureMeter();
    configureMeter(adapter);

    recordRequestMetric("GET", "/products/abc123/p", 200, 42);

    expect(counters).toHaveLength(1);
    expect(counters[0]?.name).toBe(MetricNames.HTTP_REQUESTS_TOTAL);
    expect(counters[0]?.labels).toMatchObject({
      method: "GET",
      // Default normalization: dynamic segments collapsed.
      route_pattern: "/products/:slug/p",
      status: 200,
      status_class: "2xx",
    });
    expect(histograms).toHaveLength(1);
    expect(histograms[0]?.name).toBe(MetricNames.HTTP_REQUEST_DURATION_MS);
    expect(histograms[0]?.value).toBe(42);
  });

  it("prefers caller-supplied route_pattern over normalized path", () => {
    const { adapter, counters } = captureMeter();
    configureMeter(adapter);

    recordRequestMetric("GET", "/anything/random/123", 200, 5, {
      route_pattern: "/_products/$slug/p",
    });

    expect(counters[0]?.labels?.route_pattern).toBe("/_products/$slug/p");
  });

  it("emits http_request_errors_total on 5xx", () => {
    const { adapter, counters } = captureMeter();
    configureMeter(adapter);

    recordRequestMetric("POST", "/checkout", 503, 120);

    const errCounter = counters.find((c) => c.name === MetricNames.HTTP_REQUEST_ERRORS);
    expect(errCounter).toBeDefined();
    expect(errCounter?.labels?.status_class).toBe("5xx");
  });

  it("propagates optional labels (outcome, cache_decision, cache_layer, region, extra)", () => {
    const { adapter, counters } = captureMeter();
    configureMeter(adapter);

    recordRequestMetric("GET", "/", 200, 10, {
      outcome: "ok",
      cache_decision: "STALE-HIT",
      cache_layer: "edge",
      region: "GRU",
      extra: { ab_variant: "B" },
    });

    expect(counters[0]?.labels).toMatchObject({
      outcome: "ok",
      cache_decision: "STALE-HIT",
      cache_layer: "edge",
      region: "GRU",
      ab_variant: "B",
    });
  });

  it("is a no-op when no meter is configured", () => {
    // We can't easily prove a no-op other than verifying no throw —
    // safer than calling configureMeter(null), which would mask real
    // bugs. The previous test's `afterEach` reset already gives us a
    // bare meter; this test confirms the call is benign.
    expect(() => recordRequestMetric("GET", "/", 200, 1)).not.toThrow();
  });
});

describe("recordCacheMetric — cache_layer label", () => {
  beforeEach(() => {
    configureMeter({ counterInc: () => {} });
  });

  it("stamps profile + decision + layer when all are provided", () => {
    const { adapter, counters } = captureMeter();
    configureMeter(adapter);

    recordCacheMetric(true, "product", "HIT", "edge");

    expect(counters).toHaveLength(1);
    expect(counters[0]?.name).toBe(MetricNames.CACHE_HIT);
    expect(counters[0]?.labels).toMatchObject({
      profile: "product",
      decision: "HIT",
      layer: "edge",
    });
  });

  it("emits cache_miss_total when hit=false", () => {
    const { adapter, counters } = captureMeter();
    configureMeter(adapter);

    recordCacheMetric(false, "search", "MISS", "edge");

    expect(counters[0]?.name).toBe(MetricNames.CACHE_MISS);
  });

  it("supports the legacy 3-arg signature for backward compat", () => {
    const { adapter, counters } = captureMeter();
    configureMeter(adapter);

    recordCacheMetric(true, "static");

    expect(counters[0]?.labels).toEqual({ profile: "static" });
  });

  it("distinguishes cachedLoader vs edge vs vtex-swr layers", () => {
    const { adapter, counters } = captureMeter();
    configureMeter(adapter);

    recordCacheMetric(true, "loader-x", "HIT", "cachedLoader");
    recordCacheMetric(true, "vtex-product", "HIT", "vtex-swr");

    expect(counters[0]?.labels?.layer).toBe("cachedLoader");
    expect(counters[1]?.labels?.layer).toBe("vtex-swr");
  });
});

describe("recordCommerceMetric (D-11)", () => {
  beforeEach(() => {
    configureMeter({ counterInc: () => {} });
  });

  it("emits commerce_request_duration_ms with provider + operation labels", () => {
    const { adapter, histograms } = captureMeter();
    configureMeter(adapter);

    recordCommerceMetric(123, {
      provider: "vtex",
      operation: "intelligent-search.product_search",
      status_class: "2xx",
    });

    expect(histograms).toHaveLength(1);
    expect(histograms[0]?.name).toBe(MetricNames.COMMERCE_REQUEST_DURATION_MS);
    expect(histograms[0]?.value).toBe(123);
    expect(histograms[0]?.labels).toMatchObject({
      provider: "vtex",
      operation: "intelligent-search.product_search",
      status_class: "2xx",
    });
  });

  it("includes the cached boolean when provided", () => {
    const { adapter, histograms } = captureMeter();
    configureMeter(adapter);

    recordCommerceMetric(5, {
      provider: "shopify",
      operation: "graphql.cart_query",
      cached: true,
    });

    expect(histograms[0]?.labels?.cached).toBe(true);
  });

  it("is a no-op when no meter is configured", () => {
    expect(() =>
      recordCommerceMetric(1, { provider: "vtex", operation: "test" }),
    ).not.toThrow();
  });
});
