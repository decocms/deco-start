/**
 * Shared fast-deploy snapshot helpers for the CI scripts.
 *
 * Both `migrate-blocks-to-kv.ts` and `sync-blocks-to-kv.ts` write the same two
 * keys (`decofile:current` + `index:revision`). The revision is computed with
 * the SAME `computeRevision` the runtime uses (`src/cms/blockSource.ts`) so a
 * hydrating isolate computes a matching revision and the poller doesn't loop.
 */

import { computeRevision, KV_KEYS } from "../../src/cms/blockSource";
import type { KvRestClient } from "./cf-kv-rest";

export interface Snapshot {
  /** Serialized decofile written to `decofile:current`. */
  snapshot: string;
  /** DJB2 revision written to `index:revision`. */
  revision: string;
  /** Block count, for logging. */
  count: number;
}

export function buildSnapshot(blocks: Record<string, unknown>): Snapshot {
  return {
    snapshot: JSON.stringify(blocks),
    revision: computeRevision(blocks),
    count: Object.keys(blocks).length,
  };
}

/** Write the snapshot + revision to KV. Snapshot first, then revision, so a
 * poller never sees a new revision pointing at an old snapshot. */
export async function writeSnapshotToKv(client: KvRestClient, snap: Snapshot): Promise<void> {
  await client.put(KV_KEYS.SNAPSHOT, snap.snapshot);
  await client.put(KV_KEYS.REVISION, snap.revision);
}

/** Read both keys back and confirm the revision matches what we wrote. */
export async function verifySnapshotInKv(
  client: KvRestClient,
  expectedRevision: string,
): Promise<{ ok: boolean; reason?: string }> {
  const [snapshot, revision] = await Promise.all([
    client.get(KV_KEYS.SNAPSHOT),
    client.get(KV_KEYS.REVISION),
  ]);
  if (snapshot === null) return { ok: false, reason: `${KV_KEYS.SNAPSHOT} missing` };
  if (revision !== expectedRevision) {
    return { ok: false, reason: `${KV_KEYS.REVISION} is "${revision}", expected "${expectedRevision}"` };
  }
  return { ok: true };
}
