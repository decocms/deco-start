/**
 * Auto-configures known apps from CMS blocks.
 *
 * For each known app:
 * 1. Try to import `@decocms/apps/{app}/mod` (standard contract: configure + handlers)
 * 2. If mod.ts doesn't exist, use inline fallback configurator
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
// App configurator interface
// ---------------------------------------------------------------------------

interface AppConfigurator {
	(blockData: unknown): Promise<Record<string, InvokeAction>>;
}

// ---------------------------------------------------------------------------
// Inline fallbacks (used when @decocms/apps/{app}/mod doesn't exist yet)
// ---------------------------------------------------------------------------

const INLINE_FALLBACKS: Record<string, AppConfigurator> = {
	resend: async (block: any) => {
		try {
			const [clientMod, actionMod] = await Promise.all([
				import("@decocms/apps/resend/client"),
				import("@decocms/apps/resend/actions/send"),
			]);

			const apiKey = await resolveSecret(block.apiKey, "RESEND_API_KEY");
			if (!apiKey) {
				console.warn(
					"[autoconfig] deco-resend: no API key found." +
					" Set DECO_CRYPTO_KEY to decrypt CMS secrets, or set RESEND_API_KEY as fallback.",
				);
				return {};
			}

			clientMod.configureResend({
				apiKey,
				emailFrom: block.emailFrom
					? `${block.emailFrom.name || "Contact"} <${block.emailFrom.domain || "onboarding@resend.dev"}>`
					: undefined,
				emailTo: block.emailTo,
				subject: block.subject,
			});

			const handler: InvokeAction = async (props) => actionMod.sendEmail(props);
			return {
				"resend/actions/emails/send": handler,
				"resend/actions/emails/send.ts": handler,
			};
		} catch {
			return {};
		}
	},
};

// ---------------------------------------------------------------------------
// Block key → app name mapping
// ---------------------------------------------------------------------------

const BLOCK_TO_APP: Record<string, string> = {
	"deco-resend": "resend",
};

// ---------------------------------------------------------------------------
// App loader: try mod.ts first, then inline fallback
// ---------------------------------------------------------------------------

interface AppMod {
	configure: (
		blockData: unknown,
		resolveSecret: (value: unknown, envKey: string) => Promise<string | null>,
	) => Promise<boolean>;
	handlers: Record<string, (props: any, request: Request) => Promise<any>>;
}

async function loadAndConfigureApp(
	blockKey: string,
	appName: string,
	blockData: unknown,
): Promise<Record<string, InvokeAction>> {
	// Strategy 1: try @decocms/apps/{app}/mod (standard contract)
	try {
		// Use static-like import patterns that Vite can resolve
		const mod = await tryImportAppMod(appName);
		if (mod) {
			const ok = await mod.configure(blockData, resolveSecret);
			if (!ok) {
				console.warn(
					`[autoconfig] ${blockKey}: configure() returned false.` +
					` Set DECO_CRYPTO_KEY to decrypt CMS secrets, or set the app env var fallback.`,
				);
				return {};
			}
			console.log(`[autoconfig] ${blockKey}: configured via mod.ts (${Object.keys(mod.handlers).length} handlers)`);
			return mod.handlers;
		}
	} catch {
		// mod.ts not available — fall through to inline
	}

	// Strategy 2: inline fallback
	const fallback = INLINE_FALLBACKS[appName];
	if (fallback) {
		const actions = await fallback(blockData);
		if (Object.keys(actions).length > 0) {
			console.log(`[autoconfig] ${blockKey}: configured via inline fallback (${Object.keys(actions).length} handlers)`);
		}
		return actions;
	}

	return {};
}

/**
 * Try to import the app mod. Returns null if not available.
 * Uses explicit import paths instead of template literals to avoid
 * Cloudflare Workers vite plugin crashes on missing modules.
 */
async function tryImportAppMod(appName: string): Promise<AppMod | null> {
	// Map known apps to static imports (CF Workers can't do dynamic string imports)
	switch (appName) {
		case "resend":
			try {
				return await import("@decocms/apps/resend/mod");
			} catch {
				return null;
			}
		default:
			return null;
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

		try {
			const appActions = await loadAndConfigureApp(blockKey, appName, block);
			Object.assign(actions, appActions);
		} catch (e) {
			console.warn(`[autoconfig] ${blockKey}:`, e);
		}
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
