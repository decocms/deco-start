/**
 * One-shot smoke: serialize a real OTLP/HTTP metrics payload through the
 * `createOtlpHttpMeterAdapter` exporter and POST it to the deployed
 * `deco-otel-ingest` `/v1/metrics`. Verifies the wire format end-to-end
 * (exporter → ingestor → ClickHouse) without standing up a Worker.
 *
 * Not part of the standard test suite — committed for repeatability.
 * Run with:
 *
 *   npx tsx scripts/smoke-otlp-meter.ts
 *
 * Expected output: `{"inserted":{"sum":1,"gauge":1,"histogram":1}}`.
 */

import { createOtlpHttpMeterAdapter } from "../src/core/sdk/otelHttpMeter";

async function main() {
  const meter = createOtlpHttpMeterAdapter({
    endpoint: "https://deco-otel-ingest.deco-cx.workers.dev/v1/metrics",
    resourceAttributes: {
      "service.name": "smoke-otlp-meter",
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

  meter.counterInc("deco.http.requests", 1, { method: "GET", status_class: "2xx" });
  meter.gaugeSet("deco.metrics.flush.buffer_size", 1, { kind: "smoke" });
  meter.histogramRecord("outbound_request_duration_ms", 27, { provider: "smoke", status_class: "2xx" });

  console.log("pending datapoints:", meter.pendingDatapointCount());

  await meter.flush();
  console.log("flush complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
