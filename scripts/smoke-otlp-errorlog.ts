/**
 * One-shot smoke: emit an error log record through
 * `createOtlpHttpLogAdapter` and POST it to the deployed
 * `deco-otel-ingest` `/v1/logs`. Verifies the wire format end-to-end.
 *
 * Run with: `npx tsx scripts/smoke-otlp-errorlog.ts`
 * Expected output: `{"inserted":1}` echoed by the ingestor.
 */

import { createOtlpHttpLogAdapter } from "../src/sdk/otelHttpLog";

async function main() {
  const sink = createOtlpHttpLogAdapter({
    endpoint: "https://deco-otel-ingest.deco-cx.workers.dev/v1/logs",
    resourceAttributes: {
      "service.name": "smoke-otlp-errorlog",
      "service.version": "5.1.1-dev",
      "deco.runtime.version": "5.1.1-dev",
      "deployment.environment": "smoke",
    },
    scopeName: "@decocms/start",
    scopeVersion: "5.1.1-dev",
    minFlushIntervalMs: 0,
    onError: (kind, err) => {
      console.error(`[smoke] onError(${kind}):`, err);
      process.exitCode = 1;
    },
  });

  sink.adapter.log("error", "smoke error from otelHttpLog exporter", {
    stage: "smoke",
    reason: "wire-format-validation",
    durationMs: 27,
    ok: false,
  });

  console.log("pending records:", sink.pendingRecordCount());

  await sink.flush();
  console.log("flush complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
