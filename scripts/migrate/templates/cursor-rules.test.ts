import { describe, expect, it } from "vitest";
import { generateMigrationPolicyPointerRule } from "./cursor-rules";

describe("generateMigrationPolicyPointerRule", () => {
	const body = generateMigrationPolicyPointerRule("acme");

	it("emits a Cursor MDC rule with alwaysApply: true frontmatter", () => {
		expect(body.startsWith("---\n")).toBe(true);
		expect(body).toContain("alwaysApply: true");
		expect(body).toContain("description:");
	});

	it("interpolates the site name into the body", () => {
		expect(body).toContain("`acme`");
	});

	it("links to the canonical rule and plan in decocms/deco-start", () => {
		expect(body).toContain(
			"https://github.com/decocms/deco-start/blob/main/.cursor/rules/migration-tooling-policy.mdc",
		);
		expect(body).toContain(
			"https://github.com/decocms/deco-start/blob/main/MIGRATION_TOOLING_PLAN.md",
		);
	});

	it("documents D1–D5 by ID, not just by name", () => {
		expect(body).toContain("**D1**");
		expect(body).toContain("**D2**");
		expect(body).toContain("**D3**");
		expect(body).toContain("**D4**");
		expect(body).toContain("**D5**");
	});

	it("points at the post-cleanup --fix command rather than restating policy", () => {
		expect(body).toContain("deco-post-cleanup --fix");
		expect(body).toContain("deco-post-cleanup --strict");
	});

	it("does NOT restate the canonical rule body verbatim (pointer, not a copy)", () => {
		// Length budget: pointer must stay short to discourage drift.
		// The canonical rule in decocms/deco-start is ~110 lines / 4–5 KB;
		// the pointer must be substantially smaller than a copy.
		expect(body.length).toBeLessThan(3000);
	});

	it("is deterministic — same site name, same output", () => {
		const a = generateMigrationPolicyPointerRule("foo");
		const b = generateMigrationPolicyPointerRule("foo");
		expect(a).toBe(b);
	});

	it("escapes nothing weird from siteName — siteName is used as a label only", () => {
		// We don't sanitise; we trust the migration script to pass a real
		// package name. But verify nothing surprising happens with hyphens
		// (a common shape, e.g. "casaevideo-storefront").
		const out = generateMigrationPolicyPointerRule("casaevideo-storefront");
		expect(out).toContain("`casaevideo-storefront`");
	});
});
