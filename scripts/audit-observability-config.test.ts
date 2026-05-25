import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  auditFleetBindings,
  auditObservabilityBlock,
  auditWranglerConfig,
} from "./audit-observability-config";
import { parseJsonc, stripJsoncTrailingCommas } from "./lib/jsonc";

describe("auditObservabilityBlock", () => {
  it("flags missing observability block as error", () => {
    const findings = auditObservabilityBlock(undefined);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("observability_missing");
    expect(findings[0].severity).toBe("error");
    expect(findings[0].fix).toContain("deco-cf-observability --write");
  });

  it("returns no findings for canonical block (traces 0.01, logs 1, persist)", () => {
    const findings = auditObservabilityBlock({
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 1, persist: true },
      traces: { enabled: true, head_sampling_rate: 0.01, persist: true },
    });
    expect(findings).toEqual([]);
  });

  it("flags head_sampling_rate_elevated as error when traces rate > 0.01", () => {
    const findings = auditObservabilityBlock({
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 1, persist: true },
      traces: { enabled: true, head_sampling_rate: 0.1, persist: true },
    });
    const elevated = findings.find((f) => f.id === "head_sampling_rate_elevated");
    expect(elevated).toBeDefined();
    expect(elevated?.severity).toBe("error");
    expect(elevated?.message).toContain("0.1");
    expect(elevated?.fix).toContain("--traces-rate 0.01");
  });

  it("does not flag boundary value 0.01", () => {
    const findings = auditObservabilityBlock({
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 1, persist: true },
      traces: { enabled: true, head_sampling_rate: 0.01, persist: true },
    });
    expect(findings.find((f) => f.id === "head_sampling_rate_elevated")).toBeUndefined();
  });

  it("flags observability_disabled when enabled: false at the top", () => {
    const findings = auditObservabilityBlock({
      enabled: false,
      logs: { enabled: true, head_sampling_rate: 1, persist: true },
      traces: { enabled: true, head_sampling_rate: 0.01, persist: true },
    });
    const f = findings.find((x) => x.id === "observability_disabled");
    expect(f?.severity).toBe("error");
  });

  it("flags traces_disabled and logs_disabled separately", () => {
    const findings = auditObservabilityBlock({
      enabled: true,
      logs: { enabled: false, head_sampling_rate: 1, persist: true },
      traces: { enabled: false, head_sampling_rate: 0.01, persist: true },
    });
    expect(findings.some((f) => f.id === "traces_disabled" && f.severity === "warn")).toBe(true);
    expect(findings.some((f) => f.id === "logs_disabled" && f.severity === "warn")).toBe(true);
  });

  it("flags logs_head_sampling_rate_low when logs rate < 1", () => {
    const findings = auditObservabilityBlock({
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 0.5, persist: true },
      traces: { enabled: true, head_sampling_rate: 0.01, persist: true },
    });
    const f = findings.find((x) => x.id === "logs_head_sampling_rate_low");
    expect(f?.severity).toBe("warn");
  });

  it("flags persist_disabled_no_destination on traces", () => {
    const findings = auditObservabilityBlock({
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 1, persist: true },
      traces: { enabled: true, head_sampling_rate: 0.01, persist: false },
    });
    const f = findings.find((x) => x.id === "persist_disabled_no_destination");
    expect(f?.severity).toBe("error");
  });

  it("accepts persist:false when a destination is configured", () => {
    const findings = auditObservabilityBlock({
      enabled: true,
      logs: {
        enabled: true,
        head_sampling_rate: 1,
        persist: false,
        destinations: [{ id: "my-logs-dest" }],
      },
      traces: {
        enabled: true,
        head_sampling_rate: 0.01,
        persist: false,
        destinations: [{ id: "my-traces-dest" }],
      },
    });
    expect(findings).toEqual([]);
  });

  it("does not flag persist on a disabled traces block", () => {
    const findings = auditObservabilityBlock({
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 1, persist: true },
      traces: { enabled: false, head_sampling_rate: 0.01, persist: false },
    });
    // traces_disabled fires, but not persist_disabled_no_destination for traces
    expect(findings.find((f) => f.id === "persist_disabled_no_destination")).toBeUndefined();
  });

  it("treats absent head_sampling_rate as not-elevated (no false positive)", () => {
    const findings = auditObservabilityBlock({
      enabled: true,
      logs: { enabled: true, persist: true },
      traces: { enabled: true, persist: true },
    });
    expect(findings.find((f) => f.id === "head_sampling_rate_elevated")).toBeUndefined();
    expect(findings.find((f) => f.id === "logs_head_sampling_rate_low")).toBeUndefined();
  });

  it("stacks multiple findings on a deeply-broken config", () => {
    const findings = auditObservabilityBlock({
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 0.1, persist: false },
      traces: { enabled: true, head_sampling_rate: 0.5, persist: false },
    });
    const ids = findings.map((f) => f.id).sort();
    expect(ids).toContain("head_sampling_rate_elevated");
    expect(ids).toContain("logs_head_sampling_rate_low");
    // both traces and logs each emit a persist_disabled_no_destination
    expect(ids.filter((i) => i === "persist_disabled_no_destination")).toHaveLength(2);
  });
});

describe("auditFleetBindings (D-14)", () => {
  const canonicalBindings = {
    version_metadata: { binding: "CF_VERSION_METADATA" },
    analytics_engine_datasets: [{ binding: "DECO_METRICS", dataset: "deco_metrics_site" }],
    tail_consumers: [{ service: "deco-otel-tail" }],
    vars: {
      DECO_OTEL_METRICS_ENDPOINT: "https://deco-otel-ingest.example/v1/metrics",
      DECO_OTEL_TRACES_ENDPOINT: "https://deco-otel-ingest.example/v1/traces",
      DECO_OTEL_LOGS_ENDPOINT: "https://deco-otel-ingest.example/v1/logs",
    },
  };

  it("returns no findings for canonical bindings", () => {
    expect(auditFleetBindings(canonicalBindings)).toEqual([]);
  });

  it("flags version_metadata_binding_missing as error", () => {
    const { version_metadata: _, ...rest } = canonicalBindings;
    const findings = auditFleetBindings(rest);
    const f = findings.find((x) => x.id === "version_metadata_binding_missing");
    expect(f?.severity).toBe("error");
  });

  it("flags version_metadata_binding_missing when binding is empty", () => {
    const findings = auditFleetBindings({
      ...canonicalBindings,
      version_metadata: { binding: "" },
    });
    const f = findings.find((x) => x.id === "version_metadata_binding_missing");
    expect(f).toBeDefined();
  });

  it("flags analytics_engine_binding_missing as warn", () => {
    const findings = auditFleetBindings({
      ...canonicalBindings,
      analytics_engine_datasets: [],
    });
    const f = findings.find((x) => x.id === "analytics_engine_binding_missing");
    expect(f?.severity).toBe("warn");
  });

  it("flags analytics_engine_binding_missing when binding name doesn't match DECO_METRICS", () => {
    const findings = auditFleetBindings({
      ...canonicalBindings,
      analytics_engine_datasets: [{ binding: "OTHER_NAME" }],
    });
    expect(findings.some((f) => f.id === "analytics_engine_binding_missing")).toBe(true);
  });

  it("flags tail_consumer_missing as error", () => {
    const findings = auditFleetBindings({
      ...canonicalBindings,
      tail_consumers: [],
    });
    const f = findings.find((x) => x.id === "tail_consumer_missing");
    expect(f?.severity).toBe("error");
  });

  it("flags tail_consumer_missing when an unrelated tail consumer is configured", () => {
    const findings = auditFleetBindings({
      ...canonicalBindings,
      tail_consumers: [{ service: "another-tail" }],
    });
    expect(findings.some((f) => f.id === "tail_consumer_missing")).toBe(true);
  });

  it("flags otel_metrics_endpoint_missing when DECO_OTEL_METRICS_ENDPOINT is unset", () => {
    const findings = auditFleetBindings({
      ...canonicalBindings,
      vars: {
        ...canonicalBindings.vars,
        DECO_OTEL_METRICS_ENDPOINT: "",
      },
    });
    expect(findings.some((f) => f.id === "otel_metrics_endpoint_missing")).toBe(true);
  });

  it("flags otel_traces_endpoint_missing when DECO_OTEL_TRACES_ENDPOINT is missing", () => {
    const { vars: _vars, ...rest } = canonicalBindings;
    const findings = auditFleetBindings(rest);
    expect(findings.some((f) => f.id === "otel_traces_endpoint_missing")).toBe(true);
    expect(findings.some((f) => f.id === "otel_logs_endpoint_missing")).toBe(true);
    expect(findings.some((f) => f.id === "otel_metrics_endpoint_missing")).toBe(true);
  });

  it("handles missing vars object gracefully", () => {
    expect(() => auditFleetBindings({ vars: undefined })).not.toThrow();
  });
});

describe("auditWranglerConfig — composition", () => {
  it("composes observability + fleet rules", () => {
    const findings = auditWranglerConfig({});
    const ids = findings.map((f) => f.id);
    expect(ids).toContain("observability_missing");
    expect(ids).toContain("version_metadata_binding_missing");
    expect(ids).toContain("tail_consumer_missing");
  });

  it("returns no findings on a fully canonical wrangler", () => {
    const findings = auditWranglerConfig({
      observability: {
        enabled: true,
        logs: { enabled: true, head_sampling_rate: 1, persist: true },
        traces: { enabled: true, head_sampling_rate: 0.01, persist: true },
      },
      version_metadata: { binding: "CF_VERSION_METADATA" },
      analytics_engine_datasets: [{ binding: "DECO_METRICS", dataset: "deco_metrics_x" }],
      tail_consumers: [{ service: "deco-otel-tail" }],
      vars: {
        DECO_OTEL_METRICS_ENDPOINT: "https://ingest.example/v1/metrics",
        DECO_OTEL_TRACES_ENDPOINT: "https://ingest.example/v1/traces",
        DECO_OTEL_LOGS_ENDPOINT: "https://ingest.example/v1/logs",
      },
    });
    expect(findings).toEqual([]);
  });
});

describe("JSONC handling — trailing commas + comments", () => {
  it("stripJsoncTrailingCommas removes commas before `}` and `]`", () => {
    expect(stripJsoncTrailingCommas(`{ "a": 1, "b": 2, }`)).toBe(`{ "a": 1, "b": 2 }`);
    expect(stripJsoncTrailingCommas(`{ "a": [1, 2, 3,], }`)).toBe(`{ "a": [1, 2, 3] }`);
  });

  it("stripJsoncTrailingCommas preserves commas INSIDE string literals", () => {
    expect(stripJsoncTrailingCommas(`{ "a": "hello,], world", }`)).toBe(
      `{ "a": "hello,], world" }`,
    );
  });

  it("parseJsonc accepts both line comments and trailing commas", () => {
    const src = `{
      // a wrangler.jsonc-style config
      "observability": {
        "enabled": true,
        "traces": { "enabled": true, "head_sampling_rate": 0.01, "persist": true, },
        "logs":   { "enabled": true, "head_sampling_rate": 1,    "persist": true, },
      },
    }`;
    expect(parseJsonc<{ observability: { enabled: boolean } }>(src).observability.enabled).toBe(
      true,
    );
  });
});

describe("CLI gate hardness (D-16) — --mode warn|block + --github", () => {
  let tmpdir: string;
  const cliPath = path.resolve(__dirname, "audit-observability-config.ts");

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-mode-"));
  });
  afterEach(() => {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  // Spawn the script via tsx in a child process so we exercise the real
  // `process.exit()` paths instead of monkey-patching them. This is the
  // contract storefront CI consumes, so it's the contract under test.
  function runCli(args: string[]): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const { spawnSync } = require("node:child_process") as typeof import(
      "node:child_process"
    );
    const result = spawnSync(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        cliPath,
        "--source",
        tmpdir,
        ...args,
      ],
      { encoding: "utf8" },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  it("default mode is warn — exits 0 even with error findings", () => {
    // Empty wrangler triggers `observability_missing` (error) +
    // `tail_consumer_missing` (error) + `version_metadata_*` (error). Warn
    // mode must annotate but exit 0.
    fs.writeFileSync(path.join(tmpdir, "wrangler.jsonc"), "{}");
    const { status, stdout } = runCli([]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/observability_missing/);
  });

  it("--mode block exits 1 when an error-severity finding is present", () => {
    fs.writeFileSync(path.join(tmpdir, "wrangler.jsonc"), "{}");
    const { status, stdout } = runCli(["--mode", "block"]);
    expect(status).toBe(1);
    expect(stdout).toMatch(/observability_missing/);
  });

  it("--mode block exits 0 when only warn-severity findings are present", () => {
    // Canonical observability block + the rest of the fleet bindings → only
    // the DECO_OTEL_*_ENDPOINT warns survive. Block mode must exit 0 because
    // those are `warn`, not `error`.
    fs.writeFileSync(
      path.join(tmpdir, "wrangler.jsonc"),
      JSON.stringify({
        name: "my-store",
        observability: {
          enabled: true,
          traces: { enabled: true, head_sampling_rate: 0.01, persist: true },
          logs: { enabled: true, head_sampling_rate: 1, persist: true },
        },
        version_metadata: { binding: "CF_VERSION_METADATA" },
        analytics_engine_datasets: [{ binding: "DECO_METRICS" }],
        tail_consumers: [{ service: "deco-otel-tail" }],
      }),
    );
    const { status } = runCli(["--mode", "block"]);
    expect(status).toBe(0);
  });

  it("--mode block exits 0 on a fully clean wrangler.jsonc", () => {
    fs.writeFileSync(
      path.join(tmpdir, "wrangler.jsonc"),
      JSON.stringify({
        name: "my-store",
        observability: {
          enabled: true,
          traces: { enabled: true, head_sampling_rate: 0.01, persist: true },
          logs: { enabled: true, head_sampling_rate: 1, persist: true },
        },
        version_metadata: { binding: "CF_VERSION_METADATA" },
        analytics_engine_datasets: [{ binding: "DECO_METRICS" }],
        tail_consumers: [{ service: "deco-otel-tail" }],
        vars: {
          DECO_OTEL_METRICS_ENDPOINT: "https://ingest.example.com",
          DECO_OTEL_TRACES_ENDPOINT: "https://ingest.example.com",
          DECO_OTEL_LOGS_ENDPOINT: "https://ingest.example.com",
        },
      }),
    );
    const { status } = runCli(["--mode", "block"]);
    expect(status).toBe(0);
  });

  it("--github emits ::warning::/::error:: annotations matched to mode", () => {
    fs.writeFileSync(path.join(tmpdir, "wrangler.jsonc"), "{}");
    // In warn mode, even error-severity findings annotate as `warning` (we
    // never escalate to GitHub `error` annotations when we won't fail the
    // check — keeps the PR annotation channel quiet at v1).
    const warnRun = runCli(["--github"]);
    expect(warnRun.status).toBe(0);
    expect(warnRun.stdout).toMatch(/::warning title=observability_missing::/);
    expect(warnRun.stdout).not.toMatch(/::error title=/);

    // In block mode, error-severity findings escalate to `::error::`.
    const blockRun = runCli(["--mode", "block", "--github"]);
    expect(blockRun.status).toBe(1);
    expect(blockRun.stdout).toMatch(/::error title=observability_missing::/);
  });

  it("--mode rejects values other than warn|block with exit 2", () => {
    fs.writeFileSync(path.join(tmpdir, "wrangler.jsonc"), "{}");
    const { status, stderr } = runCli(["--mode", "advisory"]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/--mode must be "warn" or "block"/);
  });
});

describe("CLI smoke — wrangler.jsonc with trailing commas", () => {
  let tmpdir: string;
  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-jsonc-"));
  });
  afterEach(() => {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it("audits a canonical wrangler.jsonc containing trailing commas without parse failure", () => {
    const src = `{
      // canonical, with trailing commas — common in real wrangler.jsonc files
      "name": "my-store",
      "observability": {
        "enabled": true,
        "traces": { "enabled": true, "head_sampling_rate": 0.01, "persist": true, },
        "logs":   { "enabled": true, "head_sampling_rate": 1,    "persist": true, },
      },
    }`;
    fs.writeFileSync(path.join(tmpdir, "wrangler.jsonc"), src);
    // The audit's pure function still works against the parsed shape; this
    // test guards the parse step itself, which previously threw on the
    // trailing commas.
    const parsed = parseJsonc<{
      observability?: Parameters<typeof auditObservabilityBlock>[0];
    }>(src);
    expect(auditObservabilityBlock(parsed.observability)).toEqual([]);
  });
});
