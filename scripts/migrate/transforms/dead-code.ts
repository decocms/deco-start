import type { TransformResult } from "../types.ts";

/**
 * Removes dead code patterns from the old Deco stack that don't work
 * in TanStack Start:
 *
 * - `export const cache = "stale-while-revalidate"` (old cache system)
 * - `export const cacheKey = ...` (old cache key generation)
 * - `export const loader = (props, req, ctx) => ...` (old section loader pattern)
 * - `crypto.subtle.digestSync(...)` (Deno-only sync API)
 * - `invoke.resend.actions.emails.send(...)` → `sendEmail(...)` from @decocms/apps
 */
export function transformDeadCode(content: string): TransformResult {
  const notes: string[] = [];
  let changed = false;
  let result = content;

  // Remove old cache export: export const cache = "stale-while-revalidate";
  if (/^export\s+const\s+cache\s*=\s*["'][^"']*["']/m.test(result)) {
    result = result.replace(
      /^export\s+const\s+cache\s*=\s*["'][^"']*["'];?\s*\n?/gm,
      "",
    );
    changed = true;
    notes.push("Removed dead `export const cache` (old caching system)");
  }

  // Remove old cacheKey export (can be multiline)
  if (/^export\s+const\s+cacheKey\s*=/m.test(result)) {
    // Try to remove the entire cacheKey function — find matching closing brace/semicolon
    result = result.replace(
      /^export\s+const\s+cacheKey\s*=\s*\([^)]*\)\s*(?::\s*\w+\s*)?=>\s*\{[\s\S]*?\n\};\s*\n?/gm,
      "",
    );
    // Also handle simpler inline forms
    result = result.replace(
      /^export\s+const\s+cacheKey\s*=[^;]*;\s*\n?/gm,
      "",
    );
    changed = true;
    notes.push("Removed dead `export const cacheKey` (old caching system)");
  }

  // Remove old section loader export: export const loader = (props, req, ctx) => { ... };
  // This is the old pattern where sections had co-located loaders.
  // In TanStack Start, section loaders are handled differently.
  if (/^export\s+const\s+loader\s*=\s*\(/m.test(result)) {
    result = result.replace(
      /^export\s+const\s+loader\s*=\s*\([^)]*\)\s*(?::\s*[\w<>[\]|&\s]+)?\s*=>\s*\{[\s\S]*?\n\};\s*\n?/gm,
      "",
    );
    // Also handle simpler inline forms
    result = result.replace(
      /^export\s+const\s+loader\s*=\s*\([^)]*\)\s*=>[^;]*;\s*\n?/gm,
      "",
    );
    changed = true;
    notes.push("Removed dead `export const loader` (old section loader — use section loaders in @decocms/start)");
  }

  // Replace crypto.subtle.digestSync (Deno-only) with a note
  if (result.includes("digestSync")) {
    result = result.replace(
      /crypto\.subtle\.digestSync\(/g,
      "/* MIGRATION: digestSync is Deno-only, use await crypto.subtle.digest( */ crypto.subtle.digest(",
    );
    changed = true;
    notes.push("MANUAL: crypto.subtle.digestSync is Deno-only — replaced with crypto.subtle.digest (needs await)");
  }

  // Migrate invoke.resend.actions.emails.send → sendEmail from @decocms/apps
  if (result.includes("invoke.resend.actions.emails.send")) {
    // Replace the invoke call with sendEmail
    result = result.replace(
      /(?:await\s+)?invoke\.resend\.actions\.emails\.send\(/g,
      "await sendEmail(",
    );

    // Remove the old runtime import if only used for resend
    result = result.replace(
      /^import\s+\{\s*invoke\s*\}\s+from\s+["'][^"']*runtime["'];?\s*\n?/gm,
      "",
    );

    // Add the sendEmail import if not present
    if (!result.includes('"@decocms/apps/resend/actions/send"')) {
      result = `import { sendEmail } from "@decocms/apps/resend/actions/send";\n${result}`;
    }

    changed = true;
    notes.push("Migrated invoke.resend.actions.emails.send → sendEmail from @decocms/apps/resend");
  }

  // Generic invoke.X pattern — flag for manual review
  if (/\binvoke\.\w+\.\w+/.test(result) && !result.includes("sendEmail")) {
    notes.push("MANUAL: invoke.* calls found — need manual migration to server functions or @decocms/apps actions");
  }

  // Clean up blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return { content: result, changed, notes };
}
