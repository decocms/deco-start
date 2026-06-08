#!/usr/bin/env tsx
/**
 * One-shot fast-deploy migration: populate Cloudflare KV from a site's
 * bundled decofile so the worker can serve content KV-first.
 *
 * Reads `.deco/blocks/*.json` (the same merge the block generator does),
 * writes `decofile:current` + `index:revision` to the site's KV namespace via
 * the REST API, then reads both keys back to verify. Run ONCE per site before
 * flipping it to KV-first (i.e. before adding the `DECO_KV` binding +
 * deploying the fast-deploy framework version).
 *
 * Usage (from the site root):
 *   # dry-run (default): reads blocks, prints what would be written, no writes
 *   CF_ACCOUNT_ID=... CF_KV_NAMESPACE_ID=... CF_API_TOKEN=... \
 *     npx -p @decocms/start deco-migrate-blocks-to-kv
 *   # apply:
 *   ... npx -p @decocms/start deco-migrate-blocks-to-kv --write
 *
 * Options:
 *   --blocks-dir <dir>   Input blocks dir (default: .deco/blocks)
 *   --write              Perform the KV writes (otherwise dry-run, exit 0)
 *   --help, -h           Show this help
 *
 * Env:
 *   CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID, CF_API_TOKEN  (required with --write)
 *
 * Exit codes: 0 ok / dry-run; 2 error (bad dir, missing env, verify failed)
 */

import * as path from "node:path";
import { createKvRestClient, kvConfigFromEnv } from "./lib/cf-kv-rest";
import { buildSnapshot, verifySnapshotInKv, writeSnapshotToKv } from "./lib/kv-snapshot";
import { readDecofileFromDir } from "./lib/read-decofile";

function parseArgs(argv: string[]) {
  const has = (f: string) => argv.includes(f);
  const val = (f: string, d: string) => {
    const i = argv.indexOf(f);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  return {
    help: has("--help") || has("-h"),
    write: has("--write"),
    blocksDir: val("--blocks-dir", ".deco/blocks"),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "Usage: deco-migrate-blocks-to-kv [--blocks-dir .deco/blocks] [--write]\n" +
        "Env: CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID, CF_API_TOKEN",
    );
    process.exit(0);
  }

  const blocksDir = path.resolve(process.cwd(), opts.blocksDir);

  let blocks: Record<string, unknown>;
  try {
    const result = readDecofileFromDir(blocksDir);
    blocks = result.blocks;
    if (result.collisions.length) {
      console.warn(`warning: ${result.collisions.length} filename collision(s) resolved by tie-break`);
    }
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const snap = buildSnapshot(blocks);
  console.log(`decofile: ${snap.count} blocks, revision ${snap.revision}, ${snap.snapshot.length} bytes`);

  if (!opts.write) {
    console.log("\nDry-run only. Re-run with --write to populate KV.");
    process.exit(0);
  }

  let client: ReturnType<typeof createKvRestClient>;
  try {
    client = createKvRestClient(kvConfigFromEnv());
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  try {
    await writeSnapshotToKv(client, snap);
    const verify = await verifySnapshotInKv(client, snap.revision);
    if (!verify.ok) {
      console.error(`error: KV verify failed — ${verify.reason}`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  console.log(`\nwrote + verified decofile:current (rev ${snap.revision}) → KV.`);
  console.log("Next: add the DECO_KV binding in wrangler.toml and deploy the fast-deploy build.");
}

main();
