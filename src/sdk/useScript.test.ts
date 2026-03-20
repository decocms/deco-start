import { describe, expect, it } from "vitest";
import { inlineScript, useScript } from "./useScript";

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
