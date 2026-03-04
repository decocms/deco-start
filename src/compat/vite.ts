/**
 * Vite resolve alias helper for Deco + TanStack Start projects.
 *
 * Generates the alias map that redirects Preact/Fresh/Deco imports
 * to the compat shims provided by @decocms/start and @decocms/apps.
 *
 * Usage in vite.config.ts:
 *
 *   import { getDecoAliases } from "@decocms/start/compat/vite";
 *
 *   export default defineConfig({
 *     resolve: {
 *       alias: {
 *         ...getDecoAliases({ srcDir: path.resolve(__dirname, "src") }),
 *       },
 *     },
 *   });
 */

import { createRequire } from "module";
import path from "path";

export interface DecoAliasOptions {
  /** Absolute path to the consumer's src/ directory */
  srcDir: string;
  /**
   * Absolute path to @decocms/start package root.
   * If not provided, resolved automatically via require.resolve.
   */
  startPkgDir?: string;
  /**
   * Absolute path to @decocms/apps package root.
   * If not provided, resolved automatically via require.resolve.
   */
  appsPkgDir?: string;
}

function resolvePackageDir(packageName: string): string {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve(`${packageName}/package.json`);
  return path.dirname(pkgJsonPath);
}

export function getDecoAliases(options: DecoAliasOptions): Record<string, string> {
  const { srcDir } = options;
  const startDir = options.startPkgDir ?? resolvePackageDir("@decocms/start");
  const appsDir = options.appsPkgDir ?? resolvePackageDir("@decocms/apps");
  const compatDir = path.join(startDir, "src", "compat");
  const appsCompatDir = path.join(appsDir, "compat");

  return {
    // Site root aliases
    "$store": srcDir,
    "site": srcDir,

    // Fresh runtime
    "$fresh/runtime.ts": path.join(compatDir, "fresh-runtime.ts"),

    // Preact → React (order matters: more specific first)
    "preact/compat": path.join(compatDir, "preact-compat.ts"),
    "preact/hooks": path.join(compatDir, "preact-hooks.ts"),
    "preact": path.join(compatDir, "preact.ts"),

    // Preact signals
    "@preact/signals": path.join(compatDir, "signals.ts"),

    // Deco framework (order matters: sub-paths before bare import)
    "@deco/deco/blocks": path.join(compatDir, "deco-blocks.ts"),
    "@deco/deco/hooks": path.join(compatDir, "deco-hooks.ts"),
    "@deco/deco/o11y": path.join(compatDir, "deco-o11y.ts"),
    "@deco/deco": path.join(compatDir, "deco.ts"),

    // Apps compat (website components, commerce hooks, widgets)
    "apps": appsCompatDir,

    // deco-sites/std
    "deco-sites/std/components/Video.tsx": path.join(appsCompatDir, "website", "components", "Video.tsx"),

    // Path alias
    "~": srcDir,
  };
}
