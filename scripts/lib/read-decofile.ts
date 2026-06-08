/**
 * Read a `.deco/blocks/*.json` directory into a single decofile map.
 *
 * This is the same merge the block generator performs (filename → decoded
 * block key, with collision tie-breaking via `pickWinner`), factored out so
 * the fast-deploy CI scripts (`migrate-blocks-to-kv.ts`, `sync-blocks-to-kv.ts`)
 * produce a decofile byte-identical to the bundled `blocks.gen` snapshot.
 *
 * Reuses `scripts/lib/blocks-dedupe.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  blockHasPath,
  type Candidate,
  type CollisionRecord,
  decodeBlockNameWithPasses,
  mergeCandidates,
} from "./blocks-dedupe";

export interface ReadDecofileResult {
  /** Decoded block key → parsed block JSON. */
  blocks: Record<string, unknown>;
  /** Filename collisions (same decoded key from multiple files). */
  collisions: CollisionRecord[];
}

/**
 * Read and merge every `*.json` under `blocksDir` into a decofile map.
 * Throws if the directory does not exist. Unparseable files are skipped
 * (logged unless `silent`).
 */
export function readDecofileFromDir(blocksDir: string, opts: { silent?: boolean } = {}): ReadDecofileResult {
  if (!fs.existsSync(blocksDir)) {
    throw new Error(`blocks directory not found: ${blocksDir}`);
  }

  const files = fs.readdirSync(blocksDir).filter((f) => f.endsWith(".json"));
  const candidatesWithKeys: Array<{ candidate: Candidate; key: string }> = [];

  for (const file of files) {
    const { name, passes } = decodeBlockNameWithPasses(file);
    const fp = path.join(blocksDir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(fp, "utf-8"));
    } catch (e) {
      if (!opts.silent) console.warn(`Failed to parse ${file}:`, e);
      continue;
    }
    candidatesWithKeys.push({
      key: name,
      candidate: {
        file,
        passes,
        mtimeMs: fs.statSync(fp).mtimeMs,
        hasPath: blockHasPath(parsed),
        parsed,
      },
    });
  }

  const { winners, collisions } = mergeCandidates(candidatesWithKeys);
  const blocks: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(winners)) {
    blocks[key] = candidate.parsed;
  }
  return { blocks, collisions };
}
