import { describe, expect, it } from "vitest";
import {
  LIB_TEMPLATES,
  selectImportedLibTemplates,
} from "./lib-utils";

describe("LIB_TEMPLATES registry", () => {
  it("has entries", () => {
    expect(Object.keys(LIB_TEMPLATES).length).toBeGreaterThan(0);
  });

  it("uses src/lib/<name>.ts keys (relative paths the writer expects)", () => {
    for (const key of Object.keys(LIB_TEMPLATES)) {
      expect(key).toMatch(/^src\/lib\/[a-z][a-z0-9-]*\.ts$/);
    }
  });

  it("has non-empty contents for every entry", () => {
    for (const [key, value] of Object.entries(LIB_TEMPLATES)) {
      expect(value, `${key} should have content`).toBeTruthy();
      expect(value.length, `${key} length`).toBeGreaterThan(20);
    }
  });

  it("has unique keys (no shadowing)", () => {
    const keys = Object.keys(LIB_TEMPLATES);
    const set = new Set(keys);
    expect(set.size).toBe(keys.length);
  });
});

describe("selectImportedLibTemplates()", () => {
  it("returns empty record when no specifiers are imported", () => {
    expect(selectImportedLibTemplates(new Set())).toEqual({});
  });

  it("returns only the templates whose specifier is in the set", () => {
    const result = selectImportedLibTemplates(new Set(["vtex-segment"]));
    expect(Object.keys(result)).toEqual(["src/lib/vtex-segment.ts"]);
    expect(result["src/lib/vtex-segment.ts"]).toBe(LIB_TEMPLATES["src/lib/vtex-segment.ts"]);
  });

  it("returns multiple templates when multiple specifiers are imported", () => {
    const result = selectImportedLibTemplates(
      new Set(["vtex-segment", "vtex-transform", "filter-navigate"]),
    );
    const keys = Object.keys(result).sort();
    expect(keys).toEqual([
      "src/lib/filter-navigate.ts",
      "src/lib/vtex-segment.ts",
      "src/lib/vtex-transform.ts",
    ]);
  });

  it("ignores unknown specifiers without throwing", () => {
    const result = selectImportedLibTemplates(
      new Set(["vtex-segment", "this-template-does-not-exist"]),
    );
    expect(Object.keys(result)).toEqual(["src/lib/vtex-segment.ts"]);
  });

  it("does not mutate LIB_TEMPLATES (returns a fresh object)", () => {
    const before = JSON.stringify(LIB_TEMPLATES);
    const result = selectImportedLibTemplates(new Set(["vtex-segment"]));
    result["src/lib/vtex-segment.ts"] = "// HIJACKED";
    expect(JSON.stringify(LIB_TEMPLATES)).toBe(before);
  });

  it("covers every well-known migration target the writer might emit", () => {
    // Sanity check: the names that `transforms/imports.ts` rewrites to
    // and that phase-cleanup hoists for inline-stub injection MUST all
    // have templates registered, otherwise migrated sites get import
    // errors with no warning.
    const expectedSpecifiers = [
      "vtex-transform",
      "vtex-intelligent-search",
      "vtex-segment",
      "vtex-fetch",
      "vtex-id",
      "vtex-client",
      "fetch-utils",
      "http-utils",
      "graphql-utils",
      "filter-navigate",
    ];
    for (const spec of expectedSpecifiers) {
      const key = `src/lib/${spec}.ts`;
      expect(LIB_TEMPLATES, `expected template for ${key}`).toHaveProperty(key);
    }
  });
});
