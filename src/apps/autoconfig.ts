/**
 * Registry-driven auto-configuration of known apps from CMS blocks.
 *
 * A site passes an `AppRegistry` (declarative list of known app blockKeys +
 * lazy module imports). For every registry entry whose `blockKey` exists in
 * the decofile, this calls `mod.configure(block, resolveSecret)` and then
 * hands the resulting AppDefinitions off to `setupApps()`.
 *
 * The canonical registry lives in `@decocms/apps/registry` so the framework
 * itself has zero knowledge of which apps exist.
 *
 * Usage in setup.ts:
 *   import { autoconfigApps } from "@decocms/start/apps/autoconfig";
 *   import { APP_REGISTRY } from "@decocms/apps/registry";
 *   await autoconfigApps(generatedBlocks, APP_REGISTRY);
 */

import { onChange } from "../core/cms/loader";
import { resolveSecret } from "../core/sdk/crypto";
import {
  setupApps,
  type AppDefinition,
  type AppDefinitionWithHandlers,
} from "../tanstack/sdk/setupApps";

/**
 * Shape of the secret resolver passed to each app's `configure()`. Matches
 * `resolveSecret` in `src/sdk/crypto.ts`. Apps typically narrow the return
 * type inside their own `configure()` by throwing on null.
 */
export type ResolveSecret = (
  value: unknown,
  envVarName?: string,
) => Promise<string | null>;

/**
 * One entry in the app registry — describes a single installable app.
 * Sites pass an array of these to `autoconfigApps()` (typically imported
 * from `@decocms/apps/registry`).
 */
export interface AppRegistryEntry {
  /** Block key in the decofile, e.g. "deco-shopify". */
  blockKey: string;

  /**
   * Lazy import of the app's mod module. Must return an object exposing
   * `configure(block, resolveSecret)` and optionally `handlers`.
   *
   * Use a string-literal dynamic import so bundlers (Vite/Rollup) can
   * statically trace the chunk. E.g.
   *   () => import("@decocms/apps/shopify/mod")
   */
  module: () => Promise<{
    configure: (
      block: unknown,
      resolveSecret: ResolveSecret,
    ) => Promise<AppDefinition | null>;
    handlers?: Record<string, (props: any, req: Request) => Promise<any>>;
  }>;

  /** Human-readable name shown in admin install UI. */
  displayName?: string;
  /** Icon URL (absolute or site-relative) shown in admin install UI. */
  icon?: string;
  /** Grouping label, e.g. "commerce", "email", "analytics". */
  category?: string;
  /** Short summary (one sentence) shown in admin install UI. */
  description?: string;
}

export type AppRegistry = readonly AppRegistryEntry[];

async function configureAllApps(
  blocks: Record<string, unknown>,
  registry: AppRegistry,
): Promise<AppDefinitionWithHandlers[]> {
  const apps: AppDefinitionWithHandlers[] = [];

  for (const entry of registry) {
    const block = blocks[entry.blockKey];
    if (!block) continue;

    try {
      const mod = await entry.module();
      if (typeof mod?.configure !== "function") continue;

      const appDef: AppDefinition | null = await mod.configure(
        block,
        resolveSecret,
      );
      if (!appDef) continue;

      const withHandlers: AppDefinitionWithHandlers = {
        ...appDef,
        handlers: mod.handlers,
      };
      apps.push(withHandlers);
    } catch {
      // App module missing, configure threw, or block was malformed — skip.
    }
  }

  return apps;
}

/**
 * Auto-configure apps from CMS blocks against a declarative registry.
 *
 * Call once in setup.ts after setBlocks(). Re-runs on admin hot-reload.
 *
 * @param blocks   Decofile blocks (from blocks.gen or loadBlocks()).
 * @param registry List of installable apps — typically
 *                 `import { APP_REGISTRY } from "@decocms/apps/registry"`.
 */
export async function autoconfigApps(
  blocks: Record<string, unknown>,
  registry: AppRegistry,
): Promise<void> {
  if (typeof document !== "undefined") return; // server-only
  if (!registry || registry.length === 0) return;

  const apps = await configureAllApps(blocks, registry);
  if (apps.length > 0) {
    await setupApps(apps);
  }

  // Re-configure on admin hot-reload
  onChange(async (newBlocks) => {
    if (typeof document !== "undefined") return;
    const updatedApps = await configureAllApps(newBlocks, registry);
    if (updatedApps.length > 0) {
      await setupApps(updatedApps);
    }
  });
}
