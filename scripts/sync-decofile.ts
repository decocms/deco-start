#!/usr/bin/env tsx
/**
 * Pull the live decofile from a Deco production site into `.deco/blocks/`.
 *
 * Closes the snapshot drift problem: without this, each site keeps a manually
 * checked-in copy of the CMS state in `.deco/blocks/*.json`. Anything edited
 * in the CMS UI after the last manual sync is invisible to the worker until
 * someone re-snapshots it.
 *
 * Endpoint: every Deco site exposes `GET /.decofile` which returns the full
 * blocks map as JSON. We fetch that, split it back into one-file-per-block,
 * URL-encode the filename so it round-trips through `generate-blocks.ts`'s
 * `decodeBlockName`, and atomically replace `.deco/blocks/` so a half-finished
 * sync can never leave the site in a broken state.
 *
 * Usage (from a site root):
 *   tsx node_modules/@decocms/start/scripts/sync-decofile.ts \
 *     --site lojabagaggio
 *
 * Flags:
 *   --site         Production site name (used to build https://www.<site>.com.br when --url is omitted)
 *   --url          Full base URL to fetch from. Overrides --site.
 *   --out          Output directory (default: .deco/blocks)
 *   --dry-run      Compute and print the diff vs the on-disk snapshot, do not write
 *   --no-clean     Do not wipe the output directory first (additive merge)
 */
import fs from "node:fs";
import path from "node:path";

interface ParsedArgs {
  site?: string;
  url?: string;
  out: string;
  dryRun: boolean;
  clean: boolean;
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1 || !argv[i + 1] || argv[i + 1].startsWith("--")) return undefined;
    return argv[i + 1];
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  return {
    site: get("site"),
    url: get("url"),
    out: get("out") ?? ".deco/blocks",
    dryRun: has("dry-run"),
    clean: !has("no-clean"),
  };
}

/**
 * The CMS may emit keys that already contain URL-encoded sequences (eg.
 * `pages-%C3%9Altimas...`). To keep filenames and on-disk diffs stable, we
 * peel any encoding off the key first and then apply a single canonical
 * encoding pass when writing to disk.
 */
function normalizeKey(rawKey: string): string {
  let k = rawKey;
  while (k.includes("%")) {
    try {
      const next = decodeURIComponent(k);
      if (next === k) break;
      k = next;
    } catch {
      break;
    }
  }
  return k;
}

/**
 * Encode a block key into a filename that survives `decodeBlockName` in
 * `generate-blocks.ts`. Keys must already be normalized via `normalizeKey`.
 */
function encodeBlockKeyToFilename(key: string): string {
  return encodeURIComponent(key) + ".json";
}

function normalizeBlocks(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[normalizeKey(k)] = v;
  }
  return out;
}

async function fetchDecofile(baseUrl: string): Promise<Record<string, unknown>> {
  const url = baseUrl.replace(/\/$/, "") + "/.decofile";
  console.log(`Fetching ${url} ...`);
  const res = await fetch(url, {
    headers: { "user-agent": "decocms-sync-decofile/1.0" },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} returned ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  if (!json || typeof json !== "object") {
    throw new Error(`Unexpected response shape from ${url}`);
  }
  return json;
}

function readExistingSnapshot(dir: string): Record<string, unknown> {
  if (!fs.existsSync(dir)) return {};
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const out: Record<string, unknown> = {};
  for (const f of files) {
    const key = normalizeKey(f.replace(/\.json$/, ""));
    try {
      out[key] = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
    } catch {
      // ignore unparseable
    }
  }
  return out;
}

interface DiffResult {
  added: string[];
  removed: string[];
  changed: string[];
}

function diffSnapshots(next: Record<string, unknown>, prev: Record<string, unknown>): DiffResult {
  const nextKeys = new Set(Object.keys(next));
  const prevKeys = new Set(Object.keys(prev));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const k of nextKeys) {
    if (!prevKeys.has(k)) added.push(k);
    else if (JSON.stringify(next[k]) !== JSON.stringify(prev[k])) changed.push(k);
  }
  for (const k of prevKeys) {
    if (!nextKeys.has(k)) removed.push(k);
  }
  return { added, removed, changed };
}

function writeAtomically(dir: string, blocks: Record<string, unknown>, clean: boolean): void {
  const stagingDir = `${dir}.tmp-${process.pid}`;
  if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  for (const [key, value] of Object.entries(blocks)) {
    const filename = encodeBlockKeyToFilename(key);
    fs.writeFileSync(path.join(stagingDir, filename), JSON.stringify(value, null, 2));
  }

  if (clean) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(stagingDir, dir);
  } else {
    // additive: copy from staging into target
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(stagingDir)) {
      fs.copyFileSync(path.join(stagingDir, f), path.join(dir, f));
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.site && !args.url) {
    console.error("Usage: tsx sync-decofile.ts --site <name>  OR  --url <base-url>");
    process.exit(2);
  }

  const baseUrl = args.url ?? `https://www.${args.site}.com.br`;
  const outDir = path.resolve(process.cwd(), args.out);

  const next = normalizeBlocks(await fetchDecofile(baseUrl));
  const prev = readExistingSnapshot(outDir);
  const diff = diffSnapshots(next, prev);

  console.log("");
  console.log(`  fetched  ${Object.keys(next).length} blocks`);
  console.log(`  on disk  ${Object.keys(prev).length} blocks`);
  console.log(`  added    ${diff.added.length}`);
  console.log(`  removed  ${diff.removed.length}`);
  console.log(`  changed  ${diff.changed.length}`);
  console.log("");

  const sample = (xs: string[], n = 8) =>
    xs
      .slice(0, n)
      .map((x) => `    ${x}`)
      .join("\n");
  if (diff.added.length)
    console.log(`Added (showing ${Math.min(8, diff.added.length)}):\n${sample(diff.added)}\n`);
  if (diff.removed.length)
    console.log(
      `Removed (showing ${Math.min(8, diff.removed.length)}):\n${sample(diff.removed)}\n`,
    );
  if (diff.changed.length)
    console.log(
      `Changed (showing ${Math.min(8, diff.changed.length)}):\n${sample(diff.changed)}\n`,
    );

  if (args.dryRun) {
    console.log("--dry-run set, not writing.");
    return;
  }

  writeAtomically(outDir, next, args.clean);
  console.log(
    `Wrote ${Object.keys(next).length} blocks to ${path.relative(process.cwd(), outDir)}`,
  );
  console.log("Next: pnpm run generate:blocks  (or your build script)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
