import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppInvoke, invoke } from "./invoke";

describe("createAppInvoke", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("collects nested property access into slash-separated key", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const proxy = createAppInvoke();
    const result = await proxy.vtex.actions.checkout.addItemsToCart({ qty: 1 });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/deco/invoke/vtex/actions/checkout/addItemsToCart");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ qty: 1 });
  });

  it("falls back to .ts suffix when first key returns 404", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ via: "ts" }), { status: 200 }));

    const proxy = createAppInvoke();
    const result = await proxy.site.loaders.Wishlist({});

    expect(result).toEqual({ via: "ts" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/deco/invoke/site/loaders/Wishlist");
    expect(fetchMock.mock.calls[1][0]).toBe("/deco/invoke/site/loaders/Wishlist.ts");
  });

  it("throws 'handler not found' when both key and .ts variant 404", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    const proxy = createAppInvoke();
    await expect(proxy.unknown({})).rejects.toThrow(/invoke\(unknown\) failed: handler not found/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws with status and error body on non-OK non-404 response", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));

    const proxy = createAppInvoke();
    await expect(proxy.broken({})).rejects.toThrow(/invoke\(broken\) failed \(500\): boom/);
  });

  it("defaults to empty object body when called with no props", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    const proxy = createAppInvoke();
    await proxy.foo.bar();

    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(init.body)).toEqual({});
  });

  it("traps `then`, `catch`, `finally` to avoid being awaited as a thenable", () => {
    const proxy = createAppInvoke();
    expect(proxy.then).toBeUndefined();
    expect(proxy.catch).toBeUndefined();
    expect(proxy.finally).toBeUndefined();
    // And on a deeper path:
    expect(proxy.foo.bar.then).toBeUndefined();
  });

  it("returns undefined for symbol property access (no spurious sub-proxy)", () => {
    const proxy = createAppInvoke();
    expect(proxy[Symbol.toPrimitive]).toBeUndefined();
    expect(proxy[Symbol.iterator]).toBeUndefined();
  });

  it("respects custom basePath", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    const proxy = createAppInvoke("/custom/invoke");
    await proxy.foo.bar({});

    expect(fetchMock.mock.calls[0][0]).toBe("/custom/invoke/foo/bar");
  });
});

describe("default invoke singleton", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a usable nested proxy bound to /deco/invoke", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await (invoke as any).site.loaders.example({ x: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/deco/invoke/site/loaders/example");
  });
});
