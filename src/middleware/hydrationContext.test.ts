import { describe, expect, it } from "vitest";
import { buildHydrationContext } from "./hydrationContext";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://store.com/", { headers });
}

describe("buildHydrationContext", () => {
  it("extracts locale and timezone from cookies", () => {
    const req = makeRequest({ cookie: "locale=pt-BR; tz=America/Sao_Paulo" });
    const ctx = buildHydrationContext(req);
    expect(ctx.locale).toBe("pt-BR");
    expect(ctx.timeZone).toBe("America/Sao_Paulo");
  });

  it("falls back to Accept-Language when no locale cookie", () => {
    const req = makeRequest({ "accept-language": "pt-BR,pt;q=0.9,en;q=0.8" });
    const ctx = buildHydrationContext(req);
    expect(ctx.locale).toBe("pt-BR");
  });

  it("defaults to en-US and UTC when no headers or cookies", () => {
    const req = makeRequest();
    const ctx = buildHydrationContext(req);
    expect(ctx.locale).toBe("en-US");
    expect(ctx.timeZone).toBe("UTC");
  });

  it("extracts country from cf-ipcountry header", () => {
    const req = makeRequest({ "cf-ipcountry": "BR" });
    const ctx = buildHydrationContext(req);
    expect(ctx.country).toBe("BR");
  });

  it("extracts country from cookie when no cf header", () => {
    const req = makeRequest({ cookie: "country=US" });
    const ctx = buildHydrationContext(req);
    expect(ctx.country).toBe("US");
  });

  it("country is undefined when not available", () => {
    const req = makeRequest();
    const ctx = buildHydrationContext(req);
    expect(ctx.country).toBeUndefined();
  });

  it("cf-ipcountry takes precedence over cookie", () => {
    const req = makeRequest({
      "cf-ipcountry": "BR",
      cookie: "country=US",
    });
    const ctx = buildHydrationContext(req);
    expect(ctx.country).toBe("BR");
  });

  it("handles cookies with = in values", () => {
    const req = makeRequest({ cookie: "locale=en-US; token=abc=def=ghi" });
    const ctx = buildHydrationContext(req);
    expect(ctx.locale).toBe("en-US");
  });
});
