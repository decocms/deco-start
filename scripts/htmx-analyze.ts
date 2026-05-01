#!/usr/bin/env tsx
/**
 * HTMX surface analyzer — CLI entry point.
 *
 * Inventories the `hx-*` surface of a Deco storefront so the engineer
 * (or the next codemod wave) knows exactly what shapes are out there
 * before starting the rewrite to React. Per D2 in the migration
 * tooling policy, all htmx is rewritten on migration; no runtime is
 * shipped in `@decocms/start`.
 *
 * Usage (from a site directory):
 *   npx -p @decocms/start deco-htmx-analyze
 *   npx -p @decocms/start deco-htmx-analyze --source /path/to/site
 *   npx -p @decocms/start deco-htmx-analyze --json
 *
 * Options:
 *   --source <dir>   Site directory to analyze (default: current directory)
 *   --json           Emit machine-readable JSON instead of pretty text
 *   --top <n>        Show top N files by occurrence count (default: 20)
 *   --help, -h       Show this help
 *
 * Wave 13-A. Read-only. Codemods land in Wave 14.
 */

import * as path from "node:path";
import { realFsAdapter } from "./migrate/post-cleanup/runner";
import {
	analyzeHtmx,
	type HtmxCategory,
	type HtmxInventory,
} from "./migrate/analyzers/htmx-analyze";
import { banner, bold, cyan, gray, green, red, yellow } from "./migrate/colors";

interface CliOpts {
	source: string;
	json: boolean;
	top: number;
	help: boolean;
}

function parseArgs(args: string[]): CliOpts {
	let source = ".";
	let json = false;
	let top = 20;
	let help = false;
	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--source":
				source = args[++i];
				break;
			case "--json":
				json = true;
				break;
			case "--top":
				top = Number.parseInt(args[++i] ?? "20", 10);
				if (Number.isNaN(top) || top < 0) top = 20;
				break;
			case "--help":
			case "-h":
				help = true;
				break;
			default:
				console.error(`Unknown argument: ${args[i]}`);
				process.exit(1);
		}
	}
	return { source, json, top, help };
}

function printHelp(): void {
	console.log(`deco-htmx-analyze

Inventory the htmx surface (hx-* attributes) of a Deco storefront.

Usage:
  npx -p @decocms/start deco-htmx-analyze [options]

Options:
  --source <dir>   Site directory to analyze (default: cwd)
  --json           Emit machine-readable JSON
  --top <n>        Top N files by occurrence count (default: 20)
  --help, -h       Show this help

The output is read-only. Codemods that rewrite htmx to React are a
planned follow-up — see the deco-to-tanstack-migration skill for the
per-pattern rewrite recipes.
`);
}

const CATEGORY_DESCRIPTIONS: Record<HtmxCategory, string> = {
	"event-handler": "hx-on:* with no fetch attr — pure client-side handler",
	"form-swap": "hx-post on a <form> with hx-target/hx-swap",
	"click-swap": "hx-get/hx-post on a button with hx-target",
	"auto-fetch": "hx-trigger=keyup/intersect/etc on input or auto-fired element",
	"oob-swap": "hx-swap-oob / hx-select-oob — out-of-band patches",
	boost: "hx-boost=true — link prefetch, already-SPA in TanStack Start",
	unmatched: "hx-* attribute set that didn't match a known pattern",
};

const CATEGORY_RECIPES: Record<HtmxCategory, string> = {
	"event-handler":
		"replace hx-on:click={useScript(...)} with onClick={() => { ... }}",
	"form-swap":
		"<form onSubmit> + useMutation/server function; render result with state",
	"click-swap":
		"setState/setView + conditional render, or sub-route via TanStack Router",
	"auto-fetch":
		"debounced state + useQuery; for intersect use IntersectionObserver",
	"oob-swap":
		"manual: out-of-band has no 1:1; refactor to broadcast event + listener",
	boost: "replace <a hx-boost> with TanStack Router <Link> (already SPA)",
	unmatched: "manual review",
};

const CATEGORY_ORDER: HtmxCategory[] = [
	"event-handler",
	"click-swap",
	"form-swap",
	"auto-fetch",
	"boost",
	"oob-swap",
	"unmatched",
];

function printText(inv: HtmxInventory, top: number): void {
	banner("HTMX surface analysis");

	if (inv.totalOccurrences === 0) {
		console.log(green("✓ No hx-* attributes found.\n"));
		return;
	}

	console.log(`${bold("Files with hx-* usage:")} ${inv.totalFiles}`);
	console.log(`${bold("Total occurrences:")}    ${inv.totalOccurrences}\n`);

	console.log(bold("By category:"));
	for (const cat of CATEGORY_ORDER) {
		const count = inv.byCategory[cat];
		if (count === 0) continue;
		const label = `${cat.padEnd(15)}`;
		const desc = gray(CATEGORY_DESCRIPTIONS[cat]);
		console.log(`  ${cyan(label)} ${String(count).padStart(4)}  ${desc}`);
	}

	console.log(`\n${bold("Migration recipes:")}`);
	for (const cat of CATEGORY_ORDER) {
		if (inv.byCategory[cat] === 0) continue;
		console.log(`  ${cyan(cat.padEnd(15))} ${gray(CATEGORY_RECIPES[cat])}`);
	}

	console.log(`\n${bold(`Top ${top} files by occurrence:`)}`);
	const slice = inv.files.slice(0, top);
	const widest = Math.max(...slice.map((f) => f.file.length), 30);
	for (const f of slice) {
		const detail = CATEGORY_ORDER.filter((c) => f.byCategory[c] > 0)
			.map((c) => `${c}=${f.byCategory[c]}`)
			.join(", ");
		console.log(
			`  ${f.file.padEnd(widest)}  ${String(f.total).padStart(3)}  ${gray(detail)}`,
		);
	}

	if (inv.files.length > top) {
		console.log(gray(`  …and ${inv.files.length - top} more file(s)`));
	}

	console.log(`\n${bold("Sample call sites:")}`);
	for (const cat of CATEGORY_ORDER) {
		const samples = inv.samples[cat];
		if (samples.length === 0) continue;
		console.log(`  ${cyan(cat)}`);
		for (const s of samples) {
			const attrs = s.attrs.join(", ");
			console.log(
				`    ${gray(`${s.file}:${s.line}`)} <${s.tag}> [${attrs}]`,
			);
		}
	}

	const hasOob = inv.byCategory["oob-swap"] > 0;
	const hasUnmatched = inv.byCategory.unmatched > 0;
	if (hasOob || hasUnmatched) {
		console.log();
		if (hasOob) {
			console.log(
				yellow(
					"⚠ oob-swap occurrences require manual rewrite — no 1:1 React equivalent.",
				),
			);
		}
		if (hasUnmatched) {
			console.log(
				yellow(
					"⚠ unmatched occurrences require manual review — see Sample call sites.",
				),
			);
		}
	}
	console.log();
}

function main(argv: string[]): number {
	const opts = parseArgs(argv);
	if (opts.help) {
		printHelp();
		return 0;
	}

	const sourceDir = path.resolve(opts.source);
	const inv = analyzeHtmx(sourceDir, realFsAdapter);

	if (opts.json) {
		console.log(JSON.stringify(inv, null, 2));
	} else {
		printText(inv, opts.top);
	}
	return 0;
}

try {
	process.exit(main(process.argv.slice(2)));
} catch (err) {
	console.error(red(`✗ deco-htmx-analyze failed: ${(err as Error).message}`));
	if (process.env.DEBUG) console.error((err as Error).stack);
	process.exit(1);
}
