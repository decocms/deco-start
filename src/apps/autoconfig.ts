/**
 * Auto-configures known apps from CMS blocks using AppModContract.
 *
 * Scans the decofile for known app block keys (e.g. "deco-vtex", "deco-resend")
 * and calls each app's `configure()` function from its mod.ts.
 * Then delegates to `setupApps()` for invoke handler registration, middleware, etc.
 *
 * Usage in setup.ts:
 *   import { autoconfigApps } from "@decocms/start/apps/autoconfig";
 *   setBlocks(generatedBlocks);
 *   await autoconfigApps(generatedBlocks);
 */

import { onChange } from "../cms/loader";
import { resolveSecret } from "../sdk/crypto";
import {
	setupApps,
	type AppDefinition,
	type AppDefinitionWithHandlers,
} from "../sdk/setupApps";

// ---------------------------------------------------------------------------
// Known app block keys → dynamic import of their mod.ts
// ---------------------------------------------------------------------------

const APP_MODS: Record<string, () => Promise<any>> = {
	"deco-vtex": () => import("@decocms/apps/vtex/mod" as string),
	"deco-shopify": () => import("@decocms/apps/shopify/mod" as string),
	"deco-resend": () => import("@decocms/apps/resend/mod" as string),
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function configureAllApps(
	blocks: Record<string, unknown>,
): Promise<AppDefinitionWithHandlers[]> {
	const apps: AppDefinitionWithHandlers[] = [];

	for (const [blockKey, importMod] of Object.entries(APP_MODS)) {
		const block = blocks[blockKey];
		if (!block) continue;

		try {
			const mod = await importMod();
			if (typeof mod.configure !== "function") continue;

			const appDef: AppDefinition | null = await mod.configure(
				block,
				resolveSecret,
			);
			if (!appDef) continue;

			// Attach explicit handlers from mod.ts (e.g. resend's pre-wrapped handlers)
			const withHandlers: AppDefinitionWithHandlers = {
				...appDef,
				handlers: mod.handlers,
			};
			apps.push(withHandlers);
		} catch {
			// App not installed or configure failed — skip silently
		}
	}

	return apps;
}

/**
 * Auto-configure apps from CMS blocks.
 * Call in setup.ts after setBlocks(). Also re-runs on admin hot-reload.
 */
export async function autoconfigApps(blocks: Record<string, unknown>) {
	if (typeof document !== "undefined") return; // server-only

	const apps = await configureAllApps(blocks);
	if (apps.length > 0) {
		await setupApps(apps);
	}

	// Re-configure on admin hot-reload
	onChange(async (newBlocks) => {
		if (typeof document !== "undefined") return;
		const updatedApps = await configureAllApps(newBlocks);
		if (updatedApps.length > 0) {
			await setupApps(updatedApps);
		}
	});
}
