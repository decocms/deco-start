// Template loader + token substitution for the canonical wrangler config.
//
// There is no per-site "registry" anymore: every site's wrangler config is
// produced from `deploy/wrangler-template.jsonc` plus the worker name (which
// equals the storefront repo basename by convention). To accommodate fields
// that must vary deterministically per worker, the template can use these
// substitution tokens, which are replaced at config-build time:
//
//   $WORKER_NAME        -> worker name verbatim     (e.g. "als-tanstack")
//   $WORKER_UNDERSCORE  -> worker name, `-` -> `_`  (e.g. "als_tanstack")
//
// Trust model: callers cannot pass a fabricated worker name to the central
// CI workflows -- the deploy is gated by the `decocms-deployer` GitHub App
// being installed on the target storefront repo. If the App isn't installed
// there, the App-token mint fails and the deploy never starts.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJsoncFile } from "./jsonc.mjs";

/**
 * @param {string} decoStartPath
 * @returns {string}
 */
export function templatePath(decoStartPath) {
  return join(decoStartPath, "deploy", "wrangler-template.jsonc");
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
 * Recursively replace `$WORKER_*` tokens in any string value of an
 * object/array tree. Returns a new tree.
 *
 * @param {unknown} value
 * @param {Record<string, string>} replacements
 * @returns {unknown}
 */
function substituteTokens(value, replacements) {
  if (typeof value === "string") {
    let out = value;
    for (const [token, repl] of Object.entries(replacements)) {
      out = out.split(token).join(repl);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteTokens(v, replacements));
  }
  if (value && typeof value === "object") {
    const out = /** @type {Record<string, unknown>} */ ({});
    for (const [k, v] of Object.entries(value)) {
      out[k] = substituteTokens(v, replacements);
    }
    return out;
  }
  return value;
}

/**
 * Produce the wrangler config object by substituting `$WORKER_*` tokens in
 * the template and prepending `name`.
 *
 * @param {Record<string, unknown>} template
 * @param {string} workerName
 * @returns {Record<string, unknown>}
 */
export function applyWorkerName(template, workerName) {
  if (typeof workerName !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(workerName)) {
    throw new Error(
      `Invalid worker name: ${JSON.stringify(workerName)}. Use lowercase, hyphen-separated.`,
    );
  }
  const substituted = /** @type {Record<string, unknown>} */ (
    substituteTokens(template, {
      $WORKER_UNDERSCORE: workerName.replace(/-/g, "_"),
      $WORKER_NAME: workerName,
    })
  );
  return { name: workerName, ...substituted };
}
