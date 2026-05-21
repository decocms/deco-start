import { describe, expect, it } from "vitest";
import { injectGeoCookies } from "./workerEntry";

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(
    header.split("; ").map((c) => {
      const [k, ...v] = c.split("=");
      return [k, v.join("=")];
    }),
  );
}

function makeRequest(
  cf: Record<string, string> | undefined,
  headers: Record<string, string> = {},
): Request {
  const req = new Request("https://example.com/", { headers });
  if (cf) {
    Object.defineProperty(req, "cf", { value: cf, configurable: true });
  }
  return req;
}

describe("injectGeoCookies", () => {
  it("strips cf-region from the outgoing Request headers while preserving the value in __cf_geo_region cookie", () => {
    const req = makeRequest(
      { region: "São Paulo", country: "BR" },
      { "cf-region": "São Paulo", "cf-ipcountry": "BR" },
    );

    const out = injectGeoCookies(req);

    expect(out.headers.get("cf-region")).toBeNull();
    // ASCII CF headers (cf-ipcountry) are still forwarded
    expect(out.headers.get("cf-ipcountry")).toBe("BR");
    // Geo data is preserved as cookies for matchers
    const cookies = parseCookies(out.headers.get("cookie") ?? "");
    expect(cookies.__cf_geo_region).toBe(encodeURIComponent("São Paulo"));
    expect(cookies.__cf_geo_country).toBe("BR");
  });

  it("strips cf-ipcity from the outgoing Request headers while preserving the value in __cf_geo_city cookie", () => {
    const req = makeRequest(
      { city: "Brasília", country: "BR" },
      { "cf-ipcity": "Brasília" },
    );

    const out = injectGeoCookies(req);

    expect(out.headers.get("cf-ipcity")).toBeNull();
    const cookies = parseCookies(out.headers.get("cookie") ?? "");
    expect(cookies.__cf_geo_city).toBe(encodeURIComponent("Brasília"));
  });

  it("returns the original request unchanged when there is no cf object", () => {
    const req = makeRequest(undefined, { "cf-region": "São Paulo" });

    const out = injectGeoCookies(req);

    // Without cf, we don't build cookies, and we return the original request
    // untouched (so the cf-region header is still present — but that's the
    // caller's pre-existing state, not something we re-introduced).
    expect(out).toBe(req);
  });

  it("returns the original request unchanged when cf has no relevant geo fields", () => {
    const req = makeRequest({ asn: "12345" }, { "cf-region": "São Paulo" });

    const out = injectGeoCookies(req);

    expect(out).toBe(req);
  });

  it("preserves a pre-existing cookie header", () => {
    const req = makeRequest(
      { region: "São Paulo" },
      { cookie: "vtex_segment=abc; another=xyz" },
    );

    const out = injectGeoCookies(req);

    const raw = out.headers.get("cookie") ?? "";
    expect(raw).toContain("vtex_segment=abc");
    expect(raw).toContain("another=xyz");
    expect(raw).toContain("__cf_geo_region=");
  });

  it("forwards non-geo headers untouched", () => {
    const req = makeRequest(
      { region: "Paraná" },
      {
        "user-agent": "test-agent",
        accept: "*/*",
        "x-custom": "value",
        "cf-ray": "9ff5b26cf9bc067a",
      },
    );

    const out = injectGeoCookies(req);

    expect(out.headers.get("user-agent")).toBe("test-agent");
    expect(out.headers.get("accept")).toBe("*/*");
    expect(out.headers.get("x-custom")).toBe("value");
    expect(out.headers.get("cf-ray")).toBe("9ff5b26cf9bc067a");
  });
});
