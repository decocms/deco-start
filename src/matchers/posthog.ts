/**
 * PostHog feature flag matcher bridge.
 *
 * Bridges deco's CMS matcher interface (`evaluateMatcher`) to PostHog's
 * feature flag system for experiment-grade A/B testing with sticky sessions.
 *
 * This module is designed to be used with `registerMatcher()` from the CMS.
 * PostHog itself is NOT a dependency of `@decocms/start` — the storefront
 * provides the PostHog client via `configurePostHogMatcher()`.
 *
 * @example
 * ```ts
 * // In your storefront setup.ts
 * import { registerMatcher } from "@decocms/start/cms";
 * import { createPostHogMatcher, configurePostHogMatcher } from "@decocms/start/matchers/posthog";
 * import posthog from "posthog-js";
 *
 * configurePostHogMatcher({
 *   isFeatureEnabled: (key) => posthog.isFeatureEnabled(key) ?? false,
 *   getFeatureFlagVariant: (key) => posthog.getFeatureFlag(key),
 * });
 *
 * registerMatcher("posthog/matchers/featureFlag.ts", createPostHogMatcher());
 * ```
 */

import type { MatcherContext } from "../cms/resolve";

export interface PostHogAdapter {
  /**
   * Evaluate a boolean feature flag.
   * Should return `true` if the flag is enabled for the current user.
   */
  isFeatureEnabled: (flagKey: string) => boolean;
  /**
   * Get the variant key for a multivariate feature flag.
   * Returns the variant string or `undefined`/`false` if not matched.
   */
  getFeatureFlagVariant?: (flagKey: string) => string | boolean | undefined;
}

let adapter: PostHogAdapter | null = null;

/**
 * Provide the PostHog client adapter. Must be called before
 * any PostHog matchers are evaluated.
 */
export function configurePostHogMatcher(ph: PostHogAdapter) {
  adapter = ph;
}

/**
 * Creates a matcher function compatible with `registerMatcher()`.
 *
 * CMS rule shape (in the decofile JSON):
 * ```json
 * {
 *   "__resolveType": "posthog/matchers/featureFlag.ts",
 *   "flagKey": "my-experiment",
 *   "variant": "treatment"
 * }
 * ```
 *
 * - If only `flagKey` is provided, matches when the flag is enabled (boolean).
 * - If `variant` is also provided, matches when the flag's variant equals it.
 */
export function createPostHogMatcher() {
  return (rule: Record<string, unknown>, _ctx: MatcherContext): boolean => {
    if (!adapter) {
      console.warn("[PostHog Matcher] No adapter configured. Call configurePostHogMatcher() first.");
      return false;
    }

    const flagKey = rule.flagKey as string | undefined;
    if (!flagKey) {
      console.warn("[PostHog Matcher] Missing `flagKey` in matcher rule.");
      return false;
    }

    const expectedVariant = rule.variant as string | undefined;

    if (expectedVariant && adapter.getFeatureFlagVariant) {
      const actual = adapter.getFeatureFlagVariant(flagKey);
      return actual === expectedVariant;
    }

    return adapter.isFeatureEnabled(flagKey);
  };
}

/**
 * Server-side PostHog evaluation for SSR.
 *
 * Uses the PostHog Node SDK to evaluate flags server-side,
 * ensuring the first render has the correct variant without a flash.
 *
 * @example
 * ```ts
 * import { PostHog } from "posthog-node";
 * import { configurePostHogMatcher, createServerPostHogAdapter } from "@decocms/start/matchers/posthog";
 *
 * const phServer = new PostHog(process.env.POSTHOG_API_KEY);
 *
 * // In your middleware, per-request:
 * const adapter = createServerPostHogAdapter(phServer, distinctId);
 * configurePostHogMatcher(adapter);
 * ```
 */
export function createServerPostHogAdapter(
  client: {
    isFeatureEnabled: (key: string, distinctId: string) => Promise<boolean> | boolean;
    getFeatureFlag: (key: string, distinctId: string) => Promise<string | boolean | undefined> | string | boolean | undefined;
  },
  distinctId: string,
): PostHogAdapter {
  const flagCache = new Map<string, boolean>();
  const variantCache = new Map<string, string | boolean | undefined>();

  return {
    isFeatureEnabled(key: string): boolean {
      if (flagCache.has(key)) return flagCache.get(key)!;

      // Synchronous path — pre-warm the cache in middleware before resolution
      const result = client.isFeatureEnabled(key, distinctId);
      if (result instanceof Promise) {
        console.warn("[PostHog] Async flag evaluation used synchronously. Pre-warm flags in middleware.");
        return false;
      }
      flagCache.set(key, result);
      return result;
    },

    getFeatureFlagVariant(key: string): string | boolean | undefined {
      if (variantCache.has(key)) return variantCache.get(key);

      const result = client.getFeatureFlag(key, distinctId);
      if (result instanceof Promise) {
        console.warn("[PostHog] Async variant evaluation used synchronously. Pre-warm flags in middleware.");
        return undefined;
      }
      variantCache.set(key, result);
      return result;
    },
  };
}
