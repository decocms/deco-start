/**
 * Pure helpers for `sync-blocks-to-kv.ts` — kept separate from the CLI so they
 * can be unit-tested without executing the script's `main()`.
 */

import { decodeBlockName } from "./blocks-dedupe";

/**
 * Parse `git diff --name-only` output into the set of changed block files that
 * live under `blocksDir`. Paths are POSIX (git always emits forward slashes).
 */
export function changedBlockFiles(gitOutput: string, blocksDir: string): string[] {
  const prefix = blocksDir.replace(/\\/g, "/").replace(/\/$/, "");
  return gitOutput
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => l.startsWith(`${prefix}/`) && l.endsWith(".json"));
}

/** Map changed block-file paths to their decoded block keys. */
export function changedBlockKeys(files: string[]): string[] {
  return files.map((f) => decodeBlockName(f.split("/").pop() ?? f));
}

/**
 * Derive the page paths to purge from the changed block keys. Only page blocks
 * carrying a string `path` contribute; "/" is always included so the home page
 * (and anything edge-cached under the static profile) is refreshed.
 */
export function purgePathsForChangedKeys(
  blocks: Record<string, unknown>,
  changedKeys: string[],
): string[] {
  const paths = new Set<string>(["/"]);
  for (const key of changedKeys) {
    const block = blocks[key];
    if (block && typeof block === "object" && !Array.isArray(block)) {
      const p = (block as { path?: unknown }).path;
      if (typeof p === "string" && p.length > 0) paths.add(p);
    }
  }
  return [...paths];
}
