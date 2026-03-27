import type { MigrationContext } from "../types.ts";

export function generateWrangler(ctx: MigrationContext): string {
  // Sanitize site name for worker name (lowercase, hyphens only)
  const workerName = ctx.siteName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");

  return `{
  "name": "${workerName}-tanstack",
  "compatibility_date": "2026-02-14",
  "compatibility_flags": ["nodejs_compat", "no_handle_cross_request_promise_resolution"],
  "main": "./src/worker-entry.ts",
  "workers_dev": true,
  "preview_urls": true,
  "observability": {
    "logs": {
      "enabled": true,
      "invocation_logs": true
    }
  }
}
`;
}
