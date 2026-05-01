import { describe, expect, it } from "vitest";
import {
	analyzeFile,
	analyzeHtmx,
	classify,
	type HtmxCategory,
} from "./htmx-analyze";
import type { FsAdapter } from "../post-cleanup/types";

/**
 * In-memory FsAdapter mirroring the post-cleanup tests' helper. Kept
 * local to this test file to avoid coupling — the analyzer's adapter
 * surface is a strict subset of the audit's.
 */
function makeFs(files: Record<string, string>): FsAdapter {
	const norm = Object.fromEntries(
		Object.entries(files).map(([k, v]) => [k.replace(/\\/g, "/"), v]),
	);
	return {
		exists(absPath) {
			return absPath.replace(/\\/g, "/") in norm;
		},
		readText(absPath) {
			const k = absPath.replace(/\\/g, "/");
			if (!(k in norm)) throw new Error(`ENOENT: ${absPath}`);
			return norm[k];
		},
		glob(siteDir, pattern, excludeDirs = []) {
			const root = siteDir.replace(/\\/g, "/");
			const all = Object.keys(norm).filter((p) => p.startsWith(`${root}/`));
			const filtered = all.filter((p) => {
				const rel = p.slice(root.length + 1);
				return !excludeDirs.some((dir) => rel.startsWith(`${dir}/`));
			});
			const branches = pattern.includes("{")
				? pattern
						.match(/\{([^{}]+)\}/)![1]
						.split(",")
						.map((b) => pattern.replace(/\{[^{}]+\}/, b.trim()))
				: [pattern];
			const regexes = branches.map((p) => {
				const re = p
					.replace(/[.+^$()|]/g, "\\$&")
					.replace(/\*\*\//g, "<<DBL>>")
					.replace(/\*\*/g, "<<DBL>>")
					.replace(/\*/g, "[^/]*")
					.replace(/<<DBL>>/g, "(?:.*/)?");
				return new RegExp(`^${re}$`);
			});
			return filtered
				.filter((p) => {
					const rel = p.slice(root.length + 1);
					return regexes.some((re) => re.test(rel));
				})
				.sort();
		},
	};
}

const SITE = "/site";

/* ------------------------------------------------------------------ */
/* classify() — pure unit tests                                        */
/* ------------------------------------------------------------------ */

describe("classify (pure)", () => {
	it("classifies hx-boost as boost regardless of other attrs", () => {
		expect(classify("a", ["hx-boost", "hx-target"])).toBe("boost");
	});

	it("classifies hx-swap-oob / hx-select-oob as oob-swap", () => {
		expect(classify("div", ["hx-swap-oob"])).toBe("oob-swap");
		expect(classify("div", ["hx-select-oob"])).toBe("oob-swap");
	});

	it("classifies a form with hx-post + hx-target + hx-swap as form-swap", () => {
		expect(classify("form", ["hx-post", "hx-swap", "hx-target"])).toBe(
			"form-swap",
		);
	});

	it("classifies a button with hx-get + hx-target as click-swap", () => {
		expect(classify("button", ["hx-get", "hx-target", "hx-swap"])).toBe(
			"click-swap",
		);
	});

	it("classifies an input with hx-post + hx-trigger as auto-fetch", () => {
		expect(
			classify("input", ["hx-post", "hx-target", "hx-trigger", "hx-swap"]),
		).toBe("auto-fetch");
	});

	it("classifies a button with only hx-on:click as event-handler", () => {
		expect(classify("button", ["hx-on:click"])).toBe("event-handler");
	});

	it("classifies hx-on-click (dash variant, htmx 2.x) as event-handler", () => {
		// HTML spec doesn't allow `:` in attribute names; htmx 2.x
		// canonicalised the dash form. We must recognise both.
		expect(classify("button", ["hx-on-click"])).toBe("event-handler");
		expect(classify("Accordion.Trigger", ["hx-on-click"])).toBe(
			"event-handler",
		);
		// htmx-specific bare events e.g. `hx-on-htmx-config-request` —
		// when paired with a fetch they fold into click-swap (fetch
		// wins); standalone they are still event-handler shape.
		expect(classify("div", ["hx-on-htmx-after-request"])).toBe(
			"event-handler",
		);
	});

	it("classifies a div with only hx-trigger and no fetch attr as unmatched", () => {
		// hx-trigger alone is meaningless; flag for manual review.
		expect(classify("div", ["hx-trigger"])).toBe("unmatched");
	});

	it("treats hx-on with a fetch attr as click-swap (the fetch wins)", () => {
		// Real example from als (EmailAndPassword button): hx-get +
		// hx-target + hx-trigger=click — engineer often piles
		// hx-on alongside, but the dominant migration path is the
		// click-swap recipe.
		expect(
			classify("button", ["hx-get", "hx-on:click", "hx-target", "hx-trigger"]),
		).toBe("click-swap");
	});
});

/* ------------------------------------------------------------------ */
/* analyzeFile() — JSX walker tests using real als-shaped fixtures     */
/* ------------------------------------------------------------------ */

describe("analyzeFile (real shapes)", () => {
	it("detects hx-on:click={useScript(...)} click handler (als AddToBagButton shape)", () => {
		const file = `
import { useScript } from "@deco/deco/hooks";
export default function AddToBagButton() {
  return (
    <button
      hx-on:click={useScript(async (skuId, sellerId) => {
        if (!skuId || !sellerId) return;
        const button = this as HTMLButtonElement;
        button.dataset.loading = "true";
        await globalThis.window.STOREFRONT.CART.addToCart({ orderItems: [{ id: skuId, quantity: 1 }] });
      }, "sku", "1")}
      class="add-to-bag"
    >
      Add to bag
    </button>
  );
}
`;
		const out = analyzeFile("AddToBagButton.tsx", file);
		expect(out).toHaveLength(1);
		expect(out[0].category).toBe("event-handler");
		expect(out[0].tag).toBe("button");
		expect(out[0].attrs).toEqual(["hx-on:click"]);
	});

	it("detects hx-post + hx-target + hx-trigger=keyup on an input as auto-fetch (als SearchInput shape)", () => {
		const file = `
<input
  id={searchInputId}
  name="q"
  type="text"
  hx-sync="this:replace"
  hx-swap="innerHTML transition:true"
  hx-target={\`#\${searchResultsId}\`}
  hx-post={useComponent(Suggestions, { id })}
  hx-on:change={useScript(() => { /* analytics */ }, searchInputId)}
  hx-trigger="keyup changed delay:200ms"
  class="…"
/>
`;
		const out = analyzeFile("SearchInput.tsx", file);
		expect(out).toHaveLength(1);
		expect(out[0].category).toBe("auto-fetch");
		expect(out[0].tag).toBe("input");
		expect(out[0].attrs).toContain("hx-post");
		expect(out[0].attrs).toContain("hx-trigger");
		expect(out[0].attrs).toContain("hx-target");
	});

	it("detects hx-post + hx-target + hx-swap on a form as form-swap (als EmailAndPassword shape)", () => {
		const file = `
<form
  class="flex flex-col w-full"
  hx-target={\`#\${VIEW_CONTENT_ID}\`}
  hx-swap="innerHTML transition:true show:window:top"
  hx-trigger="submit"
  hx-post={useSection({ props: { viewConfig: { view: viewIds.EMAIL_AND_PASSWORD } } })}
  hx-indicator=".submit"
>
  <fieldset>…</fieldset>
</form>
`;
		const out = analyzeFile("EmailAndPassword.tsx", file);
		expect(out).toHaveLength(1);
		expect(out[0].category).toBe("form-swap");
		expect(out[0].tag).toBe("form");
		expect(out[0].attrs).toContain("hx-post");
		expect(out[0].attrs).toContain("hx-target");
	});

	it("detects hx-get on a button as click-swap (als ForgotPassword shape)", () => {
		const file = `
<button
  type="button"
  hx-target={\`#\${VIEW_CONTENT_ID}\`}
  hx-swap="innerHTML transition:true"
  hx-trigger="click"
  hx-get={useSection({ props: { viewConfig: { view: viewIds.RECEIVE_ACCESS_CODE_FOR_PASSWORD } } })}
  hx-indicator="this"
>
  Forgot password
</button>
`;
		const out = analyzeFile("ForgotPassword.tsx", file);
		expect(out).toHaveLength(1);
		expect(out[0].category).toBe("click-swap");
		expect(out[0].tag).toBe("button");
		expect(out[0].attrs).toContain("hx-get");
	});

	it("counts each element exactly once even when multiple hx-* attrs match", () => {
		// 4 hx-* attributes on the same form — should produce ONE
		// occurrence, not four.
		const file = `
<form hx-post="/x" hx-target="#a" hx-swap="innerHTML" hx-trigger="submit">
  <input />
</form>
`;
		const out = analyzeFile("F.tsx", file);
		expect(out).toHaveLength(1);
	});

	it("detects multiple distinct elements in the same file", () => {
		const file = `
<>
  <button hx-on:click={() => {}}>A</button>
  <form hx-post="/x" hx-target="#r" hx-swap="innerHTML">
    <input name="q" />
  </form>
  <a hx-boost="true" href="/p">P</a>
</>
`;
		const out = analyzeFile("Multi.tsx", file);
		expect(out).toHaveLength(3);
		const cats = out.map((o) => o.category).sort();
		expect(cats).toEqual(["boost", "event-handler", "form-swap"]);
	});

	it("does not miscount braces inside template literals or attribute expressions", () => {
		const file = `
<button
  hx-target={\`#\${id}\`}
  hx-get={useSection({ props: { x: { y: 1 } } })}
>
  go
</button>
`;
		const out = analyzeFile("Tricky.tsx", file);
		expect(out).toHaveLength(1);
		expect(out[0].category).toBe("click-swap");
	});

	it("returns an empty array when no hx-* attributes are present", () => {
		const file = `
<button onClick={() => {}}>plain react</button>
`;
		expect(analyzeFile("React.tsx", file)).toEqual([]);
	});

	it("captures the tag name of components, not just intrinsic tags", () => {
		const file = `
<MyComponent hx-on:click={() => {}}>x</MyComponent>
`;
		const out = analyzeFile("C.tsx", file);
		expect(out).toHaveLength(1);
		expect(out[0].tag).toBe("MyComponent");
	});

	it("reports a 1-indexed line number for the opening tag", () => {
		const file = "// header\n// line 2\n<button hx-on:click={() => {}}>x</button>\n";
		const out = analyzeFile("L.tsx", file);
		expect(out[0].line).toBe(3);
	});
});

/* ------------------------------------------------------------------ */
/* analyzeHtmx() — full inventory tests                                */
/* ------------------------------------------------------------------ */

describe("analyzeHtmx (inventory)", () => {
	it("aggregates counts across files and produces samples", () => {
		const fs = makeFs({
			"/site/components/A.tsx":
				'<button hx-on:click={() => {}}>a1</button>\n' +
				'<button hx-on:click={() => {}}>a2</button>\n',
			"/site/components/B.tsx":
				'<form hx-post="/x" hx-target="#r" hx-swap="innerHTML"><input/></form>\n',
			"/site/components/C.tsx":
				'<a hx-boost="true" href="/p">p</a>\n',
			"/site/Plain.ts": "export const x = 1;\n",
		});
		const inv = analyzeHtmx(SITE, fs);
		expect(inv.totalFiles).toBe(3);
		expect(inv.totalOccurrences).toBe(4);
		expect(inv.byCategory["event-handler"]).toBe(2);
		expect(inv.byCategory["form-swap"]).toBe(1);
		expect(inv.byCategory.boost).toBe(1);
		expect(inv.samples["event-handler"]).toHaveLength(2);
		expect(inv.samples["form-swap"]).toHaveLength(1);
		expect(inv.samples.boost).toHaveLength(1);
	});

	it("orders files by total descending so the biggest offenders come first", () => {
		const fs = makeFs({
			"/site/Small.tsx": '<button hx-on:click={() => {}}>x</button>\n',
			"/site/Big.tsx":
				'<button hx-on:click={() => {}}>1</button>\n' +
				'<button hx-on:click={() => {}}>2</button>\n' +
				'<button hx-on:click={() => {}}>3</button>\n',
			"/site/Mid.tsx":
				'<button hx-on:click={() => {}}>a</button>\n' +
				'<button hx-on:click={() => {}}>b</button>\n',
		});
		const inv = analyzeHtmx(SITE, fs);
		expect(inv.files.map((f) => f.file)).toEqual([
			"Big.tsx",
			"Mid.tsx",
			"Small.tsx",
		]);
	});

	it("caps samples per category at 3 even when there are many occurrences", () => {
		const lines = Array.from(
			{ length: 10 },
			(_, i) => `<button hx-on:click={() => {}}>x${i}</button>`,
		).join("\n");
		const fs = makeFs({ "/site/Many.tsx": lines });
		const inv = analyzeHtmx(SITE, fs);
		expect(inv.totalOccurrences).toBe(10);
		expect(inv.samples["event-handler"]).toHaveLength(3);
	});

	it("excludes documentation directories from analysis", () => {
		// `.cursor/` and `docs/` are common locations for htmx skill
		// references / tutorials. They should not pollute the count.
		const fs = makeFs({
			"/site/components/Real.tsx":
				'<button hx-on:click={() => {}}>x</button>\n',
			"/site/.cursor/skills/htmx/example.tsx":
				'<button hx-on:click={() => {}}>doc</button>\n',
			"/site/docs/example.md": "irrelevant",
		});
		const inv = analyzeHtmx(SITE, fs);
		expect(inv.totalOccurrences).toBe(1);
		expect(inv.files.map((f) => f.file)).toEqual(["components/Real.tsx"]);
	});

	it("returns zero counts on a clean repo", () => {
		const fs = makeFs({
			"/site/A.tsx": '<button onClick={() => {}}>x</button>\n',
		});
		const inv = analyzeHtmx(SITE, fs);
		expect(inv.totalOccurrences).toBe(0);
		expect(inv.totalFiles).toBe(0);
		const allCats = Object.values(inv.byCategory) as number[];
		expect(allCats.every((c) => c === 0)).toBe(true);
	});
});
