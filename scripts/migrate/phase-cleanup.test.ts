import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeImportedLibShims } from "./phase-cleanup";
import type { MigrationContext } from "./types";

/**
 * Build a minimal `MigrationContext` for integration tests of
 * `writeImportedLibShims`. Only the fields that function reads are
 * non-default; everything else is a placeholder with the right shape.
 */
function makeCtx(sourceDir: string, dryRun = false): MigrationContext {
  return {
    sourceDir,
    siteName: "test-site",
    platform: "vtex",
    vtexAccount: null,
    gtmId: null,
    importMap: {},
    discoveredNpmDeps: {},
    themeColors: {},
    fontFamily: null,
    files: [],
    sectionMetas: [],
    islandClassifications: [],
    islandWrapperTargets: new Map(),
    loaderInventory: [],
    scaffoldedFiles: [],
    transformedFiles: [],
    deletedFiles: [],
    movedFiles: [],
    manualReviewItems: [],
    frameworkFindings: [],
    dryRun,
    verbose: false,
  };
}

describe("writeImportedLibShims (integration)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lazy-shim-test-"));
    fs.mkdirSync(path.join(tmpDir, "src", "loaders"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes nothing when no ~/lib imports are found", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "loaders", "products.ts"),
      `import { something } from "@decocms/apps/vtex";\nexport const x = 1;\n`,
    );

    writeImportedLibShims(makeCtx(tmpDir));

    expect(fs.existsSync(path.join(tmpDir, "src", "lib"))).toBe(false);
  });

  it("writes only the shim files matching imports actually present in src/", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "loaders", "search.ts"),
      `import { getSegmentFromBag } from "~/lib/vtex-segment";\n` +
        `import { toFilterSearchString } from "~/lib/filter-navigate";\n`,
    );

    writeImportedLibShims(makeCtx(tmpDir));

    const libDir = path.join(tmpDir, "src", "lib");
    expect(fs.existsSync(libDir)).toBe(true);
    const written = fs.readdirSync(libDir).sort();
    expect(written).toEqual(["filter-navigate.ts", "vtex-segment.ts"]);
  });

  it("writes nothing in dry-run mode (but does not throw)", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "loaders", "search.ts"),
      `import { getSegmentFromBag } from "~/lib/vtex-segment";\n`,
    );

    writeImportedLibShims(makeCtx(tmpDir, /* dryRun */ true));

    expect(fs.existsSync(path.join(tmpDir, "src", "lib"))).toBe(false);
  });

  it("strips trailing .ts from the import specifier when scanning", () => {
    // Some Fresh sites use explicit .ts extensions in their imports.
    fs.writeFileSync(
      path.join(tmpDir, "src", "loaders", "search.ts"),
      `import { fn } from "~/lib/vtex-transform.ts";\n`,
    );

    writeImportedLibShims(makeCtx(tmpDir));

    expect(
      fs.existsSync(path.join(tmpDir, "src", "lib", "vtex-transform.ts")),
    ).toBe(true);
  });

  it("ignores imports inside the lib dir itself (no self-amplification)", () => {
    fs.mkdirSync(path.join(tmpDir, "src", "lib"));
    fs.writeFileSync(
      path.join(tmpDir, "src", "lib", "existing.ts"),
      `import { x } from "~/lib/should-not-be-generated";\nexport const y = 1;\n`,
    );

    writeImportedLibShims(makeCtx(tmpDir));

    // Only the existing file should remain; nothing new generated.
    const files = fs.readdirSync(path.join(tmpDir, "src", "lib"));
    expect(files).toEqual(["existing.ts"]);
  });

  it("scans .tsx files too, not just .ts", () => {
    fs.mkdirSync(path.join(tmpDir, "src", "components"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "components", "Filter.tsx"),
      `import { toFilterSearchString } from "~/lib/filter-navigate";\n` +
        `export const C = () => null;\n`,
    );

    writeImportedLibShims(makeCtx(tmpDir));

    expect(
      fs.existsSync(path.join(tmpDir, "src", "lib", "filter-navigate.ts")),
    ).toBe(true);
  });

  it("does nothing when src/ does not exist", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "no-src-"));
    try {
      writeImportedLibShims(makeCtx(empty));
      expect(fs.readdirSync(empty)).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
