// Minimal JSONC -> JSON parser used by the deploy scripts.
//
// Strips // line comments and /* block comments */ outside of string literals
// and tolerates trailing commas in objects/arrays. Dependency-free so the
// deploy scripts can run with vanilla `node` in CI.

import { readFileSync } from "node:fs";

/**
 * @param {string} input
 * @returns {string}
 */
function stripComments(input) {
  let out = "";
  let i = 0;
  let inStr = false;
  let strChar = "";
  while (i < input.length) {
    const c = input[i];
    const n = input[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\" && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (c === strChar) inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      strChar = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonc(text) {
  const stripped = stripComments(text).replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(stripped);
}

/**
 * @param {string} path
 * @returns {unknown}
 */
export function readJsoncFile(path) {
  const raw = readFileSync(path, "utf8");
  try {
    return parseJsonc(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse JSONC at ${path}: ${message}`);
  }
}
