/**
 * BlockSource — the runtime source of truth for the CMS decofile.
 *
 * A `BlockSource` asynchronously yields the *whole* decofile snapshot (the
 * `Record<string, unknown>` blocks map) plus its revision hash. This is the
 * "fast deploy" seam: the framework can hydrate the in-memory block map from a
 * remote source (Cloudflare KV) on cold start and swap it on revision change,
 * WITHOUT making the synchronous resolution hot path (`loadBlocks()` in
 * `loader.ts`) async.
 *
 * Design note (whole-snapshot vs per-block): the resolver calls `loadBlocks()`
 * synchronously in dozens of places (matchers, deferral checks, page lookup,
 * SEO). Rather than threading `async` through all of that, a `BlockSource`
 * loads the entire decofile once and the framework calls `setBlocks()` to swap
 * the in-memory map. Per-request reads stay in-memory (zero added latency); KV
 * is touched only on cold start and during the opportunistic revision poll.
 *
 * Mirrors the `DecofileProvider` pattern from the original deco-cx/deco Fresh
 * runtime (`engine/decofile/provider.ts`), trimmed to what the snapshot-swap
 * model needs.
 */

import { djb2Hex } from "../sdk/djb2";

/** A fully-loaded decofile snapshot: the blocks map and its revision hash. */
export interface BlockSnapshot {
  /** The decofile — a flat map of block name → block JSON. */
  blocks: Record<string, unknown>;
  /** DJB2 hex revision computed over the blocks (see `computeRevision`). */
  revision: string;
}

/**
 * Source of the runtime decofile snapshot.
 *
 * Implementations:
 * - `BundledBlockSource` — the build-time `blocks.gen` snapshot (fallback /
 *   local dev). A no-op here because `setup.ts` already loads it via
 *   `setBlocks()` at module init.
 * - `KVBlockSource` (PR2) — reads `decofile:current` + `index:revision` from a
 *   Cloudflare KV namespace.
 */
export interface BlockSource {
  /**
   * Load the full decofile snapshot. Returns `null` when this source has no
   * snapshot to offer (e.g. KV key missing, or the bundled source which is
   * already applied at startup) — the caller then keeps whatever blocks are
   * currently in memory.
   */
  loadSnapshot(): Promise<BlockSnapshot | null>;

  /**
   * Cheap revision probe used for change detection during polling. Returns the
   * current revision without transferring the full snapshot, or `null` when
   * unavailable.
   */
  getRevision(): Promise<string | null>;
}

/**
 * Compute the revision hash for a blocks map.
 *
 * MUST match `computeRevision` in `loader.ts` (DJB2 over the JSON string) so
 * that a snapshot written to KV and the revision stored alongside it agree
 * with the revision an isolate computes after `setBlocks()` — otherwise the
 * poller would see a permanent mismatch and reload on every tick.
 */
export function computeRevision(blocks: Record<string, unknown>): string {
  return djb2Hex(JSON.stringify(blocks));
}

/**
 * Bundled (build-time) snapshot source.
 *
 * Intentionally a no-op `loadSnapshot()`: the bundled `blocks.gen` is applied
 * by `createSiteSetup()` → `setBlocks()` at module load, before any request.
 * This exists so callers can treat "bundled" uniformly through the
 * `BlockSource` interface and so the composition layer (KV primary + bundled
 * fallback) has a concrete fallback object.
 */
export class BundledBlockSource implements BlockSource {
  loadSnapshot(): Promise<BlockSnapshot | null> {
    return Promise.resolve(null);
  }

  getRevision(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

// ---------------------------------------------------------------------------
// Minimal Cloudflare KV type
// ---------------------------------------------------------------------------

/**
 * Minimal structural type for a Cloudflare KV namespace binding.
 *
 * Declared locally (matching the pattern in `workerEntry.ts`, which defines
 * its own `WorkerExecutionContext`) so `@decocms/start` does not depend on
 * `@cloudflare/workers-types`. Only the methods the framework actually uses
 * are modeled.
 */
export interface KVNamespace {
  get(key: string, options?: { type?: "text" }): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: Record<string, unknown> },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// KV key names — shared by the runtime reader (PR2), the write-through path
// (PR3), and the CI sync/migrate scripts (PR4). Single source of truth so the
// contract can't drift between read and write sides.
// ---------------------------------------------------------------------------

export const KV_KEYS = {
  /** Full decofile JSON (the blocks map). */
  SNAPSHOT: "decofile:current",
  /** DJB2 hex revision of the snapshot — polled for change detection. */
  REVISION: "index:revision",
} as const;
