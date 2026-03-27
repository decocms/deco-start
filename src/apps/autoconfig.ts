/**
 * Auto-configures known apps from CMS blocks.
 *
 * Scans the decofile for block keys matching known apps and dynamically imports
 * their `mod.ts` from @decocms/apps. Each app mod exports:
 * - `configure(blockData, resolveSecret)` → configures the app client
 * - `handlers` → record of invoke handler keys → handler functions
 *
 * Zero hardcoded app logic in the framework — all app-specific code lives in
 * @decocms/apps/{app}/mod.ts.
 *
 * Usage in setup.ts:
 *   import { autoconfigApps } from "@decocms/start/apps/autoconfig";
 *   setBlocks(generatedBlocks);
 *   await autoconfigApps(generatedBlocks);
 */

import { setInvokeActions, type InvokeAction } from "../admin/invoke";
import { onChange } from "../cms/loader";
import { resolveSecret } from "../sdk/crypto";

// ---------------------------------------------------------------------------
// Block key → @decocms/apps module mapping
// ---------------------------------------------------------------------------

/**
 * Maps CMS block keys (e.g. "deco-resend") to their @decocms/apps module path.
 * To add a new app, just add an entry here — no other code changes needed.
 */
const BLOCK_TO_APP: Record<string, string> = {
	"deco-resend": "resend",
	// "deco-analytics": "analytics",
	// "deco-shopify": "shopify",
	// "deco-vtex": "vtex",
};

// ---------------------------------------------------------------------------
// Generic app loader
// ---------------------------------------------------------------------------

interface AppMod {
	configure: (
		blockData: unknown,
		resolveSecret: (value: unknown, envKey: string) => Promise<string | null>,
	) => Promise<boolean>;
	handlers: Record<string, (props: any, request: Request) => Promise<any>>;
}

/**
 * Import app mod using static imports.
 * CF Workers can't catch errors from dynamic string template imports —
 * the vite plugin crashes with AssertionError before the catch runs.
 * Each known app gets a case here. When adding a new app to BLOCK_TO_APP,
 * also add a case to this switch.
 */
async function importAppMod(appName: string): Promise<AppMod | null> {
	try {
		switch (appName) {
			case "resend":
				return await import("@decocms/apps/resend/mod");
			default:
				return null;
		}
	} catch {
		return null;
	}
}

async function loadAndConfigureApp(
	blockKey: string,
	appName: string,
	blockData: unknown,
): Promise<Record<string, InvokeAction>> {
	const mod = await importAppMod(appName);
	if (!mod) return {};

	try {
		const ok = await mod.configure(blockData, resolveSecret);
		if (!ok) {
			console.warn(
				`[autoconfig] ${blockKey}: configure() returned false.` +
				` Set DECO_CRYPTO_KEY to decrypt CMS secrets, or set the app's env var fallback.`,
			);
			return {};
		}

		console.log(`[autoconfig] ${blockKey}: configured (${Object.keys(mod.handlers).length} handlers)`);
		return mod.handlers;
	} catch (e) {
		console.warn(`[autoconfig] ${blockKey}:`, e);
		return {};
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function configureAll(blocks: Record<string, unknown>): Promise<Record<string, InvokeAction>> {
	const actions: Record<string, InvokeAction> = {};

	for (const [blockKey, appName] of Object.entries(BLOCK_TO_APP)) {
		const block = blocks[blockKey];
		if (!block) continue;

		const appActions = await loadAndConfigureApp(blockKey, appName, block);
		Object.assign(actions, appActions);
	}

	return actions;
}

/**
 * Auto-configure apps from CMS blocks.
 * Call in setup.ts after setBlocks(). Also re-runs on admin hot-reload.
 */
export async function autoconfigApps(blocks: Record<string, unknown>) {
	if (typeof document !== "undefined") return; // server-only

	const actions = await configureAll(blocks);

	if (Object.keys(actions).length > 0) {
		setInvokeActions(() => ({ ...actions }));
	}

	// Re-configure on admin hot-reload
	onChange(async (newBlocks) => {
		if (typeof document !== "undefined") return;
		const updatedActions = await configureAll(newBlocks);
		if (Object.keys(updatedActions).length > 0) {
			setInvokeActions(() => ({ ...updatedActions }));
		}
	});
}
