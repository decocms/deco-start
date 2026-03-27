/**
 * Auto-configures known apps from CMS blocks.
 *
 * Scans the decofile for known app block keys (e.g. "deco-resend") and:
 * 1. Configures the app client with CMS-provided credentials
 * 2. Registers invoke handlers so `invoke.app.actions.*` works via the proxy
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
// Known app block keys → dynamic import + configure
// ---------------------------------------------------------------------------

interface AppAutoconfigurator {
	/** Try to import, configure, and return invoke actions for this app */
	(blockData: unknown): Promise<Record<string, InvokeAction>>;
}

const KNOWN_APPS: Record<string, AppAutoconfigurator> = {
	"deco-resend": async (block: any) => {
		try {
			const [resendClient, resendActions] = await Promise.all([
				import("@decocms/apps/resend/client" as string),
				import("@decocms/apps/resend/actions/send" as string),
			]);
			const { configureResend } = resendClient as { configureResend: (cfg: any) => void };
			const { sendEmail } = resendActions as { sendEmail: (props: any) => Promise<any> };

			const apiKey = await resolveSecret(block.apiKey, "RESEND_API_KEY");
			if (!apiKey) {
				console.warn(
					"[autoconfig] deco-resend: no API key found." +
					" Set DECO_CRYPTO_KEY to decrypt CMS secrets, or set RESEND_API_KEY as fallback.",
				);
				return {};
			}

			configureResend({
				apiKey,
				emailFrom: block.emailFrom
					? `${block.emailFrom.name || "Contact"} ${block.emailFrom.domain || "<onboarding@resend.dev>"}`
					: undefined,
				emailTo: block.emailTo,
				subject: block.subject,
			});

			return {
				"resend/actions/emails/send.ts": async (props: any) =>
					sendEmail(props),
			};
		} catch {
			// @decocms/apps not installed or doesn't have resend — skip
			return {};
		}
	},
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Auto-configure apps from CMS blocks.
 * Call in setup.ts after setBlocks(). Also re-runs on admin hot-reload.
 */
export async function autoconfigApps(blocks: Record<string, unknown>) {
	if (typeof document !== "undefined") return; // server-only

	const actions: Record<string, InvokeAction> = {};

	for (const [blockKey, configurator] of Object.entries(KNOWN_APPS)) {
		const block = blocks[blockKey];
		if (!block) continue;

		try {
			const appActions = await configurator(block);
			Object.assign(actions, appActions);
		} catch (e) {
			console.warn(`[autoconfig] ${blockKey}:`, e);
		}
	}

	if (Object.keys(actions).length > 0) {
		setInvokeActions(() => ({ ...actions }));
	}

	// Re-configure on admin hot-reload
	onChange(async (newBlocks) => {
		if (typeof document !== "undefined") return;
		const updatedActions: Record<string, InvokeAction> = {};
		for (const [blockKey, configurator] of Object.entries(KNOWN_APPS)) {
			const block = newBlocks[blockKey];
			if (!block) continue;
			try {
				Object.assign(updatedActions, await configurator(block));
			} catch {}
		}
		if (Object.keys(updatedActions).length > 0) {
			setInvokeActions(() => ({ ...updatedActions }));
		}
	});
}
