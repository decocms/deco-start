/**
 * Placeholder for a future OTel-collector based exporter that ships
 * logs / metrics / traces from this Worker to a co-deployed OTel Collector
 * gateway, which in turn batches into ClickHouse.
 *
 * **NOT IMPLEMENTED in 5.0.0.** The framework today defaults to CF-native
 * observability: logs and traces appear in the Cloudflare dashboard
 * (`observability.{logs,traces}` in `wrangler.jsonc`), and metrics go to
 * Workers Analytics Engine. When the platform-side ClickHouse + collector
 * deployment lands, this file gets the real OTLP/HTTP exporter wiring back
 * — mirror the implementation that lived in `src/sdk/otelAdapters.ts` and
 * `src/sdk/sampler.ts` at the pre-5.0.0 git tag.
 *
 * The expected shape (`endpoint`, optional `headers`, optional `resource`,
 * `exportIntervalMillis`) is recorded here so site-side bootstrapping code
 * can compile against the future surface today and we don't churn the
 * `OtelOptions` type when the implementation lands.
 *
 * Reference: https://clickhouse.com/docs/observability/integrating-opentelemetry
 *
 * Expected wiring once implemented:
 *  - Worker → OTLP/HTTP → OTel Collector (gateway, per region)
 *  - Collector pipelines:
 *      receivers[otlp] → processors[batch, memory_limiter] → exporters[clickhouse]
 *  - The Worker uses the collector URL as `endpoint`, NOT a direct
 *    ClickHouse URL. The collector owns the credentials, retry policy,
 *    and schema mapping.
 */

export interface ClickhouseCollectorOptions {
  /**
   * OTel Collector OTLP/HTTP endpoint, e.g. `https://otel-collector.internal`.
   * The Worker never talks to ClickHouse directly — it talks to the collector.
   */
  endpoint: string;
  /** Optional bearer token / mTLS identity headers — collector-defined. */
  headers?: Record<string, string>;
  /**
   * Resource attributes to stamp on every emitted record. Keep narrow
   * (`service.name`, `deco.runtime.version`, `deployment.environment`) —
   * higher-cardinality attributes belong on individual spans / log records.
   */
  resource?: Record<string, string>;
  /** Periodic metric reader push interval in ms. Defaults to 60_000 once wired. */
  exportIntervalMillis?: number;
}

/**
 * Returns nothing today — throws to make accidental usage loud and obvious.
 *
 * The intended return shape is `{ logger: LoggerAdapter, meter: MeterAdapter,
 * tracer: TracerAdapter, flush: () => Promise<void> }` so the wiring inside
 * `instrumentWorker` can compose this with the AE meter (dual-emit) and the
 * default console logger. None of that ships in 5.0.0.
 */
export function createClickhouseCollectorAdapter(_options: ClickhouseCollectorOptions): never {
  throw new Error(
    "createClickhouseCollectorAdapter is not implemented in @decocms/start@5.x. " +
      "ClickHouse + OTel-collector integration is on the roadmap. " +
      "Until then, use Cloudflare-native observability " +
      "(observability.{logs,traces} in wrangler.jsonc) plus the Workers " +
      "Analytics Engine meter wired by instrumentWorker(). Track progress " +
      "at https://github.com/decocms/deco-start/issues.",
  );
}
