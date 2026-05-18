import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstrumentedFetch } from "./instrumentedFetch";
import { configureLogger, defaultLoggerAdapter } from "./logger";
import type { Span, TracerAdapter } from "./observability";
import { configureTracer, setObservabilitySpanStore } from "./observability";

function makeFakeTracer(): {
  tracer: TracerAdapter;
  startSpan: ReturnType<typeof vi.fn>;
  spans: Array<ReturnType<typeof makeFakeSpan>>;
} {
  const spans: Array<ReturnType<typeof makeFakeSpan>> = [];
  const startSpan = vi.fn((name: string, attrs?: Record<string, string | number | boolean>) => {
    const s = makeFakeSpan(name, attrs);
    spans.push(s);
    return s.span;
  });
  return { tracer: { startSpan } as TracerAdapter, startSpan, spans };
}

function makeFakeSpan(
  name: string,
  initialAttrs?: Record<string, string | number | boolean>,
  ctx?: { traceId: string; spanId: string; traceFlags: number },
) {
  const attrs: Record<string, string | number | boolean> = { ...(initialAttrs ?? {}) };
  const span: Span = {
    end: vi.fn(),
    setError: vi.fn(),
    setAttribute: vi.fn((k: string, v: string | number | boolean) => {
      attrs[k] = v;
    }),
    spanContext: ctx ? () => ctx : undefined,
  };
  return { name, span, attrs };
}

describe("createInstrumentedFetch — URL redaction", () => {
  afterEach(() => {
    configureTracer({ startSpan: () => ({ end: () => {} }) });
    setObservabilitySpanStore(undefined);
    configureLogger(defaultLoggerAdapter);
    vi.restoreAllMocks();
  });

  it("stamps a redacted http.url on the span, not the raw URL", async () => {
    const { tracer, spans } = makeFakeTracer();
    configureTracer(tracer);
    const baseFetch = vi.fn(async () => new Response("ok", { status: 200 }));

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
    });

    await f("https://api.test/search?token=SECRET123&page=2");

    expect(spans).toHaveLength(1);
    expect(spans[0].attrs["http.url"]).toBe("https://api.test/search?token=REDACTED&page=REDACTED");
  });

  it("honors keepQueryKeys for benign query params", async () => {
    const { tracer, spans } = makeFakeTracer();
    configureTracer(tracer);
    const baseFetch = vi.fn(async () => new Response("ok"));

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      keepQueryKeys: ["page", "sort"],
    });

    await f("https://api.test/search?token=SECRET&page=2&sort=name");

    expect(spans[0].attrs["http.url"]).toBe(
      "https://api.test/search?token=REDACTED&page=2&sort=name",
    );
  });

  it("emits the structured `outgoing fetch` log with host+path when OTEL_LOG_OUTGOING_FETCH=true", async () => {
    // The breadcrumb is gated behind an env flag to avoid log explosion
    // in production; we flip it on for the test and assert on the
    // payload to keep this test honest about what it verifies.
    const captured: Array<{
      level: string;
      msg: string;
      attrs?: Record<string, unknown>;
    }> = [];
    configureLogger({
      log: (level, msg, attrs) => {
        captured.push({ level, msg, attrs });
      },
    });

    const previous = process.env.OTEL_LOG_OUTGOING_FETCH;
    process.env.OTEL_LOG_OUTGOING_FETCH = "true";

    try {
      const baseFetch = vi.fn(async () => new Response("ok", { status: 200 }));
      const f = createInstrumentedFetch({
        name: "vtex",
        baseFetch: baseFetch as unknown as typeof fetch,
        logging: false,
      });

      const res = await f("https://api.test/items?id=42");
      expect(res.status).toBe(200);

      const breadcrumb = captured.find((c) => c.msg === "outgoing fetch");
      expect(breadcrumb).toBeDefined();
      expect(breadcrumb?.level).toBe("info");
      expect(breadcrumb?.attrs).toMatchObject({
        app: "vtex",
        host: "api.test",
        path: "/items",
        method: "GET",
        status: 200,
        ok: true,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OTEL_LOG_OUTGOING_FETCH;
      } else {
        process.env.OTEL_LOG_OUTGOING_FETCH = previous;
      }
    }
  });

  it("does NOT emit the `outgoing fetch` breadcrumb when the env flag is unset", async () => {
    const captured: Array<{ msg: string }> = [];
    configureLogger({
      log: (_level, msg) => captured.push({ msg }),
    });

    const previous = process.env.OTEL_LOG_OUTGOING_FETCH;
    delete process.env.OTEL_LOG_OUTGOING_FETCH;

    try {
      const baseFetch = vi.fn(async () => new Response("ok"));
      const f = createInstrumentedFetch({
        name: "vtex",
        baseFetch: baseFetch as unknown as typeof fetch,
        logging: false,
      });
      await f("https://api.test/items?id=42");

      expect(captured.find((c) => c.msg === "outgoing fetch")).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env.OTEL_LOG_OUTGOING_FETCH = previous;
    }
  });
});

describe("createInstrumentedFetch — traceparent injection", () => {
  afterEach(() => {
    configureTracer({ startSpan: () => ({ end: () => {} }) });
    setObservabilitySpanStore(undefined);
    vi.restoreAllMocks();
  });

  it("injects traceparent on outbound calls when a span is active", async () => {
    // Install a tracer that creates a fake span whose spanContext()
    // returns a known id, AND wire the spanStore so getActiveSpan()
    // can find it across the await boundary inside withTracing.
    const knownCtx = {
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "fedcba9876543210",
      traceFlags: 1,
    };

    // The redacted "active span" is the one createInstrumentedFetch starts.
    // injectTraceContext reads `getActiveSpan()`, which only works inside
    // a `withTracing` / spanStore.run scope. The simplest stub: install a
    // tracer that returns a span with spanContext, AND make the spanStore
    // resolve that span when fetched.
    const fakeSpan = makeFakeSpan("vtex.fetch", undefined, knownCtx);
    configureTracer({
      startSpan: () => fakeSpan.span,
    });

    // Custom span store that returns the fake span on every get(). This
    // models the host's ALS-backed store with a single active span.
    setObservabilitySpanStore({
      get: () => fakeSpan.span,
      run: (_span, fn) => fn(),
    });

    const baseFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      return new Response(h.get("traceparent") ?? "<missing>", { status: 200 });
    });

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
    });

    const res = await f("https://api.test/x");
    const body = await res.text();
    expect(body).toBe(`00-${knownCtx.traceId}-${knownCtx.spanId}-01`);
  });

  it("does NOT inject traceparent when injectTraceparent: false", async () => {
    const fakeSpan = makeFakeSpan("vtex.fetch", undefined, {
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      traceFlags: 1,
    });
    configureTracer({ startSpan: () => fakeSpan.span });
    setObservabilitySpanStore({
      get: () => fakeSpan.span,
      run: (_s, fn) => fn(),
    });

    const baseFetch = vi.fn(async (_i: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      return new Response(JSON.stringify({ traceparent: h.get("traceparent") }), { status: 200 });
    });

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
      injectTraceparent: false,
    });

    const res = await f("https://api.test/x");
    const body = (await res.json()) as { traceparent: string | null };
    expect(body.traceparent).toBeNull();
  });

  it("is a safe no-op when no span is active", async () => {
    // No tracer configured, no spanStore — injectTraceContext returns early.
    configureTracer({ startSpan: () => ({ end: () => {} }) });
    setObservabilitySpanStore(undefined);

    const baseFetch = vi.fn(async (_i: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      return new Response(h.get("traceparent") ?? "<missing>", { status: 200 });
    });

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
    });

    const res = await f("https://api.test/x");
    expect(await res.text()).toBe("<missing>");
  });

  it("preserves caller-supplied headers when injecting traceparent", async () => {
    const fakeSpan = makeFakeSpan("vtex.fetch", undefined, {
      traceId: "33333333333333333333333333333333",
      spanId: "4444444444444444",
      traceFlags: 1,
    });
    configureTracer({ startSpan: () => fakeSpan.span });
    setObservabilitySpanStore({
      get: () => fakeSpan.span,
      run: (_s, fn) => fn(),
    });

    const baseFetch = vi.fn(async (_i: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          auth: h.get("authorization"),
          tp: h.get("traceparent"),
        }),
        { status: 200 },
      );
    });

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
    });

    const res = await f("https://api.test/x", {
      headers: { authorization: "Bearer abc" },
    });
    const body = (await res.json()) as { auth: string; tp: string };
    expect(body.auth).toBe("Bearer abc");
    expect(body.tp).toBe(
      `00-${fakeSpan.span.spanContext!().traceId}-${fakeSpan.span.spanContext!().spanId}-01`,
    );
  });

  it("honors Fetch-spec semantics: init.headers REPLACES Request headers (does not union)", async () => {
    // Per the Fetch spec, when both a Request and `init.headers` are
    // passed to `fetch()`, init.headers replace Request.headers — not
    // union. Verify our wrapper preserves that contract: a Request with
    // header `x-from-req` and an init with header `x-from-init` should
    // surface only `x-from-init` on the wire, plus our injected
    // traceparent.
    const fakeSpan = makeFakeSpan("vtex.fetch", undefined, {
      traceId: "55555555555555555555555555555555",
      spanId: "6666666666666666",
      traceFlags: 1,
    });
    configureTracer({ startSpan: () => fakeSpan.span });
    setObservabilitySpanStore({
      get: () => fakeSpan.span,
      run: (_s, fn) => fn(),
    });

    const baseFetch = vi.fn(async (_i: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          fromReq: h.get("x-from-req"),
          fromInit: h.get("x-from-init"),
          tp: h.get("traceparent"),
        }),
        { status: 200 },
      );
    });

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
    });

    const req = new Request("https://api.test/x", {
      headers: { "x-from-req": "REQ" },
    });
    const res = await f(req, { headers: { "x-from-init": "INIT" } });
    const body = (await res.json()) as {
      fromReq: string | null;
      fromInit: string | null;
      tp: string | null;
    };
    // init.headers replaces, so x-from-req must NOT leak through.
    expect(body.fromReq).toBeNull();
    expect(body.fromInit).toBe("INIT");
    expect(body.tp).toMatch(/^00-/);
  });

  it("uses init.operation to name the span", async () => {
    const { tracer, spans } = makeFakeTracer();
    configureTracer(tracer);
    const baseFetch = vi.fn(async () => new Response("ok", { status: 200 }));

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
    });

    await f("https://api.test/whatever", {
      method: "POST",
      operation: "intelligent-search.product_search",
    });

    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("vtex.intelligent-search.product_search");
    expect(spans[0].attrs["fetch.operation"]).toBe("intelligent-search.product_search");
  });

  it("strips `operation` from init before calling baseFetch", async () => {
    const baseFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      // `operation` is an extension on InstrumentedFetchInit, NOT a
      // valid RequestInit property. It must be removed before the
      // underlying fetch sees the init.
      expect(init && "operation" in init).toBe(false);
      return new Response("ok");
    });
    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
    });
    await f("https://api.test/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      operation: "checkout.orderForm",
    });
    expect(baseFetch).toHaveBeenCalledOnce();
  });

  it("falls back to defaultOperation when init.operation is omitted", async () => {
    const { tracer, spans } = makeFakeTracer();
    configureTracer(tracer);
    const baseFetch = vi.fn(async () => new Response("ok"));

    const f = createInstrumentedFetch({
      name: "resend",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
      defaultOperation: "emails.send",
    });
    await f("https://api.resend.com/emails");

    expect(spans[0].name).toBe("resend.emails.send");
    expect(spans[0].attrs["fetch.operation"]).toBe("emails.send");
  });

  it("falls back to resolveOperation when init.operation + defaultOperation are unset", async () => {
    const { tracer, spans } = makeFakeTracer();
    configureTracer(tracer);
    const baseFetch = vi.fn(async () => new Response("ok"));

    const resolveOperation = vi.fn((url: string, _method: string) => {
      const u = new URL(url);
      // Toy router: `/api/checkout/...` → checkout.<segment>
      const m = u.pathname.match(/^\/api\/checkout\/(\w+)/);
      if (m) return `checkout.${m[1]}`;
      return undefined;
    });

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
      resolveOperation,
    });
    await f("https://api.vtex.test/api/checkout/orderForm");

    expect(resolveOperation).toHaveBeenCalledWith(
      "https://api.vtex.test/api/checkout/orderForm",
      "GET",
    );
    expect(spans[0].name).toBe("vtex.checkout.orderForm");
  });

  it("falls back to the literal '.fetch' suffix when resolveOperation returns undefined", async () => {
    const { tracer, spans } = makeFakeTracer();
    configureTracer(tracer);
    const baseFetch = vi.fn(async () => new Response("ok"));

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
      resolveOperation: () => undefined,
    });
    await f("https://api.vtex.test/unknown");

    expect(spans[0].name).toBe("vtex.fetch");
    expect(spans[0].attrs["fetch.operation"]).toBe("fetch");
  });

  it("explicit init.operation wins over defaultOperation AND resolveOperation", async () => {
    const { tracer, spans } = makeFakeTracer();
    configureTracer(tracer);
    const baseFetch = vi.fn(async () => new Response("ok"));

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
      defaultOperation: "from-default",
      resolveOperation: () => "from-router",
    });
    await f("https://api.vtex.test/x", { operation: "from-call" });

    expect(spans[0].name).toBe("vtex.from-call");
  });

  it("derives method from a Request input when init.method is omitted", async () => {
    // Without this, `fetch(new Request(url, { method: "POST" }))` would
    // surface as GET on the span and in the URL-router callback —
    // mislabeling POST traffic in dashboards.
    const { tracer, spans } = makeFakeTracer();
    configureTracer(tracer);
    const resolveOperation = vi.fn(
      (_url: string, method: string) => `inferred.${method.toLowerCase()}`,
    );
    const baseFetch = vi.fn(async () => new Response("ok"));

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
      resolveOperation,
    });
    await f(new Request("https://api.test/x", { method: "POST" }));

    expect(resolveOperation).toHaveBeenCalledWith("https://api.test/x", "POST");
    expect(spans[0].attrs["http.method"]).toBe("POST");
    expect(spans[0].name).toBe("vtex.inferred.post");
  });

  it("init.method overrides the Request's method (Fetch spec)", async () => {
    const { tracer, spans } = makeFakeTracer();
    configureTracer(tracer);
    const baseFetch = vi.fn(async () => new Response("ok"));

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
    });
    await f(new Request("https://api.test/x", { method: "POST" }), {
      method: "DELETE",
    });

    expect(spans[0].attrs["http.method"]).toBe("DELETE");
  });

  it("passes the resolved operation to onComplete", async () => {
    const baseFetch = vi.fn(async () => new Response("ok"));
    const onComplete = vi.fn();
    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
      defaultOperation: "catalog.fallback",
      onComplete,
    });
    await f("https://api.vtex.test/x", { operation: "intelligent-search.product_search" });
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "intelligent-search.product_search" }),
    );
  });

  it("preserves Request headers when init.headers is omitted", async () => {
    const fakeSpan = makeFakeSpan("vtex.fetch", undefined, {
      traceId: "77777777777777777777777777777777",
      spanId: "8888888888888888",
      traceFlags: 1,
    });
    configureTracer({ startSpan: () => fakeSpan.span });
    setObservabilitySpanStore({
      get: () => fakeSpan.span,
      run: (_s, fn) => fn(),
    });

    const baseFetch = vi.fn(async (_i: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          fromReq: h.get("x-from-req"),
          tp: h.get("traceparent"),
        }),
        { status: 200 },
      );
    });

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
    });

    const req = new Request("https://api.test/x", {
      headers: { "x-from-req": "REQ" },
    });
    // No init.headers — Request headers must reach the wire.
    const res = await f(req);
    const body = (await res.json()) as { fromReq: string | null; tp: string | null };
    expect(body.fromReq).toBe("REQ");
    expect(body.tp).toMatch(/^00-/);
  });
});
