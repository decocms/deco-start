#!/usr/bin/env tsx
/**
 * CI fast-deploy content sync: push the site's current decofile to KV when
 * content changed, WITHOUT a worker redeploy.
 *
 * Because the runtime swaps whole snapshots (not per-block), this always writes
 * the FULL current decofile (`decofile:current`) and bumps `index:revision`.
 * The default mode first checks whether any `.deco/blocks/*.json` changed since
 * a base ref — if nothing changed, it exits 0 without writing (the "content
 * unchanged → nothing to do" path). `--all` skips that check and always syncs
 * (use post-deploy for bootstrap/paranoia).
 *
 * After writing, it optionally purges the edge cache for the changed pages.
 *
 * Usage (in CI, on push to main):
 *   CF_ACCOUNT_ID=... CF_KV_NAMESPACE_ID=... CF_API_TOKEN=... \
 *     npx -p @decocms/start deco-sync-blocks-to-kv --write \
 *       --since "$GITHUB_BEFORE" --purge-url https://site.example --purge-token "$PURGE_TOKEN"
 *   # bootstrap (always write the whole snapshot):
 *   ... deco-sync-blocks-to-kv --write --all
 *
 * Options:
 *   --all                 Always sync (skip the git-diff content check)
 *   --since <ref>         Base git ref for the diff (default: HEAD~1)
 *   --blocks-dir <dir>    Input blocks dir (default: .deco/blocks)
 *   --purge-url <origin>  Site origin to POST /_cache/purge after sync
 *   --purge-token <tok>   Purge bearer token (or PURGE_TOKEN env)
 *   --write               Perform writes (otherwise dry-run, exit 0)
 *   --help, -h            Show this help
 *
 * Env: CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID, CF_API_TOKEN (required with --write)
 *
 * Exit codes: 0 ok / no-op / dry-run; 2 error (bad dir, missing env, verify failed)
 */

import { execSync } from "node:child_process";
import * as path from "node:path";
import { createKvRestClient, kvConfigFromEnv } from "./lib/cf-kv-rest";
import { buildSnapshot, verifySnapshotInKv, writeSnapshotToKv } from "./lib/kv-snapshot";
import { readDecofileFromDir } from "./lib/read-decofile";
import { changedBlockFiles, changedBlockKeys, purgePathsForChangedKeys } from "./lib/sync-helpers";

function parseArgs(argv: string[]) {
  const has = (f: string) => argv.includes(f);
  const val = (f: string, d: string) => {
    const i = argv.indexOf(f);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  return {
    help: has("--help") || has("-h"),
    all: has("--all"),
    write: has("--write"),
    since: val("--since", "HEAD~1"),
    blocksDir: val("--blocks-dir", ".deco/blocks"),
    purgeUrl: val("--purge-url", ""),
    purgeToken: val("--purge-token", process.env.PURGE_TOKEN ?? ""),
  };
}

function gitChangedFiles(since: string, blocksDir: string): string[] {
  const out = execSync(`git diff --name-only ${since} HEAD`, { encoding: "utf-8" });
  return changedBlockFiles(out, blocksDir);
}

async function purgeCache(origin: string, token: string, paths: string[]): Promise<void> {
  const res = await fetch(new URL("/_cache/purge", origin).toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok) {
    console.warn(`warning: purge failed: ${res.status} ${await res.text()}`);
  } else {
    console.log(`purged ${paths.length} path(s): ${paths.join(", ")}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: deco-sync-blocks-to-kv [--all] [--since <ref>] [--write] [--purge-url <origin>]");
    process.exit(0);
  }

  const blocksDir = path.resolve(process.cwd(), opts.blocksDir);
  const blocksDirRel = opts.blocksDir;

  // Decide whether there's anything to sync.
  let changedKeys: string[] = [];
  if (!opts.all) {
    let changed: string[];
    try {
      changed = gitChangedFiles(opts.since, blocksDirRel);
    } catch (e) {
      console.error(`error: git diff failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
    if (changed.length === 0) {
      console.log(`no ${blocksDirRel} changes since ${opts.since} — nothing to sync.`);
      process.exit(0);
    }
    changedKeys = changedBlockKeys(changed);
    console.log(`${changed.length} changed block file(s) since ${opts.since}.`);
  }

  let blocks: Record<string, unknown>;
  try {
    blocks = readDecofileFromDir(blocksDir).blocks;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const snap = buildSnapshot(blocks);
  const purgePaths = opts.all
    ? ["/"]
    : purgePathsForChangedKeys(blocks, changedKeys);
  console.log(`decofile: ${snap.count} blocks, revision ${snap.revision}`);

  if (!opts.write) {
    console.log(`\nDry-run only. Would write snapshot + revision and purge: ${purgePaths.join(", ")}`);
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
  console.log(`synced decofile:current (rev ${snap.revision}) → KV.`);

  if (opts.purgeUrl && opts.purgeToken) {
    await purgeCache(opts.purgeUrl, opts.purgeToken, purgePaths);
  } else if (opts.purgeUrl) {
    console.warn("warning: --purge-url given without a token (PURGE_TOKEN/--purge-token) — skipping purge.");
  }
}

main();
