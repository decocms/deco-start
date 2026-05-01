import { describe, expect, it } from "vitest";
import { generateHooks } from "./hooks";
import type { MigrationContext } from "../types";

function makeCtx(platform: MigrationContext["platform"]): MigrationContext {
	return {
		sourceDir: "/tmp",
		siteName: "test",
		platform,
		vtexAccount: null,
		gtmId: null,
		importMap: {},
		discoveredNpmDeps: {},
		themeColors: {},
		fontFamily: null,
		files: [],
		sectionMetas: [],
		islandClassifications: [],
		islandWrapperTargets: new Map(),
		loaderInventory: [],
		scaffoldedFiles: [],
		transformedFiles: [],
		deletedFiles: [],
		movedFiles: [],
		manualReviewItems: [],
		frameworkFindings: [],
		dryRun: false,
		verbose: false,
	};
}

describe("generateHooks (vtex)", () => {
	const files = generateHooks(makeCtx("vtex"));

	it("emits all three hook files", () => {
		expect(Object.keys(files).sort()).toEqual([
			"src/hooks/useCart.ts",
			"src/hooks/useUser.ts",
			"src/hooks/useWishlist.ts",
		]);
	});

	it("useCart is the createUseCart factory shim, not 250-line legacy boilerplate", () => {
		const code = files["src/hooks/useCart.ts"];
		// Imports from the framework factory.
		expect(code).toContain(
			'import { createUseCart } from "@decocms/apps/vtex/hooks/createUseCart"',
		);
		expect(code).toContain('import { invoke } from "~/server/invoke"');
		// Re-exports types from @decocms/apps directly.
		expect(code).toContain(
			'export type { OrderForm, OrderFormItem } from "@decocms/apps/vtex/types"',
		);
		// Calls the factory with invoke and destructures the public API.
		expect(code).toContain(
			"export const { useCart, resetCart, itemToAnalyticsItem } = createUseCart",
		);
		// And does NOT contain the old singleton machinery.
		expect(code).not.toContain("const _listeners = new Set");
		expect(code).not.toContain("forceRender");
		expect(code).not.toContain("function getOrderFormIdFromCookie");
	});

	it("useCart shim is dramatically smaller than the legacy template", () => {
		const lineCount = files["src/hooks/useCart.ts"].split("\n").length;
		// Should be well under 20 lines (factory call + re-export + imports).
		expect(lineCount).toBeLessThan(20);
	});

	it("useUser is the createUseUser factory shim (no signal-stub boilerplate)", () => {
		const code = files["src/hooks/useUser.ts"];
		expect(code).toContain(
			'import { createUseUser } from "@decocms/apps/vtex/hooks/createUseUser"',
		);
		expect(code).toContain('import { invoke } from "~/server/invoke"');
		expect(code).toContain(
			'export type { Person } from "@decocms/apps/vtex/loaders/user"',
		);
		expect(code).toContain("export const { useUser, resetUser } = createUseUser");
		// Must NOT scaffold the legacy signal stub.
		expect(code).not.toContain('signal<User | null>(null)');
		expect(code).not.toContain("export interface User {");
	});

	it("useWishlist is the createUseWishlist factory shim", () => {
		const code = files["src/hooks/useWishlist.ts"];
		expect(code).toContain(
			'import { createUseWishlist } from "@decocms/apps/vtex/hooks/createUseWishlist"',
		);
		expect(code).toContain('import { invoke } from "~/server/invoke"');
		expect(code).toContain(
			'export type { WishlistItem } from "@decocms/apps/vtex/loaders/wishlist"',
		);
		expect(code).toContain(
			"export const { useWishlist, resetWishlist } = createUseWishlist",
		);
		// Must NOT scaffold the legacy stub with TODO action bodies.
		expect(code).not.toContain("TODO: Implement");
		expect(code).not.toContain("getItem(_productId: string): boolean");
	});

	it("useUser + useWishlist VTEX shims are each well under 10 lines", () => {
		expect(files["src/hooks/useUser.ts"].split("\n").length).toBeLessThan(10);
		expect(files["src/hooks/useWishlist.ts"].split("\n").length).toBeLessThan(10);
	});
});

describe("generateHooks (non-vtex)", () => {
	it("custom platform falls back to the generic stub", () => {
		const files = generateHooks(makeCtx("custom"));
		const code = files["src/hooks/useCart.ts"];
		expect(code).toContain("Cart Hook stub");
		expect(code).toContain("TODO: Implement");
	});

	it("shopify currently shares the generic stub", () => {
		const files = generateHooks(makeCtx("shopify"));
		const code = files["src/hooks/useCart.ts"];
		// Until a shopify factory exists, non-vtex platforms get the generic stub.
		expect(code).toContain("Cart Hook stub");
	});

	it("non-vtex platforms keep the legacy signal-based useUser stub", () => {
		const files = generateHooks(makeCtx("custom"));
		const code = files["src/hooks/useUser.ts"];
		// No factory CALL — docstring may mention it as a pointer for VTEX.
		expect(code).not.toContain("createUseUser({");
		expect(code).not.toContain("export const { useUser, resetUser }");
		// Legacy stub shape (signal + User interface).
		expect(code).toContain("signal<User | null>(null)");
		expect(code).toContain("export interface User {");
	});

	it("non-vtex platforms keep the legacy useWishlist stub", () => {
		const files = generateHooks(makeCtx("custom"));
		const code = files["src/hooks/useWishlist.ts"];
		expect(code).not.toContain("createUseWishlist({");
		expect(code).not.toContain("export const { useWishlist, resetWishlist }");
		expect(code).toContain("TODO: Implement");
	});
});
