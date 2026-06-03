import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checks } from "./phase-verify";
import type { MigrationContext } from "./types";

/**
 * The "No relative imports to deleted SDK files" check used to flag any
 * relative import to `sdk/{clx,useId,useOffer,useVariantPossiblities,
 * usePlatform}`. But `useOffer` and `useVariantPossiblities` are KEPT as
 * site files (see RELATIVE_SDK_REWRITES in transforms/imports.ts) — so
 * every site that legitimately imports them via a relative path was
 * failing verify with a misleading error. See #212.
 *
 * Pull the specific check out of the registered array and exercise it on
 * a fixture tree, so we don't have to satisfy the other 24 checks that
 * `verify()` runs at once.
 */

function makeCtx(sourceDir: string): MigrationContext {
  return {
    sourceDir,
    siteName: "test-site",
    platform: "custom",
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
    dryRun: false,
    verbose: false,
  };
}

const sdkCheck = checks.find(
  (c) => c.name === "No relative imports to deleted SDK files",
);
if (!sdkCheck) {
  throw new Error("verify check not found — name changed?");
}

function runCheck(ctx: MigrationContext): { ok: boolean; output: string } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  });
  try {
    const ok = sdkCheck!.fn(ctx);
    return { ok, output: lines.join("\n") };
  } finally {
    spy.mockRestore();
  }
}

describe("verify check: 'No relative imports to deleted SDK files'", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-sdk-"));
    fs.mkdirSync(path.join(tmp, "src", "components"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("passes when src/ imports useOffer/useVariantPossiblities relatively (kept files, #212)", () => {
    fs.writeFileSync(
      path.join(tmp, "src", "components", "ProductCard.tsx"),
      `import { useOffer } from "../../sdk/useOffer";\n` +
        `import { useVariantPossibilities } from "../../sdk/useVariantPossiblities";\n` +
        `export const x = 1;\n`,
    );
    const { ok, output } = runCheck(makeCtx(tmp));
    expect(ok).toBe(true);
    expect(output).toBe("");
  });

  it("fails when src/ imports clx/useId/usePlatform relatively (truly deleted)", () => {
    fs.writeFileSync(
      path.join(tmp, "src", "components", "Bad.tsx"),
      `import { clx } from "../../sdk/clx";\n` +
        `import { useId } from "../../sdk/useId";\n` +
        `import { usePlatform } from "../../sdk/usePlatform";\n` +
        `export const x = 1;\n`,
    );
    const { ok, output } = runCheck(makeCtx(tmp));
    expect(ok).toBe(false);
    // The improved error reports each offending line, not just the file.
    expect(output).toMatch(/components\/Bad\.tsx:.*sdk\/clx/);
    expect(output).toMatch(/components\/Bad\.tsx:.*sdk\/useId/);
    expect(output).toMatch(/components\/Bad\.tsx:.*sdk\/usePlatform/);
  });

  it("ignores commented-out references to deleted SDK files", () => {
    fs.writeFileSync(
      path.join(tmp, "src", "components", "Docs.tsx"),
      `// import { clx } from "../../sdk/clx"\n` +
        `// from "../../sdk/useId"\n` +
        `export const x = 1;\n`,
    );
    const { ok } = runCheck(makeCtx(tmp));
    expect(ok).toBe(true);
  });

  it("matches both .ts-suffixed and unsuffixed import paths", () => {
    fs.writeFileSync(
      path.join(tmp, "src", "components", "WithExt.tsx"),
      `import { clx } from "../../sdk/clx.ts";\nexport const x = 1;\n`,
    );
    const { ok } = runCheck(makeCtx(tmp));
    expect(ok).toBe(false);
  });
});
