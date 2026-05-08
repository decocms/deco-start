/**
 * Smoke tests for the `migrate-to-cf-observability.ts` codemod.
 *
 * Drives the script as a child process against tmp wrangler.jsonc fixtures.
 * Verifies the three behaviors that matter operationally:
 *  - replacing an existing `observability.logs` block (lebiscuit shape)
 *  - appending a new `observability` block when none exists
 *  - second run is a no-op (idempotency / CI guard)
 *  - result is valid JSONC (parses after stripping comments)
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "migrate-to-cf-observability.ts");

function runCodemod(args: string[]): { stdout: string; stderr: string; code: number } {
  const r = cp.spawnSync("npx", ["tsx", SCRIPT, ...args], { encoding: "utf8" });
  return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status ?? 0 };
}

function stripJsoncComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("migrate-to-cf-observability codemod", () => {
  let tmpDir: string;
  let wranglerPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-codemod-"));
    wranglerPath = path.join(tmpDir, "wrangler.jsonc");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replaces an existing observability.logs block in lebiscuit-shape config", () => {
    fs.writeFileSync(
      wranglerPath,
      `{
  "name": "lebiscuit-tanstack",
  "compatibility_date": "2026-02-14",
  "main": "./src/worker-entry.ts",
  "kv_namespaces": [{ "binding": "SITES_KV", "id": "abc" }],
  "version_metadata": { "binding": "CF_VERSION_METADATA" },
  "analytics_engine_datasets": [
    { "binding": "DECO_METRICS", "dataset": "deco_metrics_lebiscuit" }
  ],
  "observability": {
    "logs": {
      "enabled": true,
      "invocation_logs": true
    }
  }
}
`,
    );

    const r = runCodemod(["--source", tmpDir, "--write"]);
    expect(r.code).toBe(0);

    const result = fs.readFileSync(wranglerPath, "utf8");
    expect(result).toContain('"destinations": ["hyperdx-logs"]');
    expect(result).toContain('"destinations": ["hyperdx-traces"]');
    expect(result).toContain('"head_sampling_rate": 0.1');

    // Result must be valid JSONC.
    expect(() => JSON.parse(stripJsoncComments(result))).not.toThrow();

    // Original key context preserved.
    expect(result).toContain('"name": "lebiscuit-tanstack"');
    expect(result).toContain('"binding": "DECO_METRICS"');
  });

  it("appends a new observability block when none exists", () => {
    fs.writeFileSync(
      wranglerPath,
      `{
  "name": "fresh-site",
  "compatibility_date": "2026-02-14",
  "main": "./src/worker-entry.ts"
}
`,
    );

    const r = runCodemod(["--source", tmpDir, "--write"]);
    expect(r.code).toBe(0);

    const result = fs.readFileSync(wranglerPath, "utf8");
    expect(result).toContain('"observability"');
    expect(result).toContain('"destinations": ["hyperdx-logs"]');
    expect(() => JSON.parse(stripJsoncComments(result))).not.toThrow();
  });

  it("is idempotent: second run is a no-op", () => {
    fs.writeFileSync(
      wranglerPath,
      `{
  "name": "lebiscuit-tanstack",
  "main": "./src/worker-entry.ts",
  "observability": {
    "logs": { "enabled": true }
  }
}
`,
    );

    runCodemod(["--source", tmpDir, "--write"]);
    const after1 = fs.readFileSync(wranglerPath, "utf8");

    const r = runCodemod(["--source", tmpDir, "--write"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("already on CF-native");

    const after2 = fs.readFileSync(wranglerPath, "utf8");
    expect(after2).toBe(after1);
  });

  it("dry-run exits 1 and does not modify the file (CI signal)", () => {
    const before = `{
  "name": "site",
  "main": "./src/worker-entry.ts"
}
`;
    fs.writeFileSync(wranglerPath, before);

    const r = runCodemod(["--source", tmpDir]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Dry-run");

    expect(fs.readFileSync(wranglerPath, "utf8")).toBe(before);
  });

  it("respects --logs / --traces / --traces-rate / --persist flags", () => {
    fs.writeFileSync(
      wranglerPath,
      `{
  "name": "site",
  "main": "./src/worker-entry.ts"
}
`,
    );

    runCodemod([
      "--source",
      tmpDir,
      "--logs",
      "my-logs",
      "--traces",
      "my-traces",
      "--traces-rate",
      "0.05",
      "--persist",
      "--write",
    ]);

    const result = fs.readFileSync(wranglerPath, "utf8");
    expect(result).toContain('"destinations": ["my-logs"]');
    expect(result).toContain('"destinations": ["my-traces"]');
    expect(result).toContain('"head_sampling_rate": 0.05');
    // Both blocks set persist:true (no logs-only persist flag).
    const persistTrueCount = (result.match(/"persist": true/g) ?? []).length;
    expect(persistTrueCount).toBe(2);
  });
}, 30_000);
