import type { MigrationContext } from "../types.ts";

export function generateWrangler(ctx: MigrationContext): string {
  const workerName = ctx.siteName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");

  return `{
  "name": "${workerName}-tanstack",
  // TODO: Set your Cloudflare account_id for deployment
  // "account_id": "YOUR_ACCOUNT_ID",
  "compatibility_date": "2026-02-14",
  "compatibility_flags": ["nodejs_compat", "no_handle_cross_request_promise_resolution"],
  "main": "./src/worker-entry.ts",
  "workers_dev": true,
  "preview_urls": true,
  // Uncomment and set KV namespace ID for redirect/AB testing:
  // "kv_namespaces": [
  //   { "binding": "SITES_KV", "id": "YOUR_KV_NAMESPACE_ID" }
  // ],
  "observability": {
    "logs": {
      "enabled": true,
      "invocation_logs": true
    }
  }
}
`;
}
