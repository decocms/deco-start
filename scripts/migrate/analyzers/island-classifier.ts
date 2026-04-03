import * as fs from "node:fs";
import * as path from "node:path";
import type { MigrationContext, IslandClassification } from "../types.ts";
import { log } from "../types.ts";

const REEXPORT_RE = /^export\s+\{\s*default\s*\}\s+from\s+["']([^"']+)["']/m;
const THIN_WRAPPER_RE = /^import\s+(\w+)\s+from\s+["']([^"']+)["']/m;
const RETURN_COMPONENT_RE = /return\s+<\s*\w+\s+\{\.\.\.props\}/;

/**
 * Classify each island file as either a thin wrapper (re-export or
 * trivial bridge component) or a standalone file with real logic.
 *
 * Wrappers are deleted — their imports are repointed to the target component.
 * Standalone islands are moved to src/components/.
 */
export function classifyIslands(ctx: MigrationContext): void {
  const islandFiles = ctx.files.filter((f) => f.category === "island");

  for (const file of islandFiles) {
    let content: string;
    try {
      content = fs.readFileSync(file.absPath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    const nonEmptyLines = lines.filter((l) => l.trim().length > 0);
    const lineCount = nonEmptyLines.length;

    // Check for single-line re-export: export { default } from "..."
    const reExportMatch = content.match(REEXPORT_RE);
    if (reExportMatch) {
      ctx.islandClassifications.push({
        path: file.path,
        type: "wrapper",
        wrapsComponent: reExportMatch[1],
        suggestedTarget: `src/${file.path.replace("islands/", "components/")}`,
        lineCount,
      });
      continue;
    }

    // Check for thin wrapper pattern: import X from "...", return <X {...props} />
    if (lineCount <= 15) {
      const importMatch = content.match(THIN_WRAPPER_RE);
      const hasSpreadReturn = RETURN_COMPONENT_RE.test(content);
      if (importMatch && hasSpreadReturn) {
        ctx.islandClassifications.push({
          path: file.path,
          type: "wrapper",
          wrapsComponent: importMatch[2],
          suggestedTarget: `src/${file.path.replace("islands/", "components/")}`,
          lineCount,
        });
        continue;
      }
    }

    // Everything else is standalone
    ctx.islandClassifications.push({
      path: file.path,
      type: "standalone",
      suggestedTarget: `src/${file.path.replace("islands/", "components/")}`,
      lineCount,
    });
  }

  const wrappers = ctx.islandClassifications.filter((c) => c.type === "wrapper").length;
  const standalone = ctx.islandClassifications.filter((c) => c.type === "standalone").length;
  log(ctx, `Islands classified: ${wrappers} wrappers, ${standalone} standalone`);
}
