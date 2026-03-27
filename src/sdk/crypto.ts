/**
 * Secret decryption for CMS encrypted values.
 *
 * CMS blocks store sensitive values (API keys, tokens) encrypted with AES-CBC.
 * The encryption key is stored in the DECO_CRYPTO_KEY environment variable
 * as a base64-encoded JSON: { key: number[], iv: number[] }
 *
 * Usage:
 *   import { decryptSecret, resolveSecret } from "@decocms/start/sdk/crypto";
 *
 *   // Decrypt a hex-encoded encrypted string
 *   const apiKey = await decryptSecret("888fafd937dd...");
 *
 *   // Or resolve a CMS secret block (handles all formats)
 *   const apiKey = await resolveSecret(block.apiKey, "RESEND_API_KEY");
 */

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

// Cache the imported key
let cachedKey: Promise<{ key: CryptoKey; iv: Uint8Array }> | null = null;

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes;
}

/**
 * Get the AES key from DECO_CRYPTO_KEY environment variable.
 * Returns null if not set.
 */
function getKeyFromEnv(): Promise<{ key: CryptoKey; iv: Uint8Array }> | null {
	const envKey = process.env.DECO_CRYPTO_KEY;
	if (!envKey) return null;

	return cachedKey ??= (async () => {
		const parsed = JSON.parse(atob(envKey));
		const keyBytes = new Uint8Array(
			Array.isArray(parsed.key) ? parsed.key : Object.values(parsed.key),
		);
		const iv = new Uint8Array(
			Array.isArray(parsed.iv) ? parsed.iv : Object.values(parsed.iv),
		);

		const importedKey = await crypto.subtle.importKey(
			"raw",
			keyBytes.buffer,
			"AES-CBC",
			false,
			["decrypt"],
		);

		return { key: importedKey, iv };
	})();
}

/**
 * Check if the crypto key is available.
 */
export function hasCryptoKey(): boolean {
	return !!process.env.DECO_CRYPTO_KEY;
}

/**
 * Decrypt a hex-encoded AES-CBC encrypted string.
 * Requires DECO_CRYPTO_KEY environment variable.
 *
 * @returns The decrypted string, or null if decryption fails.
 */
export async function decryptSecret(encryptedHex: string): Promise<string | null> {
	const keyPromise = getKeyFromEnv();
	if (!keyPromise) {
		return null;
	}

	try {
		const { key, iv } = await keyPromise;
		const encryptedBytes = hexToBytes(encryptedHex);
		const decrypted = await crypto.subtle.decrypt(
			{ name: "AES-CBC", iv } as AesCbcParams,
			key,
			encryptedBytes as unknown as BufferSource,
		);
		return textDecoder.decode(new Uint8Array(decrypted));
	} catch (e) {
		console.warn("[crypto] Failed to decrypt secret:", (e as Error).message);
		return null;
	}
}

// In-memory cache for resolved secrets
const secretCache = new Map<string, string | null>();

/**
 * Resolve a CMS secret value from multiple sources.
 *
 * Resolution order:
 * 1. Plain string → use directly
 * 2. Object with .get() → call .get() (old Secret loader pattern)
 * 3. Object with .encrypted → decrypt using DECO_CRYPTO_KEY
 * 4. Environment variable (envVarName) → fallback
 *
 * @param value - The secret value from CMS block (string | { encrypted } | { get })
 * @param envVarName - Optional env var name to use as fallback (e.g. "RESEND_API_KEY")
 * @returns The resolved secret string, or null if not available
 */
export async function resolveSecret(
	value: unknown,
	envVarName?: string,
): Promise<string | null> {
	// 1. Plain string
	if (typeof value === "string" && value.length > 0) {
		return value;
	}

	if (value && typeof value === "object") {
		const obj = value as Record<string, any>;

		// 2. Secret object with .get()
		if (typeof obj.get === "function") {
			const result = obj.get();
			if (typeof result === "string" && result.length > 0) return result;
		}

		// 3. Encrypted secret
		if (typeof obj.encrypted === "string" && obj.encrypted.length > 0) {
			const cacheKey = obj.encrypted;
			if (secretCache.has(cacheKey)) return secretCache.get(cacheKey)!;

			const decrypted = await decryptSecret(obj.encrypted);
			// Only cache successful decryptions — null would block env var fallback
			if (decrypted) {
				secretCache.set(cacheKey, decrypted);
				return decrypted;
			}
		}
	}

	// 4. Environment variable fallback
	if (envVarName) {
		const envValue = process.env[envVarName];
		if (envValue) return envValue;
	}

	return null;
}
