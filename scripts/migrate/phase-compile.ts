/**
 * Phase 8 — Compile.
 *
 * After scaffolding, transforming, and bootstrapping the migrated site,
 * actually run the TypeScript compiler (and optionally a full Vite build) to
 * catch regressions that escaped the static `phase-verify` checks.
 *
 * This is the gate that would have caught past migration regressions like:
 *   - #105 TS5097 (rewriter leaving `.ts` extensions in imports)
 *   - the dead `src/lib/*` shims that broke `phase-cleanup`
 *   - import-rewrite gaps where `from "apps/foo"` silently became `from ""`
 *
 * Behavior:
 *   - Default: typecheck only (`tsc --noEmit`). Failures are surfaced as
 *     warnings — the migration completes, but the user sees the diagnostics.
 *   - `--strict`: failures abort the migration with a non-zero exit code so
 *     CI can fail.
 *   - `--with-build`: also runs `npx vite build` after typecheck. Slower
 *     (~30-90s) but catches runtime-only issues like missing exports.
 *
 * No-ops in dry-run mode.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { gray, green, red, yellow } from "./colors";
import type { MigrationContext } from "./types";
import { logPhase } from "./types";

export type CompileRunResult =
	| { ok: true }
	| { ok: false; output: string };

export interface CompileOptions {
	/** Promote typecheck/build failures from warnings to errors (exit code 2). */
	strict?: boolean;
	/** Also run `npx vite build` after typecheck. */
	withBuild?: boolean;
	/**
	 * Internal: override the command runner. Tests inject a stub here; the
	 * default uses `child_process.execSync`.
	 */
	runner?: (cmd: string, cwd: string) => CompileRunResult;
}

export interface CompileResult {
	skipped: boolean;
	typecheck: { ran: boolean; passed: boolean; output?: string };
	build: { ran: boolean; passed: boolean; output?: string };
	/** True iff compile decided the migration should fail (only in strict mode). */
	shouldFail: boolean;
}

const MAX_OUTPUT_LINES = 50;

function truncate(output: string, maxLines: number): string {
	const lines = output.split("\n");
	if (lines.length <= maxLines) return output;
	return [
		...lines.slice(0, maxLines),
		gray(`  … (${lines.length - maxLines} more lines truncated)`),
	].join("\n");
}

/** Default command runner — uses execSync. Overridable for tests. */
function defaultRunner(cmd: string, cwd: string): CompileRunResult {
	try {
		execSync(cmd, { cwd, stdio: "pipe" });
		return { ok: true };
	} catch (e: unknown) {
		const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
		const stdout = err.stdout?.toString() ?? "";
		const stderr = err.stderr?.toString() ?? "";
		const output = (stdout + stderr).trim() || err.message || "Unknown error";
		return { ok: false, output };
	}
}

/** Exported for testing. */
export { truncate as _truncateForTesting };

/**
 * Run the post-bootstrap compile checks.
 *
 * Returns `{ shouldFail }` so the caller (migrate.ts) can decide whether to
 * exit non-zero. We don't `process.exit()` ourselves so this stays unit-testable.
 */
export function compile(
	ctx: MigrationContext,
	opts: CompileOptions = {},
): CompileResult {
	logPhase("Compile (TypeScript + optional build)");

	const result: CompileResult = {
		skipped: false,
		typecheck: { ran: false, passed: false },
		build: { ran: false, passed: false },
		shouldFail: false,
	};

	if (ctx.dryRun) {
		console.log("  Skipping compile in dry-run mode\n");
		result.skipped = true;
		return result;
	}

	// Compile relies on `node_modules/`. If bootstrap was skipped or failed
	// before the install step we have nothing to typecheck — bail with a
	// clear message rather than exploding.
	const nodeModules = path.join(ctx.sourceDir, "node_modules");
	if (!fs.existsSync(nodeModules)) {
		console.log(
			`  ${yellow("⚠")} Skipping compile — node_modules/ missing (bootstrap likely failed)\n`,
		);
		result.skipped = true;
		return result;
	}

	const runner = opts.runner ?? defaultRunner;

	// Typecheck.
	console.log("  Running: TypeScript typecheck (npx tsc --noEmit)...");
	const tsc = runner("npx tsc --noEmit", ctx.sourceDir);
	result.typecheck.ran = true;
	result.typecheck.passed = tsc.ok;

	if (tsc.ok) {
		console.log(`  ${green("✓")} Typecheck passed`);
	} else {
		const output = truncate(tsc.output, MAX_OUTPUT_LINES);
		result.typecheck.output = tsc.output;
		const icon = opts.strict ? red("✗") : yellow("⚠");
		console.log(`  ${icon} Typecheck failed:\n`);
		console.log(output);
		console.log("");
	}

	// Optional Vite build (heavier, opt-in).
	if (opts.withBuild) {
		console.log("  Running: Vite build (npx vite build)...");
		const vite = runner("npx vite build", ctx.sourceDir);
		result.build.ran = true;
		result.build.passed = vite.ok;

		if (vite.ok) {
			console.log(`  ${green("✓")} Build passed`);
		} else {
			const output = truncate(vite.output, MAX_OUTPUT_LINES);
			result.build.output = vite.output;
			const icon = opts.strict ? red("✗") : yellow("⚠");
			console.log(`  ${icon} Build failed:\n`);
			console.log(output);
			console.log("");
		}
	}

	// Decide whether to fail the migration.
	const anyFailed =
		(result.typecheck.ran && !result.typecheck.passed) ||
		(result.build.ran && !result.build.passed);

	if (anyFailed && opts.strict) {
		result.shouldFail = true;
		console.log(
			`  ${red("Compile failed in strict mode — migration aborted.")}\n`,
		);
	} else if (anyFailed) {
		console.log(
			`  ${yellow("Compile completed with errors.")} Re-run with ${gray("--strict")} in CI to fail the build.\n`,
		);
	} else {
		console.log(`  ${green("Compile passed.")}\n`);
	}

	return result;
}
