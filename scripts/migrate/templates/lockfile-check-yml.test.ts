import { describe, expect, it } from "vitest";
import { generateLockfileCheckYml } from "./lockfile-check-yml";

describe("generateLockfileCheckYml", () => {
  it("emits a valid GitHub Actions workflow with the bun version pinned", () => {
    const yaml = generateLockfileCheckYml("1.3.5");
    expect(yaml).toContain("name: lockfile-check");
    expect(yaml).toContain("on:");
    expect(yaml).toContain("pull_request:");
    expect(yaml).toContain("bun-version: 1.3.5");
    expect(yaml).toContain("bun install --frozen-lockfile");
  });

  it("strips an accidental `bun@` prefix from the version input", () => {
    const yaml = generateLockfileCheckYml("bun@1.3.5");
    expect(yaml).toContain("bun-version: 1.3.5");
    expect(yaml).not.toMatch(/bun-version:\s*bun@/);
  });

  it("scopes the trigger to package.json + bun.lock + the workflow itself", () => {
    const yaml = generateLockfileCheckYml("1.3.5");
    expect(yaml).toContain('"package.json"');
    expect(yaml).toContain('"bun.lock"');
    expect(yaml).toContain('".github/workflows/lockfile-check.yml"');
  });
});
