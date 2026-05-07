#!/usr/bin/env node
// resolve-site.mjs
//
// Validates that the calling repository has a registered site manifest in
// deco-start, and emits the resolved fields to GITHUB_OUTPUT for downstream
// steps (wrangler tail, status comments, etc.).
//
// Required env:
//   DECO_START_PATH  - path to a checked-out deco-start (e.g. ".deco-start")
//   SITE_NAME        - typically `${GITHUB_REPOSITORY#*/}` set by the workflow
//
// Optional env:
//   GITHUB_OUTPUT    - if set, emit `key=value` lines here (CI mode).
//                      If unset, prints a human-readable summary to stdout.

import { appendFileSync } from "node:fs";
import { loadSiteManifest } from "./site-registry.mjs";

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const decoStartPath = process.env.DECO_START_PATH;
const siteName = process.env.SITE_NAME;
const ghOutput = process.env.GITHUB_OUTPUT;

if (!decoStartPath) fail("DECO_START_PATH env var is required");
if (!siteName) fail("SITE_NAME env var is required");

let manifest;
try {
  manifest = loadSiteManifest(decoStartPath, siteName);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const summary = {
  site_name: siteName,
  worker_name: manifest.worker_name,
  has_routes: String(Array.isArray(manifest.routes) && manifest.routes.length > 0),
  has_kv: String(Array.isArray(manifest.kv_namespaces) && manifest.kv_namespaces.length > 0),
  has_analytics: String(
    Array.isArray(manifest.analytics_engine_datasets) &&
      manifest.analytics_engine_datasets.length > 0,
  ),
  has_version_metadata: String(Boolean(manifest.version_metadata)),
};

if (ghOutput) {
  const lines = Object.entries(summary).map(([k, v]) => `${k}=${v}`);
  appendFileSync(ghOutput, `${lines.join("\n")}\n`);
}

console.log(`Resolved site "${siteName}" -> worker "${manifest.worker_name}"`);
for (const [k, v] of Object.entries(summary)) {
  console.log(`  ${k}: ${v}`);
}
