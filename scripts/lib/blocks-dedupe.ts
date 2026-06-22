/**
 * Pure helpers used by `generate-blocks.ts` to choose between multiple files
 * that decode to the same logical CMS block key.
 *
 * Background: the live decofile snapshot lives under `.deco/blocks/`, with
 * one file per block. The filename is `encodeURIComponent(<rawProdKey>) +
 * ".json"`. The Deco admin sometimes serves URL-encoded keys (e.g.
 * `pages-Home%20-%20LB-618509`), so a single block can land on disk with
 * different filenames depending on which writer produced it:
 *
 *   - The `deco-sync-bot` (CI) encodes the raw prod key as-is, producing
 *     `pages-Home%2520-%2520LB-618509.json` (two decode passes back to the
 *     literal key).
 *   - The legacy manual `sync-decofile.ts` decoded keys to literal first,
 *     so it wrote `pages-Home%20-%20LB-618509.json` (one decode pass).
 *
 * Both files decode to the same logical key, so the block generator must
 * pick one. Picking by file size is wrong (a shrunk live page gives a
 * smaller JSON than the stale older snapshot, so size silently prefers
 * stale); picking by mtime alone is wrong (fresh `git clone` writes all
 * files with the clone time and erases temporal ordering).
 */

export interface Candidate {
  file: string;
  passes: number;
  mtimeMs: number;
  hasPath: boolean;
  parsed: unknown;
}

/**
 * Repeatedly URL-decode the basename of `filename` until no `%` sequence
 * remains. Returns the fully-decoded canonical key plus the number of
 * decode rounds it took. Higher pass count = the writer encoded a key
 * that itself contained `%XX` sequences = bot scheme. See module-level
 * comment for why this matters.
 */
export function decodeBlockNameWithPasses(filename: string): {
  name: string;
  passes: number;
} {
  let name = filename.replace(/\.json$/, "");
  let passes = 0;
  while (name.includes("%")) {
    try {
      const next = decodeURIComponent(name);
      if (next === name) break;
      name = next;
      passes++;
    } catch {
      break;
    }
  }
  return { name, passes };
}

export function decodeBlockName(filename: string): string {
  return decodeBlockNameWithPasses(filename).name;
}

/**
 * Decode the filename stem exactly once — matches the Deno runtime's
 * `parseBlockId`. Use this for the decofile key so that the CMS editor's
 * `encodeURIComponent(blockKey)` round-trips back to the original filename.
 */
export function singleDecodeBlockName(filename: string): string {
  const stem = filename.replace(/\.json$/, "");
  try {
    return decodeURIComponent(stem);
  } catch {
    return stem;
  }
}

/**
 * Tie-break two candidates that decode to the same key. Priority:
 *   1. Block has a non-null `path`     — beats zombie/orphan entries.
 *   2. More decode passes              — bot's "encode raw prod key"
 *                                        scheme wins over legacy
 *                                        "decode-then-encode" leftovers
 *                                        when prod uses URL-encoded keys
 *                                        (the only case that collides).
 *   3. Newer mtime                     — last-write-wins for same scheme.
 *   4. Lexicographic filename          — deterministic last resort.
 */
export function pickWinner(a: Candidate, b: Candidate): Candidate {
  if (a.hasPath !== b.hasPath) return a.hasPath ? a : b;
  if (a.passes !== b.passes) return a.passes > b.passes ? a : b;
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs > b.mtimeMs ? a : b;
  return a.file < b.file ? a : b;
}

/** True iff a parsed block JSON looks like a live page (non-empty `.path`). */
export function blockHasPath(parsed: unknown): boolean {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    "path" in parsed &&
    typeof (parsed as { path?: unknown }).path === "string" &&
    (parsed as { path: string }).path.length > 0
  );
}

export interface CollisionRecord {
  key: string;
  files: string[];
  winner: string;
}

export interface MergeResult {
  winners: Record<string, Candidate>;
  collisions: CollisionRecord[];
}

/**
 * Reduce a list of candidates into one winner per decoded key, recording
 * every collision so the caller can surface it as a build warning.
 */
export function mergeCandidates(
  candidates: Array<{ candidate: Candidate; key: string }>,
): MergeResult {
  const winners: Record<string, Candidate> = {};
  // Track every file that decoded to a given key so three-way (and beyond)
  // collisions don't lose the eventual winner from the file list.
  const filesByKey: Record<string, string[]> = {};
  for (const { candidate, key } of candidates) {
    if (!filesByKey[key]) filesByKey[key] = [];
    const list = filesByKey[key];
    if (!list.includes(candidate.file)) list.push(candidate.file);

    const existing = winners[key];
    winners[key] = existing ? pickWinner(existing, candidate) : candidate;
  }

  const collisions: CollisionRecord[] = [];
  for (const [key, files] of Object.entries(filesByKey)) {
    if (files.length < 2) continue;
    collisions.push({ key, files, winner: winners[key].file });
  }
  return { winners, collisions };
}
