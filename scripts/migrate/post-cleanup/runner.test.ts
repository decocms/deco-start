import { describe, expect, it } from "vitest";
import { _internals, ALL_RULES } from "./rules";
import { runAudit } from "./runner";
import type { FsAdapter } from "./types";

/**
 * In-memory FsAdapter for tests. Maps absolute path → file content.
 * `glob` does a literal substring-pattern match — good enough for our
 * tests which never use complex globs.
 */
function makeFs(files: Record<string, string>): FsAdapter {
  const norm = Object.fromEntries(
    Object.entries(files).map(([k, v]) => [k.replace(/\\/g, "/"), v]),
  );
  return {
    exists(absPath) {
      return absPath.replace(/\\/g, "/") in norm;
    },
    readText(absPath) {
      const key = absPath.replace(/\\/g, "/");
      if (!(key in norm)) throw new Error(`ENOENT: ${absPath}`);
      return norm[key];
    },
    glob(siteDir, pattern, excludeDirs = []) {
      const root = siteDir.replace(/\\/g, "/");
      const all = Object.keys(norm).filter((p) => p.startsWith(`${root}/`));
      const filtered = all.filter((p) => {
        const rel = p.slice(root.length + 1);
        return !excludeDirs.some((dir) => rel.startsWith(`${dir}/`));
      });
      // Build a regex that handles ** and {a,b} the same way the real
      // adapter does — but lighter, just enough for the test patterns.
      const branches = pattern.includes("{")
        ? pattern
            .match(/\{([^{}]+)\}/)![1]
            .split(",")
            .map((b) => pattern.replace(/\{[^{}]+\}/, b.trim()))
        : [pattern];
      const regexes = branches.map((p) => {
        const re = p
          .replace(/[.+^$()|]/g, "\\$&")
          .replace(/\*\*\//g, "<<DBL>>")
          .replace(/\*\*/g, "<<DBL>>")
          .replace(/\*/g, "[^/]*")
          .replace(/<<DBL>>/g, "(?:.*/)?");
        return new RegExp(`^${re}$`);
      });
      return filtered
        .filter((p) => {
          const rel = p.slice(root.length + 1);
          return regexes.some((re) => re.test(rel));
        })
        .sort();
    },
  };
}

const SITE = "/site";

describe("runAudit — empty site", () => {
  it("returns zero findings on an empty tree", () => {
    const fs = makeFs({});
    const report = runAudit(SITE, fs);
    expect(report.site).toBe(SITE);
    expect(report.totalFindings).toBe(0);
    expect(report.rules).toHaveLength(ALL_RULES.length);
    for (const r of report.rules) expect(r.findings).toEqual([]);
  });
});

describe("rule: dead-lib-shims", () => {
  it("flags a shim whose only export is unreferenced", () => {
    const fs = makeFs({
      "/site/src/lib/dead.ts": "export const foo = 1;\n",
      "/site/src/sections/Other.tsx": 'export const x = "y";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "dead-lib-shims")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].file).toBe("src/lib/dead.ts");
    expect(r.findings[0].fix).toContain("rm src/lib/dead.ts");
  });

  it("does not flag a shim referenced from outside src/lib", () => {
    const fs = makeFs({
      "/site/src/lib/used.ts": "export function helper() { return 1; }\n",
      "/site/src/sections/Caller.tsx": 'import { helper } from "~/lib/used";\nhelper();\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "dead-lib-shims")!;
    expect(r.findings).toEqual([]);
  });

  it("does not flag a shim with no exports at all (likely intentional empty file)", () => {
    const fs = makeFs({
      "/site/src/lib/empty.ts": "// nothing here\n",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "dead-lib-shims")!;
    expect(r.findings).toEqual([]);
  });

  it("flags only when ALL exports are dead — partial use spares the file", () => {
    const fs = makeFs({
      "/site/src/lib/mixed.ts": "export const used = 1;\nexport const unused = 2;\n",
      "/site/src/sections/Caller.tsx": 'import { used } from "~/lib/mixed";\nconsole.log(used);\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "dead-lib-shims")!;
    expect(r.findings).toEqual([]);
  });
});

describe("rule: obsolete-vite-plugins", () => {
  it("detects site-manual-chunks", () => {
    const fs = makeFs({
      "/site/vite.config.ts": `
        export default defineConfig({
          plugins: [
            { name: "site-manual-chunks", config() { return {}; } },
          ],
        });
      `,
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "obsolete-vite-plugins")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].meta?.plugin).toBe("site-manual-chunks");
  });

  it("detects deco-stub-meta-gen", () => {
    const fs = makeFs({
      "/site/vite.config.ts": 'plugins: [{ name: "deco-stub-meta-gen", enforce: "pre" }]',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "obsolete-vite-plugins")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].meta?.plugin).toBe("deco-stub-meta-gen");
  });

  it("returns zero findings when both are absent", () => {
    const fs = makeFs({
      "/site/vite.config.ts": 'plugins: [{ name: "react", enforce: "pre" }]',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "obsolete-vite-plugins")!;
    expect(r.findings).toEqual([]);
  });
});

describe("rule: dead-runtime-shim", () => {
  it("flags an invoke-only runtime.ts", () => {
    const fs = makeFs({
      "/site/src/runtime.ts":
        "export const invoke = createNestedInvokeProxy();\nexport function createNestedInvokeProxy() { return {}; }\n",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "dead-runtime-shim")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].file).toBe("src/runtime.ts");
  });

  it("does not flag a runtime.ts that exports site-specific helpers", () => {
    const fs = makeFs({
      "/site/src/runtime.ts": "export const invoke = {};\nexport const customHelper = () => 1;\n",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "dead-runtime-shim")!;
    expect(r.findings).toEqual([]);
  });
});

describe("rule: site-local-with-globals", () => {
  it("flags a local cmsRouteWithGlobals wrapper", () => {
    const lines = Array(120).fill("// boilerplate").join("\n");
    const fs = makeFs({
      "/site/src/server/routes/withSiteGlobals.ts": `${lines}\nexport function cmsRouteWithGlobals() { return {}; }\n`,
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "site-local-with-globals")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].meta?.lineCount).toBeGreaterThan(100);
  });

  it("does not flag a re-export from the framework", () => {
    const fs = makeFs({
      "/site/src/server/routes/withSiteGlobals.ts":
        'export { withSiteGlobals } from "@decocms/start/routes";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "site-local-with-globals")!;
    expect(r.findings).toEqual([]);
  });
});

describe("rule: vtex-shim-regression", () => {
  it("flags imports from ~/lib/vtex-segment", () => {
    const fs = makeFs({
      "/site/src/sections/Foo.tsx": 'import { getSegment } from "~/lib/vtex-segment";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].meta?.shims).toContain("vtex-segment");
  });

  it("does not flag imports from src/lib itself", () => {
    const fs = makeFs({
      "/site/src/lib/vtex-segment.ts": 'import other from "~/lib/vtex-fetch";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    expect(r.findings).toEqual([]);
  });
});

describe("rule: local-widgets-types", () => {
  it("flags presence of src/types/widgets.ts and counts imports", () => {
    const fs = makeFs({
      "/site/src/types/widgets.ts": "export type ImageWidget = string;\n",
      "/site/src/sections/A.tsx": 'import type { ImageWidget } from "~/types/widgets";\n',
      "/site/src/sections/B.tsx": 'import type { ImageWidget } from "~/types/widgets";\n',
      "/site/src/sections/C.tsx": "export const x = 1;\n",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "local-widgets-types")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].meta?.importCount).toBe(2);
  });

  it("returns zero findings when the file does not exist", () => {
    const fs = makeFs({
      "/site/src/sections/A.tsx": "export const x = 1;\n",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "local-widgets-types")!;
    expect(r.findings).toEqual([]);
  });
});

describe("rule: framework-todos", () => {
  it("flags TODOs that mention deco/framework/move into", () => {
    const fs = makeFs({
      "/site/src/sections/Foo.tsx":
        "// TODO: move into decoVitePlugin in next release\nexport const x = 1;\n",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "framework-todos")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].file).toContain(":1");
  });

  it("does not flag unrelated TODOs", () => {
    const fs = makeFs({
      "/site/src/sections/Foo.tsx": "// TODO: i18n strings\nexport const x = 1;\n",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "framework-todos")!;
    expect(r.findings).toEqual([]);
  });
});

describe("internals", () => {
  it("extractExports parses common forms (top-level, unindented)", () => {
    const code = [
      "export const a = 1;",
      "export function b() {}",
      "export interface C {}",
      "export type D = string;",
      "export class E {}",
      "const private_ = 1;",
    ].join("\n");
    expect(_internals.extractExports(code).sort()).toEqual(["C", "D", "E", "a", "b"]);
  });
});

describe("runAudit — totals", () => {
  it("totalFindings sums across all rules", () => {
    const fs = makeFs({
      "/site/src/lib/dead.ts": "export const x = 1;\n",
      "/site/vite.config.ts": 'plugins: [{ name: "site-manual-chunks", config() {} }]',
      "/site/src/sections/Foo.tsx":
        "// TODO: deco framework should own this\nexport const y = 2;\n",
    });
    const report = runAudit(SITE, fs);
    expect(report.totalFindings).toBe(3);
  });
});
