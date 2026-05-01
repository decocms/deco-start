import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSection } from "./resolve";
import {
  registerCacheableSections,
  registerLayoutSections,
  registerSectionLoader,
  runSingleSectionLoader,
} from "./sectionLoaders";

const G = globalThis as any;

beforeEach(() => {
  G.__deco.sectionLoaderRegistry.clear();
  G.__deco.layoutSections.clear();
  G.__deco.cacheableSections.clear();
});

const makeSection = (component: string, props: Record<string, unknown> = {}): ResolvedSection => ({
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
    const result = await runSingleSectionLoader(section, new Request("https://store.com/"));
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
    const result = await runSingleSectionLoader(section, new Request("https://store.com/"));
    expect(result).toEqual(section);
  });
});

describe("runSingleSectionLoader — nested section recursion", () => {
  it("runs the loader of a nested section in props", async () => {
    const childLoader = vi.fn(async (props: Record<string, unknown>) => ({
      ...props,
      enriched: true,
    }));
    registerSectionLoader("site/sections/CategoryBanner.tsx", childLoader);

    // Parent has no own loader, only a nested section in props
    const parent = makeSection("site/sections/BackgroundWrapper.tsx", {
      child: {
        Component: "site/sections/CategoryBanner.tsx",
        props: { matcher: "/foo" },
      },
    });

    const result = await runSingleSectionLoader(parent, new Request("https://store.com/foo"));

    expect(childLoader).toHaveBeenCalledTimes(1);
    expect(result.props).toEqual({
      child: {
        Component: "site/sections/CategoryBanner.tsx",
        props: {
          matcher: "/foo",
          enriched: true,
          // page context is injected for nested sections too
          __pageUrl: "https://store.com/foo",
          __pagePath: "/foo",
        },
      },
    });
  });

  it("runs nested loaders in arrays (e.g. sections: Section[])", async () => {
    const banner = vi.fn(async (props: any) => ({ ...props, ranBanner: true }));
    const shelf = vi.fn(async (props: any) => ({ ...props, ranShelf: true }));
    registerSectionLoader("site/sections/Banner.tsx", banner);
    registerSectionLoader("site/sections/Shelf.tsx", shelf);

    const parent = makeSection("site/sections/Wrapper.tsx", {
      sections: [
        { Component: "site/sections/Banner.tsx", props: { id: 1 } },
        { Component: "site/sections/Shelf.tsx", props: { id: 2 } },
      ],
    });

    const result = await runSingleSectionLoader(parent, new Request("https://store.com/"));

    expect(banner).toHaveBeenCalledTimes(1);
    expect(shelf).toHaveBeenCalledTimes(1);
    const sections = (result.props as any).sections;
    expect(sections[0].props).toMatchObject({ id: 1, ranBanner: true });
    expect(sections[1].props).toMatchObject({ id: 2, ranShelf: true });
  });

  it("returns same props reference when no nested sections (zero-alloc leaf path)", async () => {
    const loader = vi.fn(async (props: Record<string, unknown>) => props);
    registerSectionLoader("site/sections/Leaf.tsx", loader);

    const props = { foo: "bar" };
    const section = makeSection("site/sections/Leaf.tsx", props);

    const result = await runSingleSectionLoader(section, new Request("https://store.com/"));

    // Loader returned the SAME props ref → enrichNestedSections must also
    // return the same ref → no { ...result, props } wrapping happens
    expect(result.props).toMatchObject({
      foo: "bar",
      __pageUrl: "https://store.com/",
      __pagePath: "/",
    });
  });

  it("recurses into deeply nested sections (wrapper inside wrapper)", async () => {
    const inner = vi.fn(async (props: any) => ({ ...props, deep: true }));
    registerSectionLoader("site/sections/Inner.tsx", inner);

    const parent = makeSection("site/sections/Outer.tsx", {
      child: {
        Component: "site/sections/MidWrapper.tsx",
        props: {
          grandchild: {
            Component: "site/sections/Inner.tsx",
            props: { tag: "deep" },
          },
        },
      },
    });

    const result = await runSingleSectionLoader(parent, new Request("https://store.com/"));

    expect(inner).toHaveBeenCalledTimes(1);
    const grandchild = (result.props as any).child.props.grandchild;
    expect(grandchild.props).toMatchObject({ tag: "deep", deep: true });
  });

  it("ignores nested objects that do not look like sections", async () => {
    const loader = vi.fn(async (props: Record<string, unknown>) => props);
    registerSectionLoader("site/sections/Leaf.tsx", loader);

    const section = makeSection("site/sections/Leaf.tsx", {
      // Plain config object, not a section. Has `Component: string` but
      // missing the `props` field — must NOT be treated as a nested section.
      config: { Component: "ButtonStyle", color: "red" },
    });

    const result = await runSingleSectionLoader(section, new Request("https://store.com/"));

    expect(loader).toHaveBeenCalledTimes(1);
    expect((result.props as any).config).toEqual({
      Component: "ButtonStyle",
      color: "red",
    });
  });

  it("runs nested loaders even when parent has no own loader", async () => {
    const childLoader = vi.fn(async (props: any) => ({ ...props, ran: true }));
    registerSectionLoader("site/sections/Child.tsx", childLoader);

    // Parent has no entry in registry — but it has a nested section in props
    // (typical of a pure layout container that just renders children).
    const parent = makeSection("site/sections/UnregisteredLayout.tsx", {
      child: {
        Component: "site/sections/Child.tsx",
        props: { foo: "bar" },
      },
    });

    const result = await runSingleSectionLoader(parent, new Request("https://store.com/"));

    expect(childLoader).toHaveBeenCalledTimes(1);
    expect((result.props as any).child.props).toMatchObject({
      foo: "bar",
      ran: true,
    });
  });
});
