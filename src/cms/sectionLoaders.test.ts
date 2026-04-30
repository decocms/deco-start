import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerCacheableSections,
  registerLayoutSections,
  registerSectionLoader,
  runSingleSectionLoader,
} from "./sectionLoaders";
import type { ResolvedSection } from "./resolve";

const G = globalThis as any;

beforeEach(() => {
  G.__deco.sectionLoaderRegistry.clear();
  G.__deco.layoutSections.clear();
  G.__deco.cacheableSections.clear();
});

const makeSection = (
  component: string,
  props: Record<string, unknown> = {},
): ResolvedSection => ({
  component,
  props,
  key: component,
  index: 0,
});

describe("runSingleSectionLoader — page context injection", () => {
  it("injects __pageUrl and __pagePath into loader props", async () => {
    const loader = vi.fn(async (props: Record<string, unknown>) => props);
    registerSectionLoader("site/sections/SearchBanner.tsx", loader);

    const section = makeSection("site/sections/SearchBanner.tsx", { foo: "bar" });
    const request = new Request("https://store.com/lingerie?q=preto");

    await runSingleSectionLoader(section, request);

    expect(loader).toHaveBeenCalledTimes(1);
    const [calledProps, calledReq] = loader.mock.calls[0];
    expect(calledProps).toMatchObject({
      foo: "bar",
      __pageUrl: "https://store.com/lingerie?q=preto",
      __pagePath: "/lingerie",
    });
    expect(calledReq).toBe(request);
  });

  it("preserves existing __pageUrl / __pagePath from props (site workaround compat)", async () => {
    const loader = vi.fn(async (props: Record<string, unknown>) => props);
    registerSectionLoader("site/sections/Custom.tsx", loader);

    const section = makeSection("site/sections/Custom.tsx", {
      __pageUrl: "https://override.example/page",
      __pagePath: "/override",
    });
    const request = new Request("https://store.com/real-path");

    await runSingleSectionLoader(section, request);

    const [calledProps] = loader.mock.calls[0];
    expect(calledProps.__pageUrl).toBe("https://override.example/page");
    expect(calledProps.__pagePath).toBe("/override");
  });

  it("does not throw when request.url is invalid", async () => {
    const loader = vi.fn(async (props: Record<string, unknown>) => props);
    registerSectionLoader("site/sections/X.tsx", loader);

    const section = makeSection("site/sections/X.tsx", { foo: 1 });
    const badReq = { url: "not a url" } as unknown as Request;

    await expect(runSingleSectionLoader(section, badReq)).resolves.toBeDefined();
    expect(loader).toHaveBeenCalled();
  });

  it("returns section unchanged when no loader is registered", async () => {
    const section = makeSection("site/sections/NoLoader.tsx", { foo: 1 });
    const result = await runSingleSectionLoader(
      section,
      new Request("https://store.com/"),
    );
    expect(result).toBe(section);
  });
});

describe("runSingleSectionLoader — cache keying", () => {
  it("cacheable sections share a cache entry across different page URLs", async () => {
    const loader = vi.fn(async (props: Record<string, unknown>) => ({
      ...props,
      enriched: true,
    }));
    registerSectionLoader("site/sections/Shelf.tsx", loader);
    registerCacheableSections({ "site/sections/Shelf.tsx": { maxAge: 60_000 } });

    const section = makeSection("site/sections/Shelf.tsx", { title: "Best" });

    await runSingleSectionLoader(section, new Request("https://store.com/page-a"));
    await runSingleSectionLoader(section, new Request("https://store.com/page-b"));
    await runSingleSectionLoader(section, new Request("https://store.com/page-c"));

    // Without URL-agnostic cache keys, this would be 3.
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("layout sections cache by component name and reuse across pages", async () => {
    const loader = vi.fn(async (props: Record<string, unknown>) => props);
    registerSectionLoader("site/sections/Header.tsx", loader);
    registerLayoutSections(["site/sections/Header.tsx"]);

    const section = makeSection("site/sections/Header.tsx", { variant: "default" });

    await runSingleSectionLoader(section, new Request("https://store.com/a"));
    await runSingleSectionLoader(section, new Request("https://store.com/b"));

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("regular (non-cached) sections re-run on every request", async () => {
    const loader = vi.fn(async (props: Record<string, unknown>) => props);
    registerSectionLoader("site/sections/Reg.tsx", loader);

    const section = makeSection("site/sections/Reg.tsx", {});
    await runSingleSectionLoader(section, new Request("https://store.com/a"));
    await runSingleSectionLoader(section, new Request("https://store.com/b"));

    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("runSingleSectionLoader — error handling", () => {
  it("falls back to original section when loader throws", async () => {
    const loader = vi.fn(async () => {
      throw new Error("boom");
    });
    registerSectionLoader("site/sections/Boom.tsx", loader);

    const section = makeSection("site/sections/Boom.tsx", { x: 1 });
    const result = await runSingleSectionLoader(
      section,
      new Request("https://store.com/"),
    );
    expect(result).toEqual(section);
  });
});
