import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeviceProvider, detectDevice, isMobileUA, useDevice } from "./useDevice";

describe("detectDevice", () => {
  it("detects iPhone as mobile", () => {
    expect(
      detectDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("mobile");
  });

  it("detects Android phone as mobile", () => {
    expect(
      detectDevice(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("mobile");
  });

  it("detects iPad as tablet", () => {
    expect(
      detectDevice(
        "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("tablet");
  });

  it("detects Android tablet as tablet", () => {
    expect(
      detectDevice(
        "Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ),
    ).toBe("tablet");
  });

  it("detects Chrome desktop as desktop", () => {
    expect(
      detectDevice(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ),
    ).toBe("desktop");
  });

  it("returns desktop for empty UA", () => {
    expect(detectDevice("")).toBe("desktop");
  });

  it("detects Googlebot as desktop", () => {
    expect(
      detectDevice(
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      ),
    ).toBe("desktop");
  });

  it("detects Googlebot mobile as mobile", () => {
    expect(
      detectDevice(
        "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1)",
      ),
    ).toBe("mobile");
  });
});

describe("isMobileUA", () => {
  it("returns true for mobile UAs", () => {
    expect(isMobileUA("iPhone")).toBe(true);
  });

  it("returns true for tablet UAs", () => {
    expect(isMobileUA("iPad")).toBe(true);
  });

  it("returns false for desktop UAs", () => {
    expect(
      isMobileUA(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      ),
    ).toBe(false);
  });
});

describe("useDevice (isomorphic)", () => {
  it("uses navigator.userAgent on client, not viewport width", () => {
    // In jsdom, document exists → useDevice takes the client path.
    // It should use navigator.userAgent (same mechanism as server-side)
    // to ensure consistent values between SSR and hydration.
    // jsdom's navigator.userAgent is a desktop-like string.
    const device = useDevice();
    const expected = detectDevice(navigator.userAgent);
    expect(device).toBe(expected);
  });

  it("returns consistent result with detectDevice(navigator.userAgent)", () => {
    // This is the key SSR/hydration consistency check:
    // server calls detectDevice(req.headers["user-agent"])
    // client calls detectDevice(navigator.userAgent)
    // Both use the same detectDevice() function → same result for same UA.
    const clientResult = useDevice();
    const directResult = detectDevice(navigator.userAgent);
    expect(clientResult).toBe(directResult);
  });
});

describe("DeviceProvider seeds useDevice() with the serialized value (#278)", () => {
  function Probe() {
    // Inside a render, useDevice() reads DeviceContext — this is the path that
    // makes hydration stable when the value comes from the page loader.
    return createElement("span", null, useDevice());
  }

  it("useDevice() returns the provider value, overriding runtime detection", () => {
    // jsdom's navigator is desktop-like, so a "tablet" result can only come
    // from the provider value (the server-resolved device), not runtime.
    const html = renderToStaticMarkup(
      createElement(DeviceProvider, { value: "tablet", children: createElement(Probe) }),
    );
    expect(html).toBe("<span>tablet</span>");
  });

  it("falls back to runtime resolution when no value is provided", () => {
    const html = renderToStaticMarkup(
      createElement(DeviceProvider, { children: createElement(Probe) }),
    );
    expect(html).toBe(`<span>${detectDevice(navigator.userAgent)}</span>`);
  });
});
