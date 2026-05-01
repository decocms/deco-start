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
});
