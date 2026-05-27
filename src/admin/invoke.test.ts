/**
 * Regression tests for /deco/invoke Set-Cookie propagation.
 *
 * The historical bug: the single- and batch-invoke paths copied
 * `RequestContext.responseHeaders` to the HTTP response via
 * `headers.entries()`, which collapses multiple `Set-Cookie` values
 * into a single comma-joined string. Browsers silently discard those,
 * so every VTEX cart action lost its session cookies and the user
 * ended up at /checkout with an empty cart.
 *
 * These tests pin the fix: when a handler appends multiple
 * Set-Cookie values to `RequestContext.responseHeaders`, the response
 * returned by `handleInvoke` must surface them as N distinct
 * Set-Cookie headers (readable via `response.headers.getSetCookie()`).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RequestContext } from "../sdk/requestContext";
import {
  clearInvokeHandlers,
  handleInvoke,
  registerInvokeHandlers,
} from "./invoke";

const COOKIE_A = "checkout.vtex.com__orderFormId=of-123; Path=/; HttpOnly";
const COOKIE_B = "segment=eyJjYW1wYWlnbnMiOiJ4In0=; Path=/; HttpOnly";
const COOKIE_C = "sc=1; Path=/; HttpOnly";

function makeInvokeRequest(key: string, body: unknown = {}): Request {
  return new Request(`http://localhost/deco/invoke/${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeBatchRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/deco/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleInvoke — Set-Cookie propagation (single)", () => {
  beforeEach(() => clearInvokeHandlers());
  afterEach(() => clearInvokeHandlers());

  it("forwards multiple Set-Cookie values as distinct headers", async () => {
    registerInvokeHandlers({
      "vtex/actions/addItemsToCart": async () => {
        RequestContext.responseHeaders.append("set-cookie", COOKIE_A);
        RequestContext.responseHeaders.append("set-cookie", COOKIE_B);
        RequestContext.responseHeaders.append("set-cookie", COOKIE_C);
        return { orderFormId: "of-123" };
      },
    });

    const request = makeInvokeRequest("vtex/actions/addItemsToCart");
    const response = await RequestContext.run(request, () => handleInvoke(request));

    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(3);
    expect(cookies).toContain(COOKIE_A);
    expect(cookies).toContain(COOKIE_B);
    expect(cookies).toContain(COOKIE_C);
  });

  it("does not collapse cookies into a single Set-Cookie entry", async () => {
    registerInvokeHandlers({
      "vtex/actions/foo": async () => {
        RequestContext.responseHeaders.append("set-cookie", COOKIE_A);
        RequestContext.responseHeaders.append("set-cookie", COOKIE_B);
        return {};
      },
    });

    const request = makeInvokeRequest("vtex/actions/foo");
    const response = await RequestContext.run(request, () => handleInvoke(request));

    // The regressed bug appended a single comma-joined string, so
    // `getSetCookie()` returned a 1-element array. The fix appends each
    // value individually — verifying the count alone catches the regression.
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  it("forwards non-cookie headers unchanged", async () => {
    registerInvokeHandlers({
      "vtex/actions/withHeader": async () => {
        RequestContext.responseHeaders.append("x-vtex-trace-id", "abc-123");
        return {};
      },
    });

    const request = makeInvokeRequest("vtex/actions/withHeader");
    const response = await RequestContext.run(request, () => handleInvoke(request));
    expect(response.headers.get("x-vtex-trace-id")).toBe("abc-123");
  });

  it("does not forward Set-Cookie when handler writes none", async () => {
    registerInvokeHandlers({
      "vtex/loaders/productList": async () => ({ items: [] }),
    });

    const request = makeInvokeRequest("vtex/loaders/productList");
    const response = await RequestContext.run(request, () => handleInvoke(request));
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe("handleInvoke — Set-Cookie propagation (batch)", () => {
  beforeEach(() => clearInvokeHandlers());
  afterEach(() => clearInvokeHandlers());

  it("forwards cookies that batch handlers append to the shared context", async () => {
    registerInvokeHandlers({
      "vtex/actions/addItemsToCart": async () => {
        RequestContext.responseHeaders.append("set-cookie", COOKIE_A);
        RequestContext.responseHeaders.append("set-cookie", COOKIE_B);
        return { orderFormId: "of-123" };
      },
      "vtex/loaders/productList": async () => {
        // Loader writes its own cookie (e.g. segment) — must also propagate.
        RequestContext.responseHeaders.append("set-cookie", COOKIE_C);
        return { items: [] };
      },
    });

    const request = makeBatchRequest({
      "vtex/actions/addItemsToCart": { orderFormId: "x" },
      "vtex/loaders/productList": {},
    });
    const response = await RequestContext.run(request, () => handleInvoke(request));

    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(3);
    expect(cookies).toContain(COOKIE_A);
    expect(cookies).toContain(COOKIE_B);
    expect(cookies).toContain(COOKIE_C);
  });
});
