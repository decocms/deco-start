import { describe, expect, it } from "vitest";
import { detectDevice, isMobileUA, useDevice } from "./useDevice";

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
  it("returns a valid device type in jsdom (client context)", () => {
    // In jsdom, document exists so useDevice takes the client path.
    // window.innerWidth defaults to 0 in jsdom → should return "mobile"
    const device = useDevice();
    expect(["mobile", "tablet", "desktop"]).toContain(device);
  });
});
