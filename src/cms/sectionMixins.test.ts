/**
 * Section mixins — focused on `withSectionLoader` since the device/mobile
 * mixins are exercised by sectionLoaders integration tests already.
 */
import { describe, expect, it, vi } from "vitest";
import {
  compose,
  withDevice,
  withMobile,
  withSearchParam,
  withSectionLoader,
} from "./sectionMixins";

// `__requestDependent` is the runtime tag the framework reads in
// `registerSectionLoaders` to decide whether to emit the layout-cache
// contamination warning (#206). Any future mixin that depends on the
// request must opt in by setting this flag — and `compose` must propagate
// it whenever any input has it.
const isRequestDependent = (fn: unknown): boolean =>
  typeof fn === "function" &&
  (fn as { __requestDependent?: boolean }).__requestDependent === true;

const makeReq = (url = "https://store.example/foo?q=hello") =>
  new Request(url, { headers: { "user-agent": "vitest" } });

describe("withSectionLoader", () => {
  it("invokes the section's exported loader and returns its result", async () => {
    const loader = vi.fn(async (props: Record<string, unknown>) => ({
      ...props,
      url: "https://store.example/foo?q=hello",
      enriched: true,
    }));

    const mixin = withSectionLoader(async () => ({ loader }));
    const result = await mixin({ original: "value" }, makeReq());

    expect(loader).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      original: "value",
      url: "https://store.example/foo?q=hello",
      enriched: true,
    });
  });

  it("returns props unchanged when module has no loader export", async () => {
    const mixin = withSectionLoader(async () => ({ default: () => null }));
    const props = { foo: "bar" };
    const result = await mixin(props, makeReq());
    expect(result).toBe(props);
  });

  it("returns props unchanged when module is undefined / loader is not a function", async () => {
    const mixin = withSectionLoader(async () => undefined);
    const props = { foo: "bar" };
    expect(await mixin(props, makeReq())).toBe(props);

    const mixinWithBadLoader = withSectionLoader(async () => ({
      loader: "not-a-function",
    }));
    expect(await mixinWithBadLoader(props, makeReq())).toBe(props);
  });

  it("swallows loader errors and returns the original props", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mixin = withSectionLoader(async () => ({
      loader: async () => {
        throw new Error("boom");
      },
    }));
    const props = { foo: "bar" };
    const result = await mixin(props, makeReq());
    expect(result).toBe(props);
    expect(errorSpy).toHaveBeenCalledWith(
      "[withSectionLoader] section loader threw:",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("falls back to original props when loader returns undefined", async () => {
    const mixin = withSectionLoader(async () => ({
      loader: async () => undefined,
    }));
    const props = { foo: "bar" };
    expect(await mixin(props, makeReq())).toBe(props);
  });

  it("composes alongside mixins: mixins run first, then the section loader sees the enriched props", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const sectionLoader = vi.fn(
      async (props: Record<string, unknown>) => {
        seen.push({ ...props });
        return { ...props, sectionLoaderRan: true };
      },
    );

    const composed = compose(
      withSearchParam(),
      withSectionLoader(async () => ({ loader: sectionLoader })),
    );

    const result = await composed({ original: 1 }, makeReq());

    expect(seen).toHaveLength(1);
    // The section loader sees the enriched props (currentSearchParam injected by withSearchParam)
    expect(seen[0]).toMatchObject({
      original: 1,
      currentSearchParam: "hello",
    });
    expect(result).toMatchObject({
      original: 1,
      currentSearchParam: "hello",
      sectionLoaderRan: true,
    });
  });

  it("loads the module lazily — modImport is only called on first invocation", async () => {
    const modImport = vi.fn(async () => ({
      loader: async (p: Record<string, unknown>) => ({ ...p, ran: true }),
    }));
    const mixin = withSectionLoader(modImport);
    expect(modImport).not.toHaveBeenCalled();

    await mixin({ a: 1 }, makeReq());
    expect(modImport).toHaveBeenCalledTimes(1);

    // A second invocation calls the import again — caching is the
    // dynamic import's responsibility (which the runtime memoises).
    await mixin({ a: 2 }, makeReq());
    expect(modImport).toHaveBeenCalledTimes(2);
  });
});

describe("request-dependent tagging (#206)", () => {
  it("tags withDevice", () => {
    expect(isRequestDependent(withDevice())).toBe(true);
  });

  it("tags withMobile", () => {
    expect(isRequestDependent(withMobile())).toBe(true);
  });

  it("tags withSearchParam", () => {
    expect(isRequestDependent(withSearchParam())).toBe(true);
  });

  it("does NOT tag withSectionLoader (its loader may or may not touch req)", () => {
    expect(isRequestDependent(withSectionLoader(async () => ({})))).toBe(false);
  });

  it("compose propagates the flag when any input is request-dependent", () => {
    expect(isRequestDependent(compose(withDevice(), async (p) => p))).toBe(true);
    expect(isRequestDependent(compose(async (p) => p, withSearchParam()))).toBe(true);
  });

  it("compose does NOT set the flag when no input is request-dependent", () => {
    expect(isRequestDependent(compose(async (p) => p, async (p) => p))).toBe(false);
  });

  it("empty compose() is not request-dependent", () => {
    expect(isRequestDependent(compose())).toBe(false);
  });
});
