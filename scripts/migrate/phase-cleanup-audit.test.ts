/**
 * Tests for Phase 9 (cleanup audit integration into migrate.ts).
 *
 * These exercise the wrapper logic — what it prints, when it fails,
 * how it interacts with --strict and dry-run. The underlying audit
 * rules are tested separately in post-cleanup/runner.test.ts; we
 * stub the disk minimally here just to drive findings counts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupAudit } from "./phase-cleanup-audit";
import { createContext } from "./types";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deco-migrate-audit-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(overrides?: { dryRun?: boolean }) {
  return createContext(tmpDir, {
    dryRun: overrides?.dryRun ?? false,
    verbose: false,
  });
}

describe("cleanupAudit — dry-run", () => {
  it("is a no-op in dry-run mode (returns false, no console output)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeCtx({ dryRun: true });
    const failed = cleanupAudit(ctx);
    expect(failed).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("cleanupAudit — empty site", () => {
  it("prints success and returns false when there are no findings", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeCtx();
    const failed = cleanupAudit(ctx);
    expect(failed).toBe(false);
    const out = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toMatch(/No findings/);
    spy.mockRestore();
  });
});

describe("cleanupAudit — info-only findings (e.g. local widgets.ts)", () => {
  beforeEach(() => {
    // Set up a finding for rule 6 (local-widgets-types):
    // need src/types/widgets.ts + at least one importer.
    fs.mkdirSync(path.join(tmpDir, "src", "types"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "types", "widgets.ts"),
      "export type ImageWidget = string;\n",
    );
    fs.mkdirSync(path.join(tmpDir, "src", "sections"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "sections", "Foo.tsx"),
      'import type { ImageWidget } from "~/types/widgets";\nexport const x: ImageWidget = "y";\n',
    );
  });

  it("prints the finding and returns false (info doesn't fail strict)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeCtx();
    const failed = cleanupAudit(ctx, { strict: true });
    expect(failed).toBe(false);
    const out = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toMatch(/Local src\/types\/widgets\.ts/);
    expect(out).toMatch(/widgets\.ts/);
    expect(out).toMatch(/deco-post-cleanup --fix/);
    spy.mockRestore();
  });
});

describe("cleanupAudit — warning findings (vtex-shim-regression)", () => {
  beforeEach(() => {
    // Trigger rule 5 (vtex-shim-regression, warning severity):
    // any file outside src/lib/ that imports from ~/lib/vtex-*.
    fs.mkdirSync(path.join(tmpDir, "src", "loaders"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "loaders", "Product.ts"),
      'import { fetchSafe } from "~/lib/vtex-fetch";\nexport default fetchSafe;\n',
    );
  });

  it("returns false in non-strict mode even with warning findings", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeCtx();
    const failed = cleanupAudit(ctx, { strict: false });
    expect(failed).toBe(false);
    spy.mockRestore();
  });

  it("returns true in --strict mode when warning findings exist", () => {
    const spyLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeCtx();
    const failed = cleanupAudit(ctx, { strict: true });
    expect(failed).toBe(true);
    const out = spyLog.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toMatch(/--strict/);
    expect(out).toMatch(/failed the audit/);
    spyLog.mockRestore();
  });
});

describe("cleanupAudit — output truncation", () => {
  beforeEach(() => {
    // Fabricate >5 vtex-shim-regression findings to test the cap.
    fs.mkdirSync(path.join(tmpDir, "src", "loaders"), { recursive: true });
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(
        path.join(tmpDir, "src", "loaders", `Loader${i}.ts`),
        'import { fetchSafe } from "~/lib/vtex-fetch";\n',
      );
    }
  });

  it("caps per-rule output at 5 with a 'and N more' suffix", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeCtx();
    cleanupAudit(ctx);
    const out = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toMatch(/and 3 more/);
    spy.mockRestore();
  });
});
