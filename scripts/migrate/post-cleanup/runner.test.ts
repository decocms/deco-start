import { describe, expect, it } from "vitest";
import { _internals, ALL_RULES } from "./rules";
import { runAudit } from "./runner";
import type { FsAdapter, FsWriter } from "./types";

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

/**
 * Mutable in-memory FS — read AND write share one backing store. Used
 * for fix-mode tests. The `store` is exposed so tests can assert what
 * the writer left behind (deletions and content rewrites).
 */
function makeMutableFs(initial: Record<string, string>): {
  fs: FsAdapter;
  writer: FsWriter;
  store: Record<string, string>;
  log: { kind: "delete" | "write"; absPath: string }[];
} {
  const store = Object.fromEntries(
    Object.entries(initial).map(([k, v]) => [k.replace(/\\/g, "/"), v]),
  );
  const log: { kind: "delete" | "write"; absPath: string }[] = [];
  const fs: FsAdapter = {
    exists(absPath) {
      return absPath.replace(/\\/g, "/") in store;
    },
    readText(absPath) {
      const k = absPath.replace(/\\/g, "/");
      if (!(k in store)) throw new Error(`ENOENT: ${absPath}`);
      return store[k];
    },
    glob(siteDir, pattern, excludeDirs = []) {
      const root = siteDir.replace(/\\/g, "/");
      const all = Object.keys(store).filter((p) => p.startsWith(`${root}/`));
      const filtered = all.filter((p) => {
        const rel = p.slice(root.length + 1);
        return !excludeDirs.some((dir) => rel.startsWith(`${dir}/`));
      });
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
  const writer: FsWriter = {
    deleteFile(absPath) {
      const k = absPath.replace(/\\/g, "/");
      delete store[k];
      log.push({ kind: "delete", absPath: k });
    },
    writeText(absPath, content) {
      const k = absPath.replace(/\\/g, "/");
      store[k] = content;
      log.push({ kind: "write", absPath: k });
    },
  };
  return { fs, writer, store, log };
}

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
  // Default-pessimistic case: shim file missing → unknown symbols treated
  // as stubs so audit always surfaces the import. (Compile phase catches
  // the underlying TS error separately.)
  it("flags imports when shim file is missing (defensive default)", () => {
    const fs = makeFs({
      "/site/src/sections/Foo.tsx": 'import { getSegment } from "~/lib/vtex-segment";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].meta?.stubsBySim).toEqual({
      "vtex-segment": ["getSegment"],
    });
  });

  it("does not flag imports from src/lib itself", () => {
    const fs = makeFs({
      "/site/src/lib/vtex-segment.ts": 'import other from "~/lib/vtex-fetch";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    expect(r.findings).toEqual([]);
  });

  it("does NOT flag when imported symbols are all functional", () => {
    const fs = makeFs({
      "/site/src/lib/vtex-id.ts":
        "export function parseCookie(s?: string): Record<string,string> {\n" +
        "  if (!s) return {};\n" +
        "  return Object.fromEntries(s.split(';').map(c => c.split('=') as [string,string]));\n" +
        "}\n",
      "/site/src/actions/x.ts": 'import { parseCookie } from "~/lib/vtex-id";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    // parseCookie has nested-block functional impl → not a stub → no warning.
    expect(r.findings).toEqual([]);
  });

  it("flags only the stub symbols when import set is mixed", () => {
    const fs = makeFs({
      "/site/src/lib/vtex-segment.ts":
        "export function getSegmentFromBag(_req?: any): null { return null; }\n" +
        "export function withSegmentCookie(headers: Headers): Headers {\n" +
        "  headers.set('x', 'y');\n" +
        "  return headers;\n" +
        "}\n",
      "/site/src/loaders/x.ts":
        'import { getSegmentFromBag, withSegmentCookie } from "~/lib/vtex-segment";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].meta?.stubsBySim).toEqual({
      "vtex-segment": ["getSegmentFromBag"],
    });
    expect(r.findings[0].message).toContain("getSegmentFromBag");
    expect(r.findings[0].message).not.toContain("withSegmentCookie");
  });

  it("flags identity-cast (toProduct) as a stub", () => {
    const fs = makeFs({
      "/site/src/lib/vtex-transform.ts":
        "export function toProduct(p: any): unknown { return p as unknown; }\n",
      "/site/src/loaders/search.ts":
        'import { toProduct } from "~/lib/vtex-transform";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].meta?.stubsBySim).toEqual({
      "vtex-transform": ["toProduct"],
    });
  });

  it("does NOT flag `import type { X }` from a stub-having shim", () => {
    const fs = makeFs({
      "/site/src/lib/vtex-client.ts":
        "export interface VTEXCommerceStable { account: string; }\n" +
        "export function stub(): null { return null; }\n",
      "/site/src/loaders/x.ts":
        'import type { VTEXCommerceStable } from "~/lib/vtex-client";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    // Type-only imports have no runtime → never a regression.
    expect(r.findings).toEqual([]);
  });

  it("ignores per-symbol `type` modifier and only flags runtime imports", () => {
    const fs = makeFs({
      "/site/src/lib/vtex-mixed.ts":
        "export interface Cfg { a: string; }\n" +
        "export function stub(): null { return null; }\n" +
        "export function ok(): boolean { return true; }\n",
      "/site/src/loaders/x.ts":
        'import { type Cfg, stub, ok } from "~/lib/vtex-mixed";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].meta?.stubsBySim).toEqual({
      "vtex-mixed": ["stub"],
    });
  });

  it("aggregates findings per file across multiple shims", () => {
    const fs = makeFs({
      "/site/src/lib/vtex-segment.ts":
        "export function getSegmentFromBag(): null { return null; }\n",
      "/site/src/lib/vtex-transform.ts":
        "export function toProduct(p: any): unknown { return p as unknown; }\n",
      "/site/src/loaders/search.ts":
        'import { getSegmentFromBag } from "~/lib/vtex-segment";\n' +
        'import { toProduct } from "~/lib/vtex-transform";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].meta?.stubsBySim).toEqual({
      "vtex-segment": ["getSegmentFromBag"],
      "vtex-transform": ["toProduct"],
    });
  });

  it("supports `as`-renamed imports (resolves to source name)", () => {
    const fs = makeFs({
      "/site/src/lib/vtex-segment.ts":
        "export function getSegmentFromBag(): null { return null; }\n",
      "/site/src/loaders/x.ts":
        'import { getSegmentFromBag as getSeg } from "~/lib/vtex-segment";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].meta?.stubsBySim).toEqual({
      "vtex-segment": ["getSegmentFromBag"],
    });
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
    expect(report.totalFixActions).toBe(0);
  });

  it("supportsAutoFix flag reflects rule capability", () => {
    const fs = makeFs({});
    const report = runAudit(SITE, fs);
    const supported = report.rules
      .filter((r) => r.supportsAutoFix)
      .map((r) => r.rule)
      .sort();
    expect(supported).toEqual(
      ["dead-lib-shims", "dead-runtime-shim", "local-widgets-types"].sort(),
    );
  });
});

describe("runAudit — fix mode", () => {
  it("does not mutate when no writer is provided (default audit-only)", () => {
    const { fs, store } = makeMutableFs({
      "/site/src/lib/dead.ts": "export const foo = 1;\n",
    });
    const before = { ...store };
    runAudit(SITE, fs);
    expect(store).toEqual(before);
  });

  it("fix mode deletes a dead-lib shim and reports the action", () => {
    const { fs, writer, store } = makeMutableFs({
      "/site/src/lib/dead.ts": "export const foo = 1;\n",
      "/site/src/sections/Other.tsx": 'export const x = "y";\n',
    });
    const report = runAudit(SITE, fs, { writer });
    const r = report.rules.find((r) => r.rule === "dead-lib-shims")!;
    expect(r.findings).toHaveLength(1);
    expect(r.fixes).toHaveLength(1);
    expect(r.fixes![0].kind).toBe("delete");
    expect(r.fixes![0].file).toBe("src/lib/dead.ts");
    expect("/site/src/lib/dead.ts" in store).toBe(false);
    expect("/site/src/sections/Other.tsx" in store).toBe(true);
    expect(report.totalFixActions).toBe(1);
  });

  it("fix mode rewrites runtime imports + deletes runtime.ts", () => {
    const { fs, writer, store, log } = makeMutableFs({
      "/site/src/runtime.ts":
        "export const invoke = createNestedInvokeProxy();\nexport function createNestedInvokeProxy() { return {}; }\n",
      "/site/src/sections/A.tsx": 'import { invoke } from "~/runtime";\nconsole.log(invoke);\n',
      "/site/src/sections/B.tsx": "import { invoke } from '~/runtime';\nconsole.log(invoke);\n",
      "/site/src/sections/C.tsx":
        'import { other } from "~/something-else";\nconsole.log(other);\n',
    });
    const report = runAudit(SITE, fs, { writer });
    const r = report.rules.find((r) => r.rule === "dead-runtime-shim")!;
    expect(r.findings).toHaveLength(1);
    expect(r.fixes).toHaveLength(1);
    expect(r.fixes![0].detail).toMatch(/rewrote 2 import/);
    expect("/site/src/runtime.ts" in store).toBe(false);
    expect(store["/site/src/sections/A.tsx"]).toContain('"@decocms/start/sdk"');
    expect(store["/site/src/sections/B.tsx"]).toContain("'@decocms/start/sdk'");
    expect(store["/site/src/sections/C.tsx"]).toContain('"~/something-else"');
    expect(log.filter((e) => e.kind === "delete")).toHaveLength(1);
    expect(log.filter((e) => e.kind === "write")).toHaveLength(2);
  });

  it("fix mode rewrites widgets imports + deletes widgets.ts", () => {
    const { fs, writer, store } = makeMutableFs({
      "/site/src/types/widgets.ts": "export type ImageWidget = string;\n",
      "/site/src/sections/A.tsx":
        'import type { ImageWidget } from "~/types/widgets";\nexport const x: ImageWidget = "y";\n',
      "/site/src/sections/B.tsx":
        "import type { ImageWidget } from '~/types/widgets';\nexport const y: ImageWidget = 'z';\n",
    });
    const report = runAudit(SITE, fs, { writer });
    const r = report.rules.find((r) => r.rule === "local-widgets-types")!;
    expect(r.fixes).toHaveLength(1);
    expect(r.fixes![0].detail).toMatch(/rewrote 2 import/);
    expect("/site/src/types/widgets.ts" in store).toBe(false);
    expect(store["/site/src/sections/A.tsx"]).toContain('"@decocms/start/types/widgets"');
    expect(store["/site/src/sections/B.tsx"]).toContain("'@decocms/start/types/widgets'");
  });

  it("fix mode is a no-op for rules without applyFix (e.g. framework-todos)", () => {
    const { fs, writer, store } = makeMutableFs({
      "/site/src/sections/Foo.tsx": "// TODO: move into decoVitePlugin\nexport const x = 1;\n",
    });
    const beforeStore = { ...store };
    const report = runAudit(SITE, fs, { writer });
    const r = report.rules.find((r) => r.rule === "framework-todos")!;
    expect(r.findings).toHaveLength(1);
    expect(r.fixes).toBeUndefined();
    expect(r.supportsAutoFix).toBe(false);
    expect(store).toEqual(beforeStore);
  });

  it("fix mode rewrites only exact matches, not prefix collisions", () => {
    const { fs, writer, store } = makeMutableFs({
      "/site/src/types/widgets.ts": "export type ImageWidget = string;\n",
      "/site/src/sections/A.tsx":
        'import type { ImageWidget } from "~/types/widgets";\nimport thing from "~/types/widgets-extra";\n',
    });
    runAudit(SITE, fs, { writer });
    expect(store["/site/src/sections/A.tsx"]).toContain('"@decocms/start/types/widgets"');
    expect(store["/site/src/sections/A.tsx"]).toContain('"~/types/widgets-extra"');
  });
});
