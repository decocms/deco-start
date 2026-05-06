/**
 * URL-based head sampler — port of `deco-cx/deco/observability/otel/samplers/urlBased.ts`.
 *
 * Lets ops dial sampling rates per URL pattern without redeploying. Reads
 * `OTEL_SAMPLING_CONFIG` (base64-encoded JSON) at boot and decides each
 * trace's sample rate based on the matching pattern.
 *
 * Wrapped in `ParentBasedSampler` so a span inherits its parent's sampling
 * decision when one exists (i.e. distributed traces are kept consistent end
 * to end).
 *
 * @example
 * ```jsonc
 * // base64-encode this and set as OTEL_SAMPLING_CONFIG:
 * {
 *   "default": 0.05,
 *   "rules": [
 *     { "pattern": "^/checkout",   "ratio": 1.0 },
 *     { "pattern": "^/api/health", "ratio": 0.0 },
 *     { "pattern": "/p$",          "ratio": 0.1 }
 *   ]
 * }
 * ```
 */

import { type Attributes, type Context, type Link, type SpanKind, trace } from "@opentelemetry/api";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  type Sampler,
  type SamplingResult,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";

export interface SamplingRule {
  /** ECMA RegExp pattern matched against the URL path. */
  pattern: string;
  /** Ratio in [0, 1]. */
  ratio: number;
}

export interface SamplingConfig {
  /** Default sample ratio applied when no rule matches. Defaults to 1.0 (always sample). */
  default?: number;
  /** Ordered list of rules. First match wins. */
  rules?: SamplingRule[];
}

interface CompiledRule {
  re: RegExp;
  sampler: Sampler;
}

/**
 * URL-pattern-driven head sampler. Implements the OTel `Sampler` interface
 * directly so it can be plugged into `ParentBasedSampler`'s `root` slot.
 */
export class URLBasedSampler implements Sampler {
  private readonly defaultSampler: Sampler;
  private readonly rules: CompiledRule[];

  constructor(config: SamplingConfig = {}) {
    this.defaultSampler = ratioToSampler(config.default ?? 1.0);
    this.rules = (config.rules ?? []).map((rule) => ({
      re: new RegExp(rule.pattern),
      sampler: ratioToSampler(rule.ratio),
    }));
  }

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    const path = extractPath(attributes);
    if (path) {
      for (const rule of this.rules) {
        if (rule.re.test(path)) {
          return rule.sampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
        }
      }
    }
    return this.defaultSampler.shouldSample(
      context,
      traceId,
      spanName,
      spanKind,
      attributes,
      links,
    );
  }

  toString(): string {
    return `URLBasedSampler(${this.rules.length} rules)`;
  }
}

function ratioToSampler(ratio: number): Sampler {
  if (ratio >= 1) return new AlwaysOnSampler();
  if (ratio <= 0) return new AlwaysOffSampler();
  return new TraceIdRatioBasedSampler(ratio);
}

function extractPath(attrs: Attributes): string | null {
  // Prefer the OTel-standard `url.path` (semconv >= 1.21), fall back to
  // legacy `http.target` and `http.url`.
  const direct = attrs["url.path"] ?? attrs["http.target"];
  if (typeof direct === "string") return direct;

  const httpUrl = attrs["http.url"];
  if (typeof httpUrl === "string") {
    try {
      return new URL(httpUrl).pathname;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------

/**
 * Decode a base64-encoded `OTEL_SAMPLING_CONFIG` value into a `SamplingConfig`.
 * Returns `null` (caller falls back to default ratio 1.0) on:
 *  - missing / empty input
 *  - invalid base64
 *  - JSON parse failure
 *  - schema-mismatched payload
 *
 * Logs a warning to console when the env var is set but unparseable so the
 * mistake is visible in CF Logs without crashing the worker boot.
 */
export function decodeSamplingConfig(raw: string | undefined): SamplingConfig | null {
  if (!raw) return null;
  try {
    const json = atob(raw);
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as { default?: unknown; rules?: unknown };

    const defaultRatio = typeof obj.default === "number" ? obj.default : undefined;
    const rawRules = Array.isArray(obj.rules) ? obj.rules : [];
    const rules: SamplingRule[] = [];
    for (const r of rawRules) {
      if (!r || typeof r !== "object") continue;
      const rec = r as { pattern?: unknown; ratio?: unknown };
      if (typeof rec.pattern !== "string" || typeof rec.ratio !== "number") continue;
      try {
        // Eagerly validate the regex so a bad pattern fails at boot, not
        // on the first matching request.
        new RegExp(rec.pattern);
        rules.push({ pattern: rec.pattern, ratio: rec.ratio });
      } catch {
        console.warn(`[sampler] dropping invalid pattern: ${rec.pattern}`);
      }
    }

    return { default: defaultRatio, rules };
  } catch (err) {
    console.warn(`[sampler] failed to decode OTEL_SAMPLING_CONFIG`, String(err));
    return null;
  }
}

/**
 * Build a `ParentBasedSampler` rooted at our URL-based sampler.
 * Use as the `headSampler` for `@microlabs/otel-cf-workers`.
 */
export function createUrlBasedHeadSampler(config: SamplingConfig | null): Sampler {
  const root = new URLBasedSampler(config ?? {});
  return new ParentBasedSampler({ root });
}

// Re-export OTel API helper so callers can read `traceId` / build tags off
// the active span without importing @opentelemetry/api directly.
export { trace as _otelTrace };
