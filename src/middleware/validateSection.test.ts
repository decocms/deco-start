import { describe, expect, it } from "vitest";
import {
  createSectionValidator,
  validateDeferredSectionInput,
} from "./validateSection";

describe("validateDeferredSectionInput", () => {
  it("accepts valid input", () => {
    const result = validateDeferredSectionInput({
      component: "site/sections/ProductShelf.tsx",
      rawProps: { title: "Best Sellers" },
      pagePath: "/",
    });
    expect(result.component).toBe("site/sections/ProductShelf.tsx");
    expect(result.rawProps).toEqual({ title: "Best Sellers" });
    expect(result.pagePath).toBe("/");
    expect(result.pageUrl).toBeUndefined();
  });

  it("accepts input with optional pageUrl", () => {
    const result = validateDeferredSectionInput({
      component: "site/sections/Hero.tsx",
      rawProps: {},
      pagePath: "/home",
      pageUrl: "https://store.com/home?ref=nav",
    });
    expect(result.pageUrl).toBe("https://store.com/home?ref=nav");
  });

  it("throws on null input", () => {
    expect(() => validateDeferredSectionInput(null)).toThrow("Expected an object");
  });

  it("throws on undefined input", () => {
    expect(() => validateDeferredSectionInput(undefined)).toThrow("Expected an object");
  });

  it("throws on string input", () => {
    expect(() => validateDeferredSectionInput("nope")).toThrow("Expected an object");
  });

  it("throws when component is missing", () => {
    expect(() =>
      validateDeferredSectionInput({ rawProps: {}, pagePath: "/" }),
    ).toThrow("component");
  });

  it("throws when component is not a string", () => {
    expect(() =>
      validateDeferredSectionInput({ component: 123, rawProps: {}, pagePath: "/" }),
    ).toThrow("component");
  });

  it("throws when rawProps is missing", () => {
    expect(() =>
      validateDeferredSectionInput({ component: "X", pagePath: "/" }),
    ).toThrow("rawProps");
  });

  it("throws when rawProps is an array", () => {
    expect(() =>
      validateDeferredSectionInput({ component: "X", rawProps: [1, 2], pagePath: "/" }),
    ).toThrow("rawProps");
  });

  it("throws when rawProps is null", () => {
    expect(() =>
      validateDeferredSectionInput({ component: "X", rawProps: null, pagePath: "/" }),
    ).toThrow("rawProps");
  });

  it("throws when pagePath is missing", () => {
    expect(() =>
      validateDeferredSectionInput({ component: "X", rawProps: {} }),
    ).toThrow("pagePath");
  });

  it("throws when pageUrl is not a string", () => {
    expect(() =>
      validateDeferredSectionInput({
        component: "X",
        rawProps: {},
        pagePath: "/",
        pageUrl: 42,
      }),
    ).toThrow("pageUrl");
  });
});

describe("createSectionValidator", () => {
  it("passes when all required fields present", () => {
    const validate = createSectionValidator(["title", "maxItems"]);
    const result = validate({ title: "Shelf", maxItems: 8 });
    expect(result).toEqual({ title: "Shelf", maxItems: 8 });
  });

  it("throws when a required field is missing", () => {
    const validate = createSectionValidator(["title", "maxItems"]);
    expect(() => validate({ title: "Shelf" })).toThrow("maxItems");
  });

  it("throws on null input", () => {
    const validate = createSectionValidator(["title"]);
    expect(() => validate(null)).toThrow("Expected an object");
  });

  it("allows extra fields", () => {
    const validate = createSectionValidator(["title"]);
    const result = validate({ title: "Hi", extra: true });
    expect(result).toEqual({ title: "Hi", extra: true });
  });

  it("empty required fields always passes for objects", () => {
    const validate = createSectionValidator([]);
    expect(validate({})).toEqual({});
  });
});
