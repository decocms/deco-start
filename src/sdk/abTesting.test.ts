import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getStableBucket,
  proxyToFallback,
  type SiteConfig,
  tagBucket,
  type WorkerHandler,
  withABTesting,
} from "./abTesting";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const REAL_HOST = "www.bagaggio.com.br";
const FALLBACK_HOST = "lojabagaggio.deco.site";

function makeUrl(path = "/x"): URL {
  return new URL(`https://${REAL_HOST}${path}`);
}

function makeFakeKv(value: SiteConfig | null) {
  return {
    get: vi.fn(async () => value),
  };
}

function makeCtx() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// proxyToFallback
// ---------------------------------------------------------------------------

describe("proxyToFallback", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("always sets redirect:'manual' to avoid replaying streamed bodies on 3xx", async () => {
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));

    const request = new Request(`https://${REAL_HOST}/foo`, {
      method: "POST",
      body: "payload",
    });
    await proxyToFallback(request, makeUrl("/foo"), FALLBACK_HOST);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.redirect).toBe("manual");
  });

  it("strips hop-by-hop headers + host before forwarding", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

    const request = new Request(`https://${REAL_HOST}/foo`, {
      method: "GET",
      headers: {
        host: REAL_HOST,
        connection: "keep-alive",
        "keep-alive": "timeout=5",
        "transfer-encoding": "chunked",
        upgrade: "websocket",
        "proxy-authorization": "Bearer x",
        "x-real-ip": "1.2.3.4",
        cookie: "session=abc",
      },
    });
    await proxyToFallback(request, makeUrl("/foo"), FALLBACK_HOST);

    const [, init] = fetchSpy.mock.calls[0];
    const fwd = init.headers as Headers;
    expect(fwd.get("host")).toBeNull();
    expect(fwd.get("connection")).toBeNull();
    expect(fwd.get("keep-alive")).toBeNull();
    expect(fwd.get("transfer-encoding")).toBeNull();
    expect(fwd.get("upgrade")).toBeNull();
    expect(fwd.get("proxy-authorization")).toBeNull();
    // Non-hop-by-hop headers are preserved.
    expect(fwd.get("x-real-ip")).toBe("1.2.3.4");
    expect(fwd.get("cookie")).toBe("session=abc");
    expect(fwd.get("x-forwarded-host")).toBe(REAL_HOST);
  });

  it("forwards a 302 from the upstream without following it, rewriting Location", async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: `https://${FALLBACK_HOST}/landing` },
      }),
    );

    const request = new Request(`https://${REAL_HOST}/go`, {
      method: "POST",
      body: "irrelevant",
    });
    const res = await proxyToFallback(request, makeUrl("/go"), FALLBACK_HOST);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://${REAL_HOST}/landing`);
  });

  it("does NOT consume the response body on 3xx (passes it through as stream)", async () => {
    // The text-rewrite block must skip non-2xx so streamed/binary 3xx bodies
    // aren't needlessly drained — that was a latent bug paired with the
    // redirect:"manual" fix.
    const upstream = new Response("redirect-body", {
      status: 301,
      headers: {
        "content-type": "text/html",
        location: `https://${FALLBACK_HOST}/elsewhere`,
      },
    });
    const textSpy = vi.spyOn(upstream, "text");
    fetchSpy.mockResolvedValue(upstream);

    const request = new Request(`https://${REAL_HOST}/r`, { method: "GET" });
    const res = await proxyToFallback(request, makeUrl("/r"), FALLBACK_HOST);

    expect(textSpy).not.toHaveBeenCalled();
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`https://${REAL_HOST}/elsewhere`);
  });

  it("rewrites the hostname in 2xx text bodies (Fresh partial URLs)", async () => {
    fetchSpy.mockResolvedValue(
      new Response(`<a href="https://${FALLBACK_HOST}/produto">veja</a>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const request = new Request(`https://${REAL_HOST}/p`, { method: "GET" });
    const res = await proxyToFallback(request, makeUrl("/p"), FALLBACK_HOST);
    const body = await res.text();

    expect(body).toBe(`<a href="https://${REAL_HOST}/produto">veja</a>`);
  });

  it("does NOT call .text() on 2xx binary responses (image/png passes as stream)", async () => {
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]);
    const upstream = new Response(binary, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
    const textSpy = vi.spyOn(upstream, "text");
    fetchSpy.mockResolvedValue(upstream);

    const request = new Request(`https://${REAL_HOST}/img.png`, {
      method: "GET",
    });
    const res = await proxyToFallback(request, makeUrl("/img.png"), FALLBACK_HOST);

    expect(textSpy).not.toHaveBeenCalled();
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(binary));
  });

  it("rewrites Set-Cookie Domain from fallback origin to real hostname", async () => {
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("set-cookie", `vtex_segment=abc; Domain=.${FALLBACK_HOST}; Path=/`);
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200, headers }));

    const request = new Request(`https://${REAL_HOST}/api`, { method: "GET" });
    const res = await proxyToFallback(request, makeUrl("/api"), FALLBACK_HOST);

    const cookies = res.headers.getSetCookie?.() ?? [];
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain(`Domain=.${REAL_HOST}`);
    expect(cookies[0]).not.toContain(FALLBACK_HOST);
  });
});

// ---------------------------------------------------------------------------
// withABTesting — clone defense
// ---------------------------------------------------------------------------

describe("withABTesting — outer-catch defense", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recovers via inner handler with body intact when fallback proxy throws", async () => {
    // Simulate the legacy bug: the first fetch (fallback proxy) blows up
    // *after* the body would have been consumed. The outer catch must be
    // able to read request.body when calling handler.fetch, so withABTesting
    // tees the request with request.clone() before handing it to the proxy.
    fetchSpy.mockRejectedValue(new Error("upstream exploded"));

    const handler: WorkerHandler = {
      fetch: vi.fn(async (req) => {
        const body = await req.text();
        return new Response(`handler saw: ${body}`, { status: 200 });
      }),
    };

    const kv = makeFakeKv({
      workerName: "test",
      fallbackOrigin: FALLBACK_HOST,
      abTest: { ratio: 0 }, // ratio 0 → always fallback bucket
    });

    const wrapped = withABTesting(handler, { kvBinding: "KV" });
    const request = new Request(`https://${REAL_HOST}/recover`, {
      method: "POST",
      body: "payload",
    });
    const res = await wrapped.fetch(
      request,
      { KV: kv } as unknown as Record<string, unknown>,
      makeCtx(),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("handler saw: payload");
    expect(handler.fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Ratio-fingerprinted cookie
// ---------------------------------------------------------------------------

describe("getStableBucket — ratio fingerprint", () => {
  it("honors the cookie when its ratio fingerprint matches the current ratio", () => {
    const request = new Request(`https://${REAL_HOST}/`, {
      headers: { cookie: "_deco_bucket=fallback:50", "cf-connecting-ip": "1.2.3.4" },
    });
    expect(getStableBucket(request, 0.5, makeUrl("/"))).toBe("fallback");
  });

  it("ignores the cookie when the KV ratio has changed (fingerprint mismatch)", () => {
    // Cookie remembers an old 50/50 assignment. Operator bumped to 100/0 in
    // KV → cookie is no longer authoritative; bucket must be recomputed
    // against the new threshold (here: 1.0 → always "worker").
    const request = new Request(`https://${REAL_HOST}/`, {
      headers: { cookie: "_deco_bucket=fallback:50", "cf-connecting-ip": "1.2.3.4" },
    });
    expect(getStableBucket(request, 1.0, makeUrl("/"))).toBe("worker");
  });

  it("ignores legacy unix-timestamp cookies and re-evaluates against current ratio", () => {
    // Pre-fingerprint cookies (bucket:unixTs) parse to null and fall through
    // to the hash. Ratio=0 forces "fallback" regardless of IP.
    const request = new Request(`https://${REAL_HOST}/`, {
      headers: {
        cookie: "_deco_bucket=worker:1711540800",
        "cf-connecting-ip": "1.2.3.4",
      },
    });
    expect(getStableBucket(request, 0, makeUrl("/"))).toBe("fallback");
  });

  it("query param override beats the cookie even when fingerprint matches", () => {
    const request = new Request(`https://${REAL_HOST}/?_deco_bucket=worker`, {
      headers: { cookie: "_deco_bucket=fallback:50" },
    });
    expect(
      getStableBucket(
        request,
        0.5,
        new URL(`https://${REAL_HOST}/?_deco_bucket=worker`),
      ),
    ).toBe("worker");
  });
});

describe("tagBucket — ratio fingerprint", () => {
  it("writes the cookie with the current ratio fingerprint when none exists", () => {
    const request = new Request(`https://${REAL_HOST}/`);
    const res = tagBucket(new Response("ok"), "worker", REAL_HOST, request, 0.7);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("_deco_bucket=worker:70");
    expect(setCookie).toContain(`Domain=${REAL_HOST}`);
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("rewrites the cookie when the ratio changes (cookie fingerprint stale)", () => {
    const request = new Request(`https://${REAL_HOST}/`, {
      headers: { cookie: "_deco_bucket=worker:30" },
    });
    const res = tagBucket(new Response("ok"), "worker", REAL_HOST, request, 0.7);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("_deco_bucket=worker:70");
  });

  it("does NOT rewrite the cookie when bucket and ratio still match", () => {
    const request = new Request(`https://${REAL_HOST}/`, {
      headers: { cookie: "_deco_bucket=worker:50" },
    });
    const res = tagBucket(new Response("ok"), "worker", REAL_HOST, request, 0.5);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rounds the ratio to an integer percent (0.501 → 50)", () => {
    const request = new Request(`https://${REAL_HOST}/`);
    const res = tagBucket(new Response("ok"), "worker", REAL_HOST, request, 0.501);
    expect(res.headers.get("set-cookie")).toContain("_deco_bucket=worker:50");
  });

  it("defaults Max-Age to 1 year (cookie expiry is no longer the invalidation mechanism)", () => {
    const request = new Request(`https://${REAL_HOST}/`);
    const res = tagBucket(new Response("ok"), "worker", REAL_HOST, request, 0.5);
    expect(res.headers.get("set-cookie")).toContain(`Max-Age=${60 * 60 * 24 * 365}`);
  });
});
