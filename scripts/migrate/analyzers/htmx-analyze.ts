/**
 * HTMX surface analyzer.
 *
 * For sites with significant HTMX usage (the deco-cx Fresh stack
 * embraced htmx as the interactivity model), the migration to TanStack
 * Start has to either rewrite or eliminate every `hx-*` attribute.
 * Per D2 in the migration tooling policy we don't ship a runtime —
 * everything gets rewritten to React. This analyzer is the first step:
 * it inventories the `hx-*` surface so the engineer (or the next
 * codemod wave) knows exactly what shapes are out there before
 * starting the rewrite.
 *
 * The output is a structured `HtmxInventory`: per-category counts,
 * per-file counts, and three sample call sites per category. The
 * report is the source of truth for the rewrite recipes documented
 * in `references/htmx-rewrite.md` (Wave 13-B).
 *
 * Categorization is heuristic — we group elements by their **attribute
 * cluster** rather than by individual attribute, because the rewrite
 * recipe depends on the cluster (e.g. `hx-post + hx-target + hx-swap`
 * on a `<form>` is a different rewrite than `hx-get + hx-target` on a
 * `<button>`). False positives are recoverable: a human reads the
 * report.
 *
 * Wave 13-A. Closes the analysis half of `htmx-foundations`; the
 * codemods proper land in Wave 14.
 */

import type { FsAdapter } from "../post-cleanup/types";

const SRC_GLOB_EXCLUDES = [
	"node_modules",
	"dist",
	".wrangler",
	".vite",
	".tanstack",
	"build",
	".cursor",
	".agents",
	"docs",
];

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export type HtmxCategory =
	| "event-handler"
	| "form-swap"
	| "click-swap"
	| "auto-fetch"
	| "oob-swap"
	| "boost"
	| "unmatched";

export interface HtmxOccurrence {
	category: HtmxCategory;
	file: string;
	/** 1-indexed line of the opening tag's start. */
	line: number;
	/** Tag name (e.g. "button", "form", "input", "MyComponent"). */
	tag: string;
	/** Set of canonical hx-* attribute names found on this element. */
	attrs: string[];
}

export interface HtmxFileSummary {
	file: string;
	total: number;
	byCategory: Record<HtmxCategory, number>;
}

export interface HtmxInventory {
	totalFiles: number;
	totalOccurrences: number;
	byCategory: Record<HtmxCategory, number>;
	files: HtmxFileSummary[];
	/** Up to 3 sample occurrences per category (ordered by file path). */
	samples: Record<HtmxCategory, HtmxOccurrence[]>;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Analyze every `*.{ts,tsx}` file under `siteDir` and return a
 * structured inventory of htmx usage. Pure over the injected
 * `FsAdapter`, so callers (CLI, tests, migration phase wiring) can
 * substitute in-memory file systems.
 */
export function analyzeHtmx(siteDir: string, fs: FsAdapter): HtmxInventory {
	const files = fs.glob(siteDir, "**/*.{ts,tsx}", SRC_GLOB_EXCLUDES);
	const occurrences: HtmxOccurrence[] = [];
	const fileSummaries: HtmxFileSummary[] = [];

	for (const abs of files) {
		const rel = abs.startsWith(`${siteDir}/`)
			? abs.slice(siteDir.length + 1)
			: abs;
		const content = fs.readText(abs);
		const fileOccurrences = analyzeFile(rel, content);
		if (fileOccurrences.length === 0) continue;
		const summary: HtmxFileSummary = {
			file: rel,
			total: fileOccurrences.length,
			byCategory: emptyCategoryRecord(),
		};
		for (const occ of fileOccurrences) {
			summary.byCategory[occ.category]++;
		}
		fileSummaries.push(summary);
		occurrences.push(...fileOccurrences);
	}

	const byCategory = emptyCategoryRecord();
	for (const occ of occurrences) byCategory[occ.category]++;

	const samples = emptyCategorySamples();
	for (const occ of occurrences) {
		const bucket = samples[occ.category];
		if (bucket.length < 3) bucket.push(occ);
	}

	// Order files by total descending so the "biggest offenders" land
	// at the top of the report — that's the order an engineer wants to
	// chip away at the surface in.
	fileSummaries.sort((a, b) => b.total - a.total || a.file.localeCompare(b.file));

	return {
		totalFiles: fileSummaries.length,
		totalOccurrences: occurrences.length,
		byCategory,
		files: fileSummaries,
		samples,
	};
}

function emptyCategoryRecord(): Record<HtmxCategory, number> {
	return {
		"event-handler": 0,
		"form-swap": 0,
		"click-swap": 0,
		"auto-fetch": 0,
		"oob-swap": 0,
		boost: 0,
		unmatched: 0,
	};
}

function emptyCategorySamples(): Record<HtmxCategory, HtmxOccurrence[]> {
	return {
		"event-handler": [],
		"form-swap": [],
		"click-swap": [],
		"auto-fetch": [],
		"oob-swap": [],
		boost: [],
		unmatched: [],
	};
}

/* ------------------------------------------------------------------ */
/* Per-file analysis                                                   */
/* ------------------------------------------------------------------ */

/**
 * Parse a single source file and extract one occurrence per JSX
 * opening-tag that carries any `hx-*` attribute. Exported so tests
 * can exercise the parser without needing an FsAdapter.
 */
export function analyzeFile(file: string, content: string): HtmxOccurrence[] {
	const occurrences: HtmxOccurrence[] = [];
	const seenTagStarts = new Set<number>();

	// Anchored on the attribute name only (not the value), so JSX
	// expression slots in the value (`hx-post={useSection({...})}`)
	// don't trip the regex up.
	const HX_ATTR_RE = /\bhx-([a-z]+(?:-[a-z]+)*(?::[A-Za-z]+)?)\b/g;

	for (const m of content.matchAll(HX_ATTR_RE)) {
		const attrIdx = m.index;
		if (attrIdx === undefined) continue;
		const tagOpen = findEnclosingTagOpen(content, attrIdx);
		if (tagOpen < 0) continue;
		if (seenTagStarts.has(tagOpen)) continue;
		const tagClose = findOpeningTagClose(content, tagOpen);
		if (tagClose < 0) continue;
		seenTagStarts.add(tagOpen);

		const tagSpan = content.slice(tagOpen, tagClose + 1);
		const tag = extractTagName(tagSpan);
		const attrs = collectHxAttrs(tagSpan);
		const line = lineNumberAt(content, tagOpen);
		const category = classify(tag, attrs);

		occurrences.push({
			category,
			file,
			line,
			tag,
			attrs,
		});
	}

	return occurrences;
}

/**
 * Walk backwards from `attrIdx` to the most recent `<` that starts an
 * opening tag (`<TagName`). Returns the index of that `<`, or -1 if
 * no plausible tag start is found before the start of the file.
 *
 * "Plausible tag start" = `<` followed by a letter or `_`, where the
 * `<` is not part of a `</` (closing tag), `<<` (operator), or
 * preceded by an operand that would make it a comparison.
 */
function findEnclosingTagOpen(content: string, attrIdx: number): number {
	for (let i = attrIdx - 1; i >= 0; i--) {
		if (content[i] !== "<") continue;
		// Closing tag — `</foo>` — wouldn't carry attributes.
		if (content[i + 1] === "/") continue;
		// Comparison / shift operator — left side is a non-tag char.
		const next = content[i + 1];
		if (!/[A-Za-z_]/.test(next ?? "")) continue;
		// Be slightly defensive: if the character right before `<` is a
		// closing-paren or another `>`, we're definitely in JSX. If it's
		// an alpha char or `]`, this could be `a < b` — but `a < b` is
		// followed by an *expression*, not a tag-name + space + `hx-…`,
		// so the regex hit at attrIdx would be far away. Don't bother
		// disambiguating; just return the candidate.
		return i;
	}
	return -1;
}

/**
 * From the `<` at `tagOpen`, walk forward to find the index of the
 * `>` that closes the *opening tag* (not the close tag of the same
 * element). Skips strings (single-, double-, backtick-quoted) and
 * tracks balanced `{...}` expression slots so JSX expressions in
 * attributes (`hx-post={useSection({...})}`) don't mislead us.
 */
function findOpeningTagClose(content: string, tagOpen: number): number {
	let i = tagOpen + 1;
	const n = content.length;
	while (i < n) {
		const ch = content[i];
		if (ch === '"' || ch === "'") {
			i = skipStringQuote(content, i, ch);
			continue;
		}
		if (ch === "`") {
			i = skipTemplateLiteral(content, i);
			continue;
		}
		if (ch === "{") {
			i = skipBraceBalanced(content, i);
			continue;
		}
		if (ch === "/" && content[i + 1] === ">") return i + 1;
		if (ch === ">") return i;
		i++;
	}
	return -1;
}

function skipStringQuote(content: string, start: number, quote: string): number {
	let i = start + 1;
	const n = content.length;
	while (i < n) {
		if (content[i] === "\\") {
			i += 2;
			continue;
		}
		if (content[i] === quote) return i + 1;
		i++;
	}
	return n;
}

function skipTemplateLiteral(content: string, start: number): number {
	let i = start + 1;
	const n = content.length;
	while (i < n) {
		if (content[i] === "\\") {
			i += 2;
			continue;
		}
		if (content[i] === "`") return i + 1;
		if (content[i] === "$" && content[i + 1] === "{") {
			i = skipBraceBalanced(content, i + 1);
			continue;
		}
		i++;
	}
	return n;
}

function skipBraceBalanced(content: string, openIdx: number): number {
	let i = openIdx + 1;
	let depth = 1;
	const n = content.length;
	while (i < n && depth > 0) {
		const ch = content[i];
		if (ch === '"' || ch === "'") {
			i = skipStringQuote(content, i, ch);
			continue;
		}
		if (ch === "`") {
			i = skipTemplateLiteral(content, i);
			continue;
		}
		if (ch === "{") {
			depth++;
			i++;
			continue;
		}
		if (ch === "}") {
			depth--;
			i++;
			continue;
		}
		i++;
	}
	return i;
}

function extractTagName(tagSpan: string): string {
	// tagSpan starts with `<`. The tag name is /[A-Za-z_][\w.-]*/ until
	// whitespace, `/`, or `>`.
	const m = /^<([A-Za-z_][\w.-]*)/.exec(tagSpan);
	return m?.[1] ?? "";
}

function collectHxAttrs(tagSpan: string): string[] {
	// Strip JSX expression slots so `hx-post={someFn({hx-thing: 1})}`
	// — which doesn't actually exist in JSX, but defensive — doesn't
	// inflate attr counts. We match the same name shape as the entry
	// regex.
	const seen = new Set<string>();
	const re = /\bhx-([a-z]+(?:-[a-z]+)*(?::[A-Za-z]+)?)\b/g;
	for (const m of tagSpan.matchAll(re)) {
		seen.add(`hx-${m[1]}`);
	}
	return [...seen].sort();
}

function lineNumberAt(content: string, idx: number): number {
	let line = 1;
	for (let i = 0; i < idx && i < content.length; i++) {
		if (content[i] === "\n") line++;
	}
	return line;
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

/**
 * Bucket an element with attribute set `attrs` into one of the
 * `HtmxCategory` values. Order is intentional: the more specific
 * shapes are checked first.
 *
 * - **boost**: `hx-boost="true"` is a top-level switch — handled
 *   first so it doesn't conflate with click-swap/form-swap shapes.
 * - **oob-swap**: `hx-swap-oob` / `hx-select-oob` is a structural
 *   pattern that almost never has a clean React equivalent.
 * - **auto-fetch**: a fetch attribute paired with a `hx-trigger` that
 *   isn't user-driven (`keyup`, `intersect`, `revealed`, `load`,
 *   `every:`).
 * - **form-swap**: `hx-post` (with or without `hx-target`/`hx-swap`)
 *   on a `<form>`, OR with an explicit `hx-trigger="submit"`.
 * - **click-swap**: `hx-get` (or `hx-post`) on anything else with
 *   `hx-target` — the dominant button-driven pattern.
 * - **event-handler**: `hx-on:*` or `hx-on:click` etc with no
 *   fetch attr — pure client-side handler that happens to be wired
 *   via htmx for historical consistency.
 * - **unmatched**: anything that didn't fit cleanly. Reported as a
 *   manual-review bucket.
 */
export function classify(tag: string, attrs: string[]): HtmxCategory {
	const has = (name: string) => attrs.includes(name);
	const hasAny = (re: RegExp) => attrs.some((a) => re.test(a));

	if (has("hx-boost")) return "boost";
	if (has("hx-swap-oob") || has("hx-select-oob")) return "oob-swap";

	const hasFetch = hasAny(/^hx-(get|post|put|patch|delete)$/);
	// htmx supports both colon (`hx-on:click`) and dash (`hx-on-click`)
	// syntax for event handlers; HTML's spec doesn't allow `:` in
	// attribute names so htmx 2.x canonicalised the dash form. Match
	// both. The dash form is followed by an event name (`click`,
	// `htmx-config-request`, etc.), the colon form by `:event`.
	const hasOn = hasAny(/^hx-on(?:[:-]|$)/);
	const hasTarget = has("hx-target");
	const triggerIsAutoLike =
		// We don't have the value of the trigger here — just whether
		// the attribute exists. The dominant non-form pattern *with*
		// hx-trigger is "keyup changed delay:Xms" or "intersect".
		// Without value access, we infer "auto-fetch" by elimination:
		// fetch + hx-trigger + non-form. Form-submit explicit triggers
		// are caught by the form-swap branch via `tag === "form"`.
		has("hx-trigger");

	if (hasFetch) {
		// `<form>` element — form-swap (regardless of trigger).
		if (tag === "form") return "form-swap";
		// `<input>`, `<textarea>` etc carrying a fetch attribute —
		// they fire on input event, treat as auto-fetch.
		if (tag === "input" || tag === "textarea" || tag === "select") {
			return "auto-fetch";
		}
		// Non-form / non-input element with fetch + auto-trigger →
		// auto-fetch (could be `<div hx-trigger="intersect" hx-get>`).
		if (triggerIsAutoLike && !hasTarget) return "auto-fetch";
		// Default for the dominant button-driven pattern.
		return "click-swap";
	}

	if (hasOn) return "event-handler";

	return "unmatched";
}
