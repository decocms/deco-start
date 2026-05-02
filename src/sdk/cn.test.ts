import { describe, expect, it } from "vitest";
import { clx, cn } from "./cn";

describe("cn", () => {
  it("joins strings", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("supports conditional objects", () => {
    expect(cn("a", { b: true, c: false }, "d")).toBe("a b d");
  });

  it("filters out falsy values", () => {
    expect(cn("a", null, undefined, false, 0 as any, "b")).toBe("a b");
  });

  it("merges conflicting Tailwind utilities (last one wins)", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("merges hover variants independently from base utilities", () => {
    expect(cn("p-2", "hover:p-4")).toBe("p-2 hover:p-4");
  });
});

describe("clx (re-exported)", () => {
  it("filters falsy and joins with single spaces", () => {
    expect(clx("a", null, "b", undefined, "c")).toBe("a b c");
  });

  it("does NOT merge conflicting utilities (that's cn's job)", () => {
    expect(clx("p-2", "p-4")).toBe("p-2 p-4");
  });
});
