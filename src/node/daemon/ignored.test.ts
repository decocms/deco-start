import { describe, expect, it } from "vitest";
import { DAEMON_IGNORED_DIRS, isIgnoredPath } from "./ignored";

describe("DAEMON_IGNORED_DIRS", () => {
  it("includes the framework artefact dirs that flooded SSE in 5.1.x", () => {
    // Regression guard: these were added after Next 16 / Turbopack consumer
    // testing reported ~30 spurious fs events per rebuild. Removing any of
    // them silently re-introduces the noise; leave them in or update the test.
    for (const required of [
      ".git",
      "node_modules",
      ".agent-home",
      ".claude",
      ".next",
      ".turbo",
      "dist",
      "build",
      ".cache",
      "coverage",
    ]) {
      expect(DAEMON_IGNORED_DIRS).toContain(required);
    }
  });
});

describe("isIgnoredPath", () => {
  it("matches each canonical dir as a path segment", () => {
    for (const dir of DAEMON_IGNORED_DIRS) {
      expect(isIgnoredPath(`/project/${dir}/file.txt`)).toBe(true);
    }
  });

  it("filters Next.js build artefacts (the originally reported bug)", () => {
    expect(isIgnoredPath("/project/.next/dev/server/chunks/01.js")).toBe(true);
    expect(isIgnoredPath("/project/.next/cache/webpack/server.json")).toBe(true);
  });

  it("does not match partial-name collisions like 'dist-foo'", () => {
    expect(isIgnoredPath("/project/dist-foo/bar.txt")).toBe(false);
    expect(isIgnoredPath("/project/my.next.config.js")).toBe(false);
  });

  it("normalises Windows-style separators", () => {
    expect(isIgnoredPath("C:\\project\\node_modules\\pkg\\index.js")).toBe(true);
  });

  it("accepts non-ignored .deco paths", () => {
    expect(isIgnoredPath("/project/.deco/blocks/site.json")).toBe(false);
  });
});
