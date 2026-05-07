// Shared registry helpers for the deploy scripts.
//
// `loadSiteManifest(decoStartPath, siteName)` returns the validated
// per-site manifest object. `mergeWithTemplate(template, site)` deep-merges a
// site manifest on top of the canonical template and returns the wrangler
// config object ready for serialization.
//
// Trust model: `siteName` is always derived from `${{ github.repository }}` in
// CI (or from the local git remote in the wrapper CLI), never from a
// user-supplied input. A site that is not registered in `deploy/sites/` cannot
// be deployed -- this is enforced here.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJsoncFile } from "./jsonc.mjs";

/** @typedef {{
 *   worker_name: string;
 *   routes?: Array<{ pattern: string; zone_name?: string; custom_domain?: boolean }>;
 *   kv_namespaces?: Array<{ binding: string; id: string; preview_id?: string }>;
 *   analytics_engine_datasets?: Array<{ binding: string; dataset: string }>;
 *   version_metadata?: { binding: string };
 * }} SiteManifest
 */

const ALLOWED_SITE_KEYS = new Set([
  "worker_name",
  "routes",
  "kv_namespaces",
  "analytics_engine_datasets",
  "version_metadata",
]);

/**
 * @param {string} decoStartPath
 * @returns {string}
 */
export function templatePath(decoStartPath) {
  return join(decoStartPath, "deploy", "wrangler-template.jsonc");
}

/**
 * @param {string} decoStartPath
 * @param {string} siteName
 * @returns {string}
 */
export function siteManifestPath(decoStartPath, siteName) {
  return join(decoStartPath, "deploy", "sites", `${siteName}.jsonc`);
}

/**
 * @param {string} decoStartPath
 * @param {string} siteName
 * @returns {SiteManifest}
 */
export function loadSiteManifest(decoStartPath, siteName) {
  if (!siteName || !/^[a-z0-9][a-z0-9-]*$/.test(siteName)) {
    throw new Error(
      `Refusing to load manifest for invalid site name: ${JSON.stringify(siteName)}. Site names must be lowercase, hyphen-separated.`,
    );
  }
  const path = siteManifestPath(decoStartPath, siteName);
  if (!existsSync(path)) {
    throw new Error(
      `No registry entry for site "${siteName}" at ${path}.\n` +
        `Add deploy/sites/${siteName}.jsonc to decocms/deco-start before deploying.`,
    );
  }
  const raw = readJsoncFile(path);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Site manifest at ${path} must be a JSON object.`);
  }
  const manifest = /** @type {Record<string, unknown>} */ (raw);
  if (typeof manifest.worker_name !== "string" || manifest.worker_name.length === 0) {
    throw new Error(`Site manifest at ${path} is missing the required "worker_name" string.`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(/** @type {string} */ (manifest.worker_name))) {
    throw new Error(
      `Site manifest at ${path} has an invalid "worker_name": ${JSON.stringify(manifest.worker_name)}. Use lowercase, hyphen-separated.`,
    );
  }
  for (const key of Object.keys(manifest)) {
    if (!ALLOWED_SITE_KEYS.has(key)) {
      throw new Error(
        `Site manifest at ${path} contains unsupported key "${key}". Allowed: ${[...ALLOWED_SITE_KEYS].join(", ")}.`,
      );
    }
  }
  return /** @type {SiteManifest} */ (manifest);
}

/**
 * @param {string} decoStartPath
 * @returns {Record<string, unknown>}
 */
export function loadTemplate(decoStartPath) {
  const path = templatePath(decoStartPath);
  if (!existsSync(path)) {
    throw new Error(`wrangler-template.jsonc not found at ${path}.`);
  }
  const raw = readJsoncFile(path);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Template at ${path} must be a JSON object.`);
  }
  return /** @type {Record<string, unknown>} */ (raw);
}

/**
 * Deep-merge `source` on top of `target`. Arrays in `source` REPLACE arrays in
 * `target` (they are not concatenated) -- this matches the semantics wrangler
 * itself expects for `routes`, `kv_namespaces`, etc.
 *
 * @template T
 * @param {T} target
 * @param {unknown} source
 * @returns {T}
 */
function deepMerge(target, source) {
  if (source === null || source === undefined) return target;
  if (Array.isArray(source)) return /** @type {T} */ (source);
  if (typeof source !== "object") return /** @type {T} */ (source);
  const base = target && typeof target === "object" && !Array.isArray(target) ? target : {};
  const out = /** @type {Record<string, unknown>} */ ({ ...base });
  for (const [k, v] of Object.entries(source)) {
    out[k] = deepMerge(out[k], v);
  }
  return /** @type {T} */ (out);
}

/**
 * Produce the wrangler config object by deep-merging a site manifest on top of
 * the canonical template. The site's `worker_name` becomes wrangler's `name`.
 *
 * @param {Record<string, unknown>} template
 * @param {SiteManifest} site
 * @returns {Record<string, unknown>}
 */
export function mergeWithTemplate(template, site) {
  const { worker_name, ...rest } = site;
  const merged = deepMerge(template, rest);
  return { name: worker_name, ...merged };
}
