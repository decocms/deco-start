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
    expect(r.findings[0].meta?.safeToAutoFix).toBe(true);
    expect(r.findings[0].meta?.hasInlineProxy).toBe(true);
  });

  it("does not flag a runtime.ts that exports site-specific helpers (no inline proxy)", () => {
    const fs = makeFs({
      "/site/src/runtime.ts": "export const invoke = {};\nexport const customHelper = () => 1;\n",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "dead-runtime-shim")!;
    expect(r.findings).toEqual([]);
  });

  it("does NOT flag the Wave 15-A canonical re-export shape", () => {
    // The migration template now scaffolds a thin re-export from
    // @decocms/start/sdk plus a Runtime alias. No inline proxy body.
    const fs = makeFs({
      "/site/src/runtime.ts":
        'import { invoke } from "@decocms/start/sdk";\nexport { invoke };\nexport const Runtime = { invoke };\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "dead-runtime-shim")!;
    expect(r.findings).toEqual([]);
  });

  it("flags the legacy 47-line inline createNestedInvokeProxy body (with Runtime export)", () => {
    // The pre-Wave-15-A migration template emitted a full Proxy body
    // alongside `Runtime = { invoke }`. The earlier rule heuristic
    // missed this shape because `Runtime` was not in its allowlist.
    const fs = makeFs({
      "/site/src/runtime.ts": `
function createNestedInvokeProxy(path: string[] = []): any {
  return new Proxy(
    Object.assign(async (props: any) => {
      const key = path.join("/");
      const response = await fetch(\`/deco/invoke/\${key}\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(props ?? {}),
      });
      return response.json();
    }, {}),
    {
      get(_target: any, prop: string) {
        if (prop === "then") return undefined;
        return createNestedInvokeProxy([...path, prop]);
      },
    },
  );
}

export const invoke = createNestedInvokeProxy() as any;
export const Runtime = { invoke };
`,
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "dead-runtime-shim")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].meta?.hasInlineProxy).toBe(true);
    expect(r.findings[0].meta?.safeToAutoFix).toBe(true);
    expect(r.findings[0].message).toContain("inline createNestedInvokeProxy body");
  });

  it("flags but does NOT auto-fix when inline proxy coexists with site-specific helpers", () => {
    // Defensive: if a site has hand-tuned the runtime file with extra
    // exports beyond invoke/Runtime, deletion would lose data. Surface
    // the issue but skip the destructive fix.
    const fs = makeFs({
      "/site/src/runtime.ts": `
function createNestedInvokeProxy(path: string[] = []): any {
  return new Proxy(Object.assign(async (props: any) => {}, {}), {});
}
export const invoke = createNestedInvokeProxy();
export const trackPageView = () => console.log("custom tracker");
`,
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "dead-runtime-shim")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].meta?.hasInlineProxy).toBe(true);
    expect(r.findings[0].meta?.safeToAutoFix).toBe(false);
    expect(r.findings[0].message).toContain("manual review");
    // applyFix should be a no-op when safeToAutoFix is false — verified
    // implicitly by the runner test for --fix below; here we only
    // assert the metadata gate.
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

describe("rule: vtex-shim-regression — per-symbol fix hints", () => {
  it("emits 1:1 swap hint for `toProduct`", () => {
    const fs = makeFs({
      "/site/src/lib/vtex-transform.ts":
        "export function toProduct(p: any): unknown { return p as unknown; }\n",
      "/site/src/loaders/x.ts":
        'import { toProduct } from "~/lib/vtex-transform";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.fix).toContain("toProduct → @decocms/apps/vtex/utils/transform");
    expect(f.fix).toContain("1:1 import swap");
    expect(f.meta?.fixHints).toEqual({
      toProduct: {
        kind: "swap",
        canonical: "@decocms/apps/vtex/utils/transform",
        note: expect.stringContaining("canonical signature"),
      },
    });
  });

  it("emits refactor hint for `getSegmentFromBag`", () => {
    const fs = makeFs({
      "/site/src/lib/vtex-segment.ts":
        "export function getSegmentFromBag(): null { return null; }\n",
      "/site/src/loaders/x.ts":
        'import { getSegmentFromBag } from "~/lib/vtex-segment";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    const f = r.findings[0];
    expect(f.fix).toContain("getSegmentFromBag → call-site refactor");
    expect(f.fix).toContain("buildSegmentFromCookies");
    expect(f.meta?.fixHints).toEqual({
      getSegmentFromBag: {
        kind: "refactor",
        note: expect.stringContaining("buildSegmentFromCookies"),
      },
    });
  });

  it("composes hints for files with multiple stubs", () => {
    const fs = makeFs({
      "/site/src/lib/vtex-segment.ts":
        "export function getSegmentFromBag(): null { return null; }\n",
      "/site/src/lib/vtex-transform.ts":
        "export function toProduct(p: any): unknown { return p as unknown; }\n",
      "/site/src/loaders/x.ts":
        'import { getSegmentFromBag } from "~/lib/vtex-segment";\n' +
        'import { toProduct } from "~/lib/vtex-transform";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    const f = r.findings[0];
    expect(f.fix).toContain("getSegmentFromBag → call-site refactor");
    expect(f.fix).toContain("toProduct → @decocms/apps/vtex/utils/transform");
    // Joined with " | " for visual separation.
    expect(f.fix).toContain(" | ");
    expect(Object.keys(f.meta?.fixHints as object)).toEqual(
      expect.arrayContaining(["toProduct", "getSegmentFromBag"]),
    );
  });

  it("falls back to generic hint for symbols without entries", () => {
    const fs = makeFs({
      "/site/src/lib/vtex-mystery.ts":
        "export function unknownStub(): null { return null; }\n",
      "/site/src/loaders/x.ts":
        'import { unknownStub } from "~/lib/vtex-mystery";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    const f = r.findings[0];
    expect(f.fix).toContain("unknownStub → repoint to '@decocms/apps/vtex/...");
    // No fixHints in meta when no symbols match the table.
    expect(f.meta?.fixHints).toBeUndefined();
  });

  it("mixes specific hints and generic fallback in one message", () => {
    const fs = makeFs({
      "/site/src/lib/vtex-transform.ts":
        "export function toProduct(p: any): unknown { return p as unknown; }\n",
      "/site/src/lib/vtex-mystery.ts":
        "export function unknownStub(): null { return null; }\n",
      "/site/src/loaders/x.ts":
        'import { toProduct } from "~/lib/vtex-transform";\n' +
        'import { unknownStub } from "~/lib/vtex-mystery";\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    const f = r.findings[0];
    expect(f.fix).toContain("toProduct → @decocms/apps/vtex/utils/transform");
    expect(f.fix).toContain("unknownStub → repoint");
    // Only the known symbol shows up in fixHints.
    expect(f.meta?.fixHints).toEqual({
      toProduct: expect.objectContaining({ kind: "swap" }),
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

describe("rule: vtex-proxy-handler-missing", () => {
  // Canonical wiring matching scripts/migrate/templates/server-entry.ts (generateVtexWorkerEntry):
  // imports from @decocms/apps/vtex/utils/proxy and passes proxyHandler to createDecoWorkerEntry.
  const okWorkerEntry = `
import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
import { shouldProxyToVtex, createVtexCheckoutProxy } from "@decocms/apps/vtex/utils/proxy";
const proxy = createVtexCheckoutProxy({ account: "x", checkoutOrigin: "x.vtexcommercestable.com.br" });
export default createDecoWorkerEntry(serverEntry, {
  proxyHandler: async (req, url) => {
    if (!shouldProxyToVtex(url.pathname)) return null;
    return proxy(req, url);
  },
});
`;

  it("does not flag non-VTEX sites", () => {
    const fs = makeFs({
      "/site/src/index.ts": "export const x = 1;",
      // Worker entry intentionally without the proxy import — non-VTEX
      // sites don't need it and shouldn't be flagged.
      "/site/src/worker-entry.ts": "export default {};",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-proxy-handler-missing")!;
    expect(r.findings).toEqual([]);
  });

  it("does not flag VTEX site whose worker-entry has the proxyHandler wired", () => {
    const fs = makeFs({
      "/site/src/commerceLoaders.ts": "import {} from \"@decocms/apps/vtex/mod\";",
      "/site/src/worker-entry.ts": okWorkerEntry,
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-proxy-handler-missing")!;
    expect(r.findings).toEqual([]);
  });

  it("flags VTEX site missing src/worker-entry.ts entirely", () => {
    const fs = makeFs({
      "/site/src/commerceLoaders.ts": "import {} from \"@decocms/apps/vtex/mod\";",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-proxy-handler-missing")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].severity).toBe("info");
    expect(r.findings[0].message).toContain("no src/worker-entry.ts");
  });

  it("flags VTEX site whose worker-entry omits the proxy import", () => {
    const fs = makeFs({
      "/site/src/commerceLoaders.ts": "import {} from \"@decocms/apps/vtex/mod\";",
      "/site/src/worker-entry.ts": `
import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
export default createDecoWorkerEntry(serverEntry, { admin: {} });
`,
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-proxy-handler-missing")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].message).toContain("no `@decocms/apps/vtex/utils/proxy` import");
  });

  it("flags VTEX site that imports proxy helpers but never wires proxyHandler", () => {
    const fs = makeFs({
      "/site/src/commerceLoaders.ts": "import {} from \"@decocms/apps/vtex/mod\";",
      "/site/src/worker-entry.ts": `
import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
import { shouldProxyToVtex } from "@decocms/apps/vtex/utils/proxy";
// note: shouldProxyToVtex imported but not used in a proxyHandler.
export default createDecoWorkerEntry(serverEntry, { admin: {} });
`,
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "vtex-proxy-handler-missing")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].message).toContain("no `proxyHandler:` is wired");
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
      [
        "dead-lib-shims",
        "dead-runtime-shim",
        "local-framework-duplicate",
        "local-widgets-types",
        "lockfile-multiple",
        "obsolete-vite-plugins",
        "package-manager-missing",
        "vtex-shim-regression",
      ].sort(),
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

/* ------------------------------------------------------------------ */
/* W12-D / W12-E — vtex-shim-regression --fix for swap-able cases      */
/* ------------------------------------------------------------------ */

describe("runAudit — fix mode — vtex-shim-regression swap cases", () => {
  it("rewrites `toProduct` import to canonical when it is the only stub imported", () => {
    const { fs, writer, store } = makeMutableFs({
      "/site/src/lib/vtex-transform.ts":
        "export function toProduct(p: any): unknown { return p as unknown; }\n",
      "/site/src/loaders/search.ts":
        'import { toProduct } from "~/lib/vtex-transform";\nconsole.log(toProduct);\n',
    });
    const report = runAudit(SITE, fs, { writer });
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    expect(r.fixes).toHaveLength(1);
    expect(r.fixes![0].file).toBe("src/loaders/search.ts");
    expect(r.fixes![0].kind).toBe("rewrite-imports");
    expect(r.fixes![0].detail).toContain("@decocms/apps/vtex/utils/transform");
    expect(r.fixes![0].detail).toContain("toProduct");
    expect(store["/site/src/loaders/search.ts"]).toContain(
      '"@decocms/apps/vtex/utils/transform"',
    );
    expect(store["/site/src/loaders/search.ts"]).not.toContain('"~/lib/vtex-transform"');
  });

  it("rewrites `withSegmentCookie` import to canonical when it is the only stub imported", () => {
    const { fs, writer, store } = makeMutableFs({
      // Mirrors the post-#123 throwing-stub body — `throw new Error(...)`
      // is recognised by the shim classifier as `unconditional throw`.
      "/site/src/lib/vtex-segment.ts":
        'export function withSegmentCookie(..._args: any[]): any { throw new Error("stub"); }\n',
      "/site/src/loaders/x.ts":
        'import { withSegmentCookie } from "~/lib/vtex-segment";\nconsole.log(withSegmentCookie);\n',
    });
    const report = runAudit(SITE, fs, { writer });
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    expect(r.fixes).toHaveLength(1);
    expect(r.fixes![0].detail).toContain("@decocms/apps/vtex/utils/segment");
    expect(store["/site/src/loaders/x.ts"]).toContain(
      '"@decocms/apps/vtex/utils/segment"',
    );
  });

  it("does NOT rewrite mixed swap+refactor surface (getSegmentFromBag is refactor-only)", () => {
    const { fs, writer, store } = makeMutableFs({
      "/site/src/lib/vtex-segment.ts":
        "export function getSegmentFromBag(_req?: any): null { return null; }\n" +
        'export function withSegmentCookie(..._args: any[]): any { throw new Error("stub"); }\n',
      "/site/src/loaders/x.ts":
        'import { getSegmentFromBag, withSegmentCookie } from "~/lib/vtex-segment";\n',
    });
    const before = store["/site/src/loaders/x.ts"];
    const report = runAudit(SITE, fs, { writer });
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    // Finding still emitted (audit), but no fix applied (mixed surface).
    expect(r.findings).toHaveLength(1);
    expect(r.fixes).toEqual([]);
    expect(store["/site/src/loaders/x.ts"]).toBe(before);
  });

  it("does NOT rewrite when the file imports a real impl from the same shim", () => {
    // vtex-intelligent-search exports both `getISCookiesFromBag` (stub →
    // refactor) and `isFilterParam` (real impl, not in STUB_FIX_HINTS).
    // Even if only one symbol is imported, the rule's classifier already
    // skips real impls. But if a file imports BOTH, our --fix must not
    // rewrite — the canonical doesn't expose isFilterParam.
    const { fs, writer, store } = makeMutableFs({
      "/site/src/lib/vtex-intelligent-search.ts":
        "export function getISCookiesFromBag(_r?: any): Record<string,string> { return {}; }\n" +
        "export function isFilterParam(k: string): boolean { return k.startsWith('filter.'); }\n",
      "/site/src/loaders/x.ts":
        'import { getISCookiesFromBag, isFilterParam } from "~/lib/vtex-intelligent-search";\n',
    });
    const before = store["/site/src/loaders/x.ts"];
    const report = runAudit(SITE, fs, { writer });
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    expect(r.findings).toHaveLength(1);
    expect(r.fixes).toEqual([]);
    expect(store["/site/src/loaders/x.ts"]).toBe(before);
  });

  it("rewrites multiple files using the same swap-able shim in one pass", () => {
    const { fs, writer, store } = makeMutableFs({
      "/site/src/lib/vtex-transform.ts":
        "export function toProduct(p: any): unknown { return p as unknown; }\n",
      "/site/src/loaders/A.ts":
        'import { toProduct } from "~/lib/vtex-transform";\n',
      "/site/src/loaders/B.ts":
        "import { toProduct } from '~/lib/vtex-transform';\n",
    });
    const report = runAudit(SITE, fs, { writer });
    const r = report.rules.find((r) => r.rule === "vtex-shim-regression")!;
    expect(r.fixes!.length).toBe(2);
    expect(store["/site/src/loaders/A.ts"]).toContain(
      '"@decocms/apps/vtex/utils/transform"',
    );
    expect(store["/site/src/loaders/B.ts"]).toContain(
      "'@decocms/apps/vtex/utils/transform'",
    );
  });

  it("preserves the named-imports list verbatim when swapping", () => {
    // The fix only rewrites the FROM clause, not the imported names. Keeps
    // local aliases (`as`) intact.
    const { fs, writer, store } = makeMutableFs({
      "/site/src/lib/vtex-transform.ts":
        "export function toProduct(p: any): unknown { return p as unknown; }\n",
      "/site/src/loaders/x.ts":
        'import { toProduct as toP } from "~/lib/vtex-transform";\n' +
        "console.log(toP);\n",
    });
    runAudit(SITE, fs, { writer });
    expect(store["/site/src/loaders/x.ts"]).toContain(
      'import { toProduct as toP } from "@decocms/apps/vtex/utils/transform"',
    );
  });
});

/* ------------------------------------------------------------------ */
/* W12-F — obsolete-vite-plugins --fix                                 */
/* ------------------------------------------------------------------ */

describe("runAudit — fix mode — obsolete-vite-plugins", () => {
  it("removes a single inline obsolete plugin literal cleanly", () => {
    const before = `import { defineConfig } from "vite";
export default defineConfig({
  plugins: [
    react(),
    {
      name: "site-manual-chunks",
      config(_cfg, { command }) {
        if (command !== "build") return;
        return { build: { rollupOptions: { output: { manualChunks(_id: string) {} } } } };
      },
    },
    tailwindcss(),
  ],
});
`;
    const { fs, writer, store } = makeMutableFs({
      "/site/vite.config.ts": before,
    });
    const report = runAudit(SITE, fs, { writer });
    const r = report.rules.find((r) => r.rule === "obsolete-vite-plugins")!;
    expect(r.findings).toHaveLength(1);
    expect(r.fixes).toHaveLength(1);
    expect(r.fixes![0].kind).toBe("rewrite-vite-config");
    expect(r.fixes![0].detail).toContain("site-manual-chunks");
    const after = store["/site/vite.config.ts"];
    // Plugin literal is gone; siblings remain intact.
    expect(after).not.toContain('name: "site-manual-chunks"');
    expect(after).toContain("react()");
    expect(after).toContain("tailwindcss()");
    // The literal's body has been fully unindented out — no dangling braces.
    expect(after).not.toContain("manualChunks(_id");
  });

  it("removes the leading `//` comment block attached to the plugin literal", () => {
    const before = `export default defineConfig({
  plugins: [
    decoVitePlugin(),
    // Override decoVitePlugin's default manualChunks — circular deps
    // would crash if split.
    // (mirrors the framework's improved splitting)
    {
      name: "site-manual-chunks",
      config() { return {}; },
    },
    tailwindcss(),
  ],
});
`;
    const { fs, writer, store } = makeMutableFs({
      "/site/vite.config.ts": before,
    });
    runAudit(SITE, fs, { writer });
    const after = store["/site/vite.config.ts"];
    expect(after).not.toContain("Override decoVitePlugin");
    expect(after).not.toContain("circular deps");
    expect(after).not.toContain("framework's improved splitting");
    expect(after).not.toContain("site-manual-chunks");
    // decoVitePlugin call still there, no orphan separator left behind.
    expect(after).toContain("decoVitePlugin(),");
    expect(after).toContain("tailwindcss()");
    expect(after).not.toMatch(/,\s*,/);
  });

  it("removes BOTH obsolete plugins in one pass without disturbing each other", () => {
    const before = `export default defineConfig({
  plugins: [
    decoVitePlugin(),
    // chunks override
    {
      name: "site-manual-chunks",
      config() { return {}; },
    },
    // meta.gen client stub
    {
      name: "deco-stub-meta-gen",
      enforce: "pre" as const,
      load(id: string) { if (id === "x") return "export default {}"; },
    },
    tailwindcss(),
  ],
});
`;
    const { fs, writer, store } = makeMutableFs({
      "/site/vite.config.ts": before,
    });
    const report = runAudit(SITE, fs, { writer });
    const r = report.rules.find((r) => r.rule === "obsolete-vite-plugins")!;
    expect(r.findings).toHaveLength(2);
    expect(r.fixes).toHaveLength(1);
    expect(r.fixes![0].detail).toContain("site-manual-chunks");
    expect(r.fixes![0].detail).toContain("deco-stub-meta-gen");
    const after = store["/site/vite.config.ts"];
    expect(after).not.toContain("site-manual-chunks");
    expect(after).not.toContain("deco-stub-meta-gen");
    expect(after).not.toContain("chunks override");
    expect(after).not.toContain("meta.gen client stub");
    expect(after).toContain("decoVitePlugin(),");
    expect(after).toContain("tailwindcss()");
  });

  it("does not miscount braces inside template literals or strings inside the plugin body", () => {
    // Template literal containing `${'}'}` and string with `}` must not
    // throw off the brace walker.
    const before = `export default defineConfig({
  plugins: [
    {
      name: "site-manual-chunks",
      load(id: string) {
        const a = \`a\${'}'}b\`;
        const b = "}";
        return id + a + b;
      },
    },
    tailwindcss(),
  ],
});
`;
    const { fs, writer, store } = makeMutableFs({
      "/site/vite.config.ts": before,
    });
    runAudit(SITE, fs, { writer });
    const after = store["/site/vite.config.ts"];
    expect(after).not.toContain("site-manual-chunks");
    expect(after).toContain("tailwindcss()");
    // Sanity: closing brackets of defineConfig + plugins array preserved.
    expect(after).toContain("],");
    expect(after.trim().endsWith("});")).toBe(true);
  });

  it("is a no-op (no fixes) when no obsolete plugins are present", () => {
    const before = `export default defineConfig({
  plugins: [react(), tailwindcss()],
});
`;
    const { fs, writer, store } = makeMutableFs({
      "/site/vite.config.ts": before,
    });
    const report = runAudit(SITE, fs, { writer });
    const r = report.rules.find((r) => r.rule === "obsolete-vite-plugins")!;
    expect(r.findings).toEqual([]);
    expect(r.fixes).toBeUndefined();
    expect(store["/site/vite.config.ts"]).toBe(before);
  });

  it("is idempotent — running --fix twice is a no-op the second time", () => {
    const before = `export default defineConfig({
  plugins: [
    decoVitePlugin(),
    {
      name: "deco-stub-meta-gen",
      load() { return "export default {};"; },
    },
    tailwindcss(),
  ],
});
`;
    const { fs, writer, store } = makeMutableFs({
      "/site/vite.config.ts": before,
    });
    runAudit(SITE, fs, { writer });
    const afterFirst = store["/site/vite.config.ts"];
    runAudit(SITE, fs, { writer });
    expect(store["/site/vite.config.ts"]).toBe(afterFirst);
  });

  it("includes obsolete-vite-plugins in supportsAutoFix", () => {
    const fs = makeFs({});
    const report = runAudit(SITE, fs);
    const supported = report.rules
      .filter((r) => r.supportsAutoFix)
      .map((r) => r.rule);
    expect(supported).toContain("obsolete-vite-plugins");
  });
});

/* ------------------------------------------------------------------ */
/* W13-C — htmx-residue rule                                           */
/* ------------------------------------------------------------------ */

describe("rule: htmx-residue", () => {
  it("flags any leftover hx-* element in src/ with category breakdown", () => {
    const fs = makeFs({
      "/site/src/components/AddToBag.tsx":
        '<button hx-on:click={() => {}}>buy</button>\n',
      "/site/src/components/Search.tsx":
        '<form hx-post="/x" hx-target="#r" hx-swap="innerHTML"><input/></form>\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "htmx-residue")!;
    expect(r.findings).toHaveLength(2);
    const summary = r.findings.map((f) => f.message).join(" | ");
    expect(summary).toContain("event-handler=1");
    expect(summary).toContain("form-swap=1");
    expect(r.findings[0].fix).toContain("htmx-rewrite.md");
  });

  it("aggregates multiple occurrences in one file as a single finding", () => {
    const fs = makeFs({
      "/site/src/components/Big.tsx":
        '<button hx-on:click={() => {}}>1</button>\n' +
        '<button hx-on:click={() => {}}>2</button>\n' +
        '<form hx-post="/x" hx-target="#r" hx-swap="innerHTML"><input/></form>\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "htmx-residue")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].message).toContain("3 hx-* element(s)");
    expect(r.findings[0].message).toContain("event-handler=2");
    expect(r.findings[0].message).toContain("form-swap=1");
    expect(r.findings[0].meta?.total).toBe(3);
  });

  it("emits warning severity (so --strict exits 2)", () => {
    const fs = makeFs({
      "/site/src/x.tsx": '<button hx-on:click={() => {}}>x</button>\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "htmx-residue")!;
    expect(r.findings[0].severity).toBe("warning");
  });

  it("excludes test files (*.test.tsx, *.spec.ts, __tests__/) — they may legitimately reference hx-*", () => {
    const fs = makeFs({
      "/site/src/components/x.test.tsx":
        '<button hx-on:click={() => {}}>x</button>\n',
      "/site/src/components/y.spec.ts":
        'expect(html).toContain("hx-post=\\"/x\\""); /* doesn\'t hit our regex */\n',
      "/site/src/__tests__/csrf.tsx":
        '<form hx-post="/x" hx-target="#r" hx-swap="innerHTML"><input/></form>\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "htmx-residue")!;
    expect(r.findings).toEqual([]);
  });

  it("does NOT flag files outside src/ (the rule is scoped to migrated React tree)", () => {
    const fs = makeFs({
      // A pre-migration site might still have ./components/ at root.
      // After migration that's gone; if the engineer left some stragglers
      // in /scripts or /docs they don't block "rewrite-complete" gate.
      "/site/scripts/legacy.tsx":
        '<button hx-on:click={() => {}}>x</button>\n',
      "/site/docs/example.tsx":
        '<button hx-on:click={() => {}}>x</button>\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "htmx-residue")!;
    expect(r.findings).toEqual([]);
  });

  it("returns zero findings on a clean migrated tree (the rewrite-complete gate)", () => {
    const fs = makeFs({
      "/site/src/components/Real.tsx":
        '<button onClick={() => {}}>x</button>\n',
      "/site/src/routes/index.tsx":
        'export const Route = createFileRoute("/")({ component: () => <div/> });\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "htmx-residue")!;
    expect(r.findings).toEqual([]);
  });

  it("reports the line number of the FIRST hx-* element in the file", () => {
    const fs = makeFs({
      "/site/src/x.tsx":
        "import x from 'y';\n" +
        "// header\n" +
        '<button hx-on:click={() => {}}>x</button>\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "htmx-residue")!;
    expect(r.findings[0].file).toBe("src/x.tsx:3");
    expect(r.findings[0].meta?.firstLine).toBe(3);
  });

  it("does NOT support auto-fix (rewrites are non-mechanical)", () => {
    const fs = makeFs({});
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "htmx-residue")!;
    expect(r.supportsAutoFix).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* W15-B-1 — local-framework-duplicate rule                            */
/* ------------------------------------------------------------------ */

describe("rule: local-framework-duplicate", () => {
  it("flags src/sdk/clx.ts when content matches the framework export (auto-fixable)", () => {
    const fs = makeFs({
      "/site/src/sdk/clx.ts":
        "export const clx = (...args: (string | null | undefined | false)[]) =>\n" +
        '  args.filter(Boolean).join(" ").replace(/\\s\\s+/g, " ");\n' +
        "export default clx;\n",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "local-framework-duplicate")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].file).toBe("src/sdk/clx.ts");
    expect(r.findings[0].message).toContain("pure dup");
    expect(r.findings[0].meta?.id).toBe("clx");
    expect(r.findings[0].meta?.safeToAutoFix).toBe(true);
    expect(r.findings[0].meta?.canonicalImport).toBe("@decocms/start/sdk/clx");
  });

  it("flags src/sdk/clx.ts when site adds a clsx alias (signature still matches)", () => {
    const fs = makeFs({
      "/site/src/sdk/clx.ts":
        "export const clx = (...args: (string | null | undefined | false)[]) =>\n" +
        '  args.filter(Boolean).join(" ").replace(/\\s\\s+/g, " ");\n' +
        "export const clsx = clx;\n" +
        "export default clx;\n",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "local-framework-duplicate")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].meta?.id).toBe("clx");
    expect(r.findings[0].meta?.safeToAutoFix).toBe(true);
  });

  it("does NOT flag a clx.ts that has been forked (signature mismatch)", () => {
    const fs = makeFs({
      // Realistic fork: uses lodash-style cn from a different package.
      "/site/src/sdk/clx.ts":
        'import { cn } from "lodash";\nexport const clx = cn;\nexport default clx;\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "local-framework-duplicate")!;
    expect(r.findings).toEqual([]);
  });

  it("flags src/sdk/useSendEvent.ts as warn-only (typing regression risk)", () => {
    const fs = makeFs({
      "/site/src/sdk/useSendEvent.ts":
        'import { AnalyticsEvent } from "@decocms/apps/commerce/types";\n' +
        "export const useSendEvent = <E extends AnalyticsEvent>(\n" +
        "  { event, on }: { event: E; on: 'click' | 'view' | 'change' },\n" +
        ") => ({\n" +
        '  "data-event": encodeURIComponent(JSON.stringify(event)),\n' +
        '  "data-event-trigger": on,\n' +
        "});\n",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "local-framework-duplicate")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].file).toBe("src/sdk/useSendEvent.ts");
    expect(r.findings[0].message).toContain("partial overlap");
    expect(r.findings[0].meta?.safeToAutoFix).toBe(false);
    expect(r.findings[0].fix).toContain("typed AnalyticsEvent generic");
  });

  it("flags src/sdk/url.ts as warn-only (positional bool → options object call-site rewrite)", () => {
    const fs = makeFs({
      "/site/src/sdk/url.ts":
        "export const relative = (\n" +
        "  link?: string | undefined,\n" +
        "  removeIdSku?: boolean,\n" +
        ") => {\n" +
        '  const linkUrl = link ? new URL(link, "http://localhost") : undefined;\n' +
        "  if (linkUrl && removeIdSku) {\n" +
        '    linkUrl.searchParams.delete("idsku");\n' +
        '    linkUrl.searchParams.delete("skuId");\n' +
        "  }\n" +
        "  return linkUrl ? `${linkUrl.pathname}` : undefined;\n" +
        "};\n",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "local-framework-duplicate")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].file).toBe("src/sdk/url.ts");
    expect(r.findings[0].meta?.id).toBe("url-relative");
    expect(r.findings[0].meta?.safeToAutoFix).toBe(false);
    expect(r.findings[0].meta?.canonicalImport).toBe(
      "@decocms/apps/commerce/sdk/url",
    );
    expect(r.findings[0].fix).toContain("stripSearchParams");
  });

  it("flags src/sdk/useSuggestions.ts as warn-only (factory rewrite needed)", () => {
    const fs = makeFs({
      "/site/src/sdk/useSuggestions.ts":
        'import { signal } from "~/sdk/signal";\n' +
        "let queue = Promise.resolve();\n" +
        'let latestQuery = "";\n' +
        "export const useSuggestions = (loader) => {\n" +
        "  const setQuery = (query) => {\n" +
        "    latestQuery = query;\n" +
        '    queue = queue.then(() => fetch(`/deco/invoke/${loader.__resolveType}`));\n' +
        "  };\n" +
        "  return { setQuery };\n" +
        "};\n",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "local-framework-duplicate")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].file).toBe("src/sdk/useSuggestions.ts");
    expect(r.findings[0].meta?.id).toBe("use-suggestions");
    expect(r.findings[0].meta?.safeToAutoFix).toBe(false);
    expect(r.findings[0].meta?.canonicalImport).toBe(
      "@decocms/start/sdk/useSuggestions",
    );
    expect(r.findings[0].fix).toContain("createUseSuggestions");
  });

  it("does NOT flag a useSuggestions.ts that already adopted the factory shim", () => {
    // Sites that completed the W15-B-2 migration end up with a
    // 5-line factory shim — no `latestQuery` or `/deco/invoke/`
    // strings. The rule's signature must NOT fire on the shim.
    const fs = makeFs({
      "/site/src/sdk/useSuggestions.ts":
        'import { createUseSuggestions } from "@decocms/start/sdk/useSuggestions";\n' +
        'import * as Sentry from "@sentry/react";\n' +
        "export const { useSuggestions } = createUseSuggestions({\n" +
        "  onError: (err) => Sentry.captureException(err),\n" +
        "});\n",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "local-framework-duplicate")!;
    const finding = r.findings.find((f) => f.meta?.id === "use-suggestions");
    expect(finding).toBeUndefined();
  });

  it("does NOT flag a forked url.ts that no longer carries the removeIdSku flag", () => {
    // A site that already adopted an options-object-shaped local helper
    // should not be flagged — the rule's signature is anchored on the
    // legacy positional-boolean shape.
    const fs = makeFs({
      "/site/src/sdk/url.ts":
        "export const relative = (link?: string, options?: { stripSearchParams?: string[] }) => {\n" +
        '  if (!link) return undefined;\n' +
        '  return new URL(link, "https://localhost").pathname;\n' +
        "};\n",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "local-framework-duplicate")!;
    // url-relative entry must NOT fire on the canonical-shaped local fork.
    const urlFinding = r.findings.find((f) => f.meta?.id === "url-relative");
    expect(urlFinding).toBeUndefined();
  });

  it("flags src/matchers/location.ts as warn-only (behaviour-superset opportunity)", () => {
    const fs = makeFs({
      "/site/src/matchers/location.ts":
        'import { registerMatcher } from "@decocms/start/cms";\n' +
        "export function registerLocationMatcher(): void {\n" +
        '  registerMatcher("website/matchers/location.ts", (rule, ctx) => {\n' +
        "    const cookies = ctx.cookies ?? {};\n" +
        "    const country = cookies.__cf_geo_country ?? '';\n" +
        "    return Boolean(country);\n" +
        "  });\n" +
        "}\n",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "local-framework-duplicate")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].file).toBe("src/matchers/location.ts");
    expect(r.findings[0].meta?.safeToAutoFix).toBe(false);
    expect(r.findings[0].fix).toContain("registerBuiltinMatchers");
  });

  it("emits zero findings on a clean tree (no duplicates present)", () => {
    const fs = makeFs({
      "/site/src/sections/Hello.tsx":
        'import { clx } from "@decocms/start/sdk/clx";\nexport default () => <div className={clx("a")}>x</div>;\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "local-framework-duplicate")!;
    expect(r.findings).toEqual([]);
  });

  it("emits warning severity for both auto-fixable AND warn-only entries (--strict gates everything)", () => {
    const fs = makeFs({
      "/site/src/sdk/clx.ts":
        'export const clx = (...args: any[]) => args.filter(Boolean).join(" ").replace(/\\s\\s+/g, " ");\n',
      "/site/src/sdk/useSendEvent.ts":
        'export const useSendEvent = (e: any) => ({ "data-event": encodeURIComponent(JSON.stringify(e)) });\n',
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "local-framework-duplicate")!;
    for (const f of r.findings) expect(f.severity).toBe("warning");
  });

  it("auto-fix rewrites importers using ~/sdk/clx and deletes the file", () => {
    const { fs, writer, store } = makeMutableFs({
      "/site/src/sdk/clx.ts":
        'export const clx = (...args: any[]) => args.filter(Boolean).join(" ").replace(/\\s\\s+/g, " ");\n',
      "/site/src/components/A.tsx":
        'import { clx } from "~/sdk/clx";\nexport default () => clx("x");\n',
      "/site/src/components/B.tsx":
        'import { clx } from "~/sdk/clx";\nimport React from "react";\nexport default () => clx("y");\n',
      "/site/src/components/Unrelated.tsx":
        'import { clx } from "@decocms/start/sdk/clx";\nexport default () => clx("z");\n',
    });
    const report = runAudit(SITE, fs, { writer });
    const r = report.rules.find((r) => r.rule === "local-framework-duplicate")!;
    expect(r.fixes).toBeDefined();
    expect(r.fixes!.length).toBe(1);
    expect(r.fixes![0].kind).toBe("rewrite-imports+delete");
    expect(r.fixes![0].detail).toContain("rewrote 2 import(s)");
    // File deleted from the in-memory store
    expect(store["/site/src/sdk/clx.ts"]).toBeUndefined();
    // Importers rewritten
    expect(store["/site/src/components/A.tsx"]).toContain(
      'from "@decocms/start/sdk/clx"',
    );
    expect(store["/site/src/components/B.tsx"]).toContain(
      'from "@decocms/start/sdk/clx"',
    );
    // Already-canonical import untouched
    expect(store["/site/src/components/Unrelated.tsx"]).toContain(
      'from "@decocms/start/sdk/clx"',
    );
    expect(store["/site/src/components/Unrelated.tsx"]).not.toMatch(/~\/sdk\/clx/);
  });

  it("auto-fix is a no-op for warn-only entries (does NOT delete partial-overlap files)", () => {
    const { fs, writer, store } = makeMutableFs({
      "/site/src/sdk/useSendEvent.ts":
        'import { AnalyticsEvent } from "@decocms/apps/commerce/types";\n' +
        "export const useSendEvent = <E extends AnalyticsEvent>() => ({\n" +
        '  "data-event": encodeURIComponent("x"),\n' +
        "});\n",
      "/site/src/matchers/location.ts":
        'import { registerMatcher } from "@decocms/start/cms";\n' +
        'registerMatcher("website/matchers/location.ts", () => Boolean(__cf_geo_country));\n',
    });
    const report = runAudit(SITE, fs, { writer });
    const r = report.rules.find((r) => r.rule === "local-framework-duplicate")!;
    expect(r.findings.length).toBe(2);
    // Both fixes are no-ops because safeToAutoFix === false.
    expect(r.fixes ?? []).toEqual([]);
    // Files preserved.
    expect(store["/site/src/sdk/useSendEvent.ts"]).toBeDefined();
    expect(store["/site/src/matchers/location.ts"]).toBeDefined();
  });

  it("auto-fix runs only on auto-fixable entries when both kinds coexist", () => {
    const { fs, writer, store } = makeMutableFs({
      "/site/src/sdk/clx.ts":
        'export const clx = (...args: any[]) => args.filter(Boolean).join(" ").replace(/\\s\\s+/g, " ");\n',
      "/site/src/sdk/useSendEvent.ts":
        'export const useSendEvent = (e: any) => ({ "data-event": encodeURIComponent(JSON.stringify(e)) });\n',
      "/site/src/components/A.tsx":
        'import { clx } from "~/sdk/clx";\nexport default () => clx("x");\n',
    });
    const report = runAudit(SITE, fs, { writer });
    const r = report.rules.find((r) => r.rule === "local-framework-duplicate")!;
    expect(r.findings.length).toBe(2);
    expect(r.fixes!.length).toBe(1); // only clx auto-fixed
    expect(r.fixes![0].file).toBe("src/sdk/clx.ts");
    expect(store["/site/src/sdk/clx.ts"]).toBeUndefined();
    expect(store["/site/src/sdk/useSendEvent.ts"]).toBeDefined();
  });

  it("supportsAutoFix is true (the rule has applyFix even though some entries are warn-only)", () => {
    const fs = makeFs({});
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "local-framework-duplicate")!;
    expect(r.supportsAutoFix).toBe(true);
  });
});

describe("rule: lockfile-multiple", () => {
  it("flags package-lock.json and yarn.lock when bun.lock exists", () => {
    const fs = makeFs({
      "/site/package.json": "{}",
      "/site/bun.lock": "{}",
      "/site/package-lock.json": "{}",
      "/site/yarn.lock": "",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "lockfile-multiple")!;
    expect(r.findings.map((f) => f.file).sort()).toEqual(["package-lock.json", "yarn.lock"]);
  });

  it("does not flag when only bun.lock is present", () => {
    const fs = makeFs({
      "/site/package.json": "{}",
      "/site/bun.lock": "{}",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "lockfile-multiple")!;
    expect(r.findings).toEqual([]);
  });

  it("does not fire when bun.lock is absent (lockfile-missing handles that case)", () => {
    const fs = makeFs({
      "/site/package.json": "{}",
      "/site/package-lock.json": "{}",
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "lockfile-multiple")!;
    expect(r.findings).toEqual([]);
  });

  it("--fix deletes the offending lockfiles", () => {
    const { fs, writer, store } = makeMutableFs({
      "/site/package.json": "{}",
      "/site/bun.lock": "{}",
      "/site/package-lock.json": "{}",
      "/site/yarn.lock": "",
    });
    runAudit(SITE, fs, { writer });
    expect(store["/site/package-lock.json"]).toBeUndefined();
    expect(store["/site/yarn.lock"]).toBeUndefined();
    expect(store["/site/bun.lock"]).toBeDefined();
  });
});

describe("rule: lockfile-missing", () => {
  it("fires when package.json exists without bun.lock", () => {
    const fs = makeFs({ "/site/package.json": "{}" });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "lockfile-missing")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].file).toBe("bun.lock");
    expect(r.findings[0].fix).toContain("bun install");
  });

  it("does not fire when bun.lock exists", () => {
    const fs = makeFs({ "/site/package.json": "{}", "/site/bun.lock": "{}" });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "lockfile-missing")!;
    expect(r.findings).toEqual([]);
  });

  it("does not fire on a directory without package.json", () => {
    const fs = makeFs({});
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "lockfile-missing")!;
    expect(r.findings).toEqual([]);
  });
});

describe("rule: lockfile-drift", () => {
  it("flags a caret range whose locked version is below the floor", () => {
    const pkg = JSON.stringify({
      dependencies: { "@decocms/apps": "^1.11.0" },
    });
    const lock = `"@decocms/apps@1.6.2"\n`;
    const fs = makeFs({
      "/site/package.json": pkg,
      "/site/bun.lock": lock,
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "lockfile-drift")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].fix).toContain("@decocms/apps");
  });

  it("does not flag when locked version satisfies the caret range", () => {
    const pkg = JSON.stringify({
      dependencies: { "@decocms/apps": "^1.11.0" },
    });
    const lock = `"@decocms/apps@1.13.2"\n`;
    const fs = makeFs({
      "/site/package.json": pkg,
      "/site/bun.lock": lock,
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "lockfile-drift")!;
    expect(r.findings).toEqual([]);
  });

  it("flags a dep that's missing from bun.lock entirely", () => {
    const pkg = JSON.stringify({
      dependencies: { "missing-pkg": "^1.0.0" },
    });
    const fs = makeFs({
      "/site/package.json": pkg,
      "/site/bun.lock": `"other-pkg@1.0.0"\n`,
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "lockfile-drift")!;
    expect(r.findings).toHaveLength(1);
  });

  it("treats * / latest / git specs as satisfied by mere presence", () => {
    const pkg = JSON.stringify({
      dependencies: {
        "loose-dep": "*",
        "latest-dep": "latest",
      },
    });
    const lock = `"loose-dep@9.9.9"\n"latest-dep@0.0.1"\n`;
    const fs = makeFs({
      "/site/package.json": pkg,
      "/site/bun.lock": lock,
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "lockfile-drift")!;
    expect(r.findings).toEqual([]);
  });

  it("considers devDependencies too", () => {
    const pkg = JSON.stringify({
      devDependencies: { typescript: "~5.9.0" },
    });
    const lock = `"typescript@5.8.0"\n`;
    const fs = makeFs({
      "/site/package.json": pkg,
      "/site/bun.lock": lock,
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "lockfile-drift")!;
    expect(r.findings).toHaveLength(1);
  });

  it("internals: satisfiesRange handles caret, tilde, exact, and sentinels", () => {
    const { satisfiesRange } = _internals;
    expect(satisfiesRange("1.13.2", "^1.11.0")).toBe(true);
    expect(satisfiesRange("1.6.2", "^1.11.0")).toBe(false);
    expect(satisfiesRange("2.0.0", "^1.11.0")).toBe(false);
    expect(satisfiesRange("0.5.3", "^0.5.0")).toBe(true);
    expect(satisfiesRange("0.6.0", "^0.5.0")).toBe(false);
    expect(satisfiesRange("5.9.5", "~5.9.0")).toBe(true);
    expect(satisfiesRange("5.10.0", "~5.9.0")).toBe(false);
    expect(satisfiesRange("1.2.3", "1.2.3")).toBe(true);
    expect(satisfiesRange("1.2.4", "1.2.3")).toBe(false);
    expect(satisfiesRange("1.2.3", "*")).toBeNull();
    expect(satisfiesRange("1.2.3", "latest")).toBeNull();
    expect(satisfiesRange("1.2.3", "git+https://...")).toBeNull();
  });
});

describe("rule: package-manager-missing", () => {
  it("fires when packageManager is absent", () => {
    const fs = makeFs({
      "/site/package.json": JSON.stringify({ name: "x", license: "MIT" }),
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "package-manager-missing")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].fix).toContain("bun@");
  });

  it("does not fire when packageManager is set", () => {
    const fs = makeFs({
      "/site/package.json": JSON.stringify({
        name: "x",
        packageManager: "bun@1.3.5",
      }),
    });
    const report = runAudit(SITE, fs);
    const r = report.rules.find((r) => r.rule === "package-manager-missing")!;
    expect(r.findings).toEqual([]);
  });

  it("--fix writes packageManager directly after license, preserving other keys", () => {
    const initial = JSON.stringify({
      name: "x",
      version: "1.0.0",
      license: "MIT",
      dependencies: { foo: "^1.0.0" },
    });
    const { fs, writer, store } = makeMutableFs({
      "/site/package.json": initial,
    });
    runAudit(SITE, fs, { writer });
    const updated = JSON.parse(store["/site/package.json"]);
    expect(updated.packageManager).toMatch(/^bun@/);
    const keys = Object.keys(updated);
    expect(keys.indexOf("packageManager")).toBe(keys.indexOf("license") + 1);
    expect(updated.dependencies).toEqual({ foo: "^1.0.0" });
  });

  it("--fix appends packageManager when license is absent", () => {
    const { fs, writer, store } = makeMutableFs({
      "/site/package.json": JSON.stringify({ name: "x" }),
    });
    runAudit(SITE, fs, { writer });
    const updated = JSON.parse(store["/site/package.json"]);
    expect(updated.packageManager).toMatch(/^bun@/);
  });
});
