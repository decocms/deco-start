import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HTMX_LEGACY_URL,
  inlineScript,
  usePartialSection,
  useScript,
  useSection,
} from "./useScript";

describe("inlineScript", () => {
  it("returns dangerouslySetInnerHTML with the provided string", () => {
    const result = inlineScript('alert("hello")');
    expect(result).toEqual({
      dangerouslySetInnerHTML: { __html: 'alert("hello")' },
    });
  });

  it("handles empty string", () => {
    const result = inlineScript("");
    expect(result).toEqual({
      dangerouslySetInnerHTML: { __html: "" },
    });
  });

  it("handles multiline scripts", () => {
    const js = `
      const el = document.getElementById("btn");
      el.addEventListener("click", () => { console.log("clicked"); });
    `;
    const result = inlineScript(js);
    expect(result.dangerouslySetInnerHTML.__html).toBe(js);
  });
});

describe("useScript", () => {
  it("serializes a function into an IIFE string", () => {
    function greet(name: string) {
      console.log(name);
    }
    const result = useScript(greet, "world");
    expect(result).toContain("(");
    expect(result).toContain('"world"');
    expect(result).toContain("console.log");
  });

  it("serializes multiple arguments", () => {
    function add(a: number, b: number) {
      return a + b;
    }
    const result = useScript(add, 1, 2);
    expect(result).toContain("1,2");
  });

  it("handles functions with no arguments", () => {
    function noop() {}
    const result = useScript(noop);
    expect(result).toMatch(/^\(.*\)\(\)$/);
  });
});

// ---------------------------------------------------------------------------
// Legacy HTMX stubs — useSection / usePartialSection
// ---------------------------------------------------------------------------

describe("useSection / usePartialSection (legacy HTMX stubs)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let prevNodeEnv: string | undefined;

  beforeEach(() => {
    // Reset the dedup set so each test sees a fresh warning fire.
    delete (globalThis as any).__DECO_LEGACY_HTMX_WARNED;
    prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  });

  it("useSection returns a stable placeholder URL instead of throwing", () => {
    expect(useSection()).toBe(HTMX_LEGACY_URL);
    expect(useSection({ props: { x: 1 } })).toBe(HTMX_LEGACY_URL);
  });

  it("usePartialSection returns the same placeholder URL", () => {
    expect(usePartialSection()).toBe(HTMX_LEGACY_URL);
  });

  it("warns on first call (in development)", () => {
    useSection();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/useSection/);
    expect(warnSpy.mock.calls[0][0]).toMatch(/were removed/);
    expect(warnSpy.mock.calls[0][0]).toMatch(/htmx-residue/);
  });

  it("dedups warnings: a second call to the same stub is silent", () => {
    useSection();
    useSection();
    useSection();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("tracks warnings per-stub: useSection and usePartialSection warn independently", () => {
    useSection();
    usePartialSection();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const messages = warnSpy.mock.calls.map((c) => c[0] as string);
    expect(messages.some((m) => m.includes("useSection"))).toBe(true);
    expect(messages.some((m) => m.includes("usePartialSection"))).toBe(true);
  });

  it("does NOT warn in production", () => {
    process.env.NODE_ENV = "production";
    useSection();
    usePartialSection();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns the placeholder URL even in production (still safe to embed)", () => {
    process.env.NODE_ENV = "production";
    expect(useSection()).toBe(HTMX_LEGACY_URL);
    expect(usePartialSection()).toBe(HTMX_LEGACY_URL);
  });
});
