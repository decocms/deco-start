/**
 * KVBlockSource — a `BlockSource` backed by a Cloudflare KV namespace.
 *
 * Reads the whole decofile snapshot (`decofile:current`) and its revision
 * (`index:revision`) from KV. Used by the runtime hydration path
 * (`src/sdk/kvHydration.ts`) on cold start and during revision polling, and by
 * the write-through path (`src/admin/decofile.ts`) which writes the same keys.
 *
 * This class is intentionally thin — error handling (KV outages, JSON parse
 * failures) is the caller's responsibility so the framework can fall back to
 * the bundled snapshot. See `kvHydration.ts`.
 */

import {
  type BlockSnapshot,
  type BlockSource,
  computeRevision,
  KV_KEYS,
  type KVNamespace,
} from "./blockSource";

export class KVBlockSource implements BlockSource {
  constructor(private readonly kv: KVNamespace) {}

  /**
   * Read and parse the full decofile snapshot from KV.
   *
   * Returns `null` when no snapshot is present (key missing) so the caller
   * keeps whatever blocks are already in memory (the bundled fallback).
   *
   * The stored revision is preferred; if it's absent we recompute it from the
   * blocks so the result is always self-consistent. A malformed snapshot
   * (invalid JSON / non-object) throws — the caller treats that as "KV
   * unavailable" and falls back.
   */
  async loadSnapshot(): Promise<BlockSnapshot | null> {
    const raw = await this.kv.get(KV_KEYS.SNAPSHOT);
    if (raw === null) return null;

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`[CMS/KV] ${KV_KEYS.SNAPSHOT} is not a JSON object`);
    }
    const blocks = parsed as Record<string, unknown>;

    const storedRevision = await this.kv.get(KV_KEYS.REVISION);
    return { blocks, revision: storedRevision ?? computeRevision(blocks) };
  }

  /** Cheap revision probe for change detection (no full snapshot transfer). */
  getRevision(): Promise<string | null> {
    return this.kv.get(KV_KEYS.REVISION);
  }
}
