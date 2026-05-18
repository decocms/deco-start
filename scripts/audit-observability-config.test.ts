import { describe, expect, it } from "vitest";
import { auditObservabilityBlock } from "./audit-observability-config";

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
