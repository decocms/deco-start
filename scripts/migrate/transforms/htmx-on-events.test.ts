import { describe, expect, it } from "vitest";
import {
  _internals,
  transformHtmxOnEvents,
} from "./htmx-on-events";

const { STANDARD_EVENT_MAP, TODO_MARKER } = _internals;

describe("transformHtmxOnEvents — basic renames", () => {
  it("renames hx-on:click → onClick (colon variant)", () => {
    const src = `<button hx-on:click={() => alert("hi")}>click</button>`;
    const r = transformHtmxOnEvents(src);
    expect(r.changed).toBe(true);
    expect(r.content).toBe(
      `<button onClick={() => alert("hi")}>click</button>`,
    );
    expect(r.notes[0]).toContain("Renamed 1 hx-on:* attribute(s)");
    expect(r.notes[0]).toContain("onClick=1");
  });

  it("renames hx-on-click → onClick (dash variant)", () => {
    const src = `<button hx-on-click={fn}>click</button>`;
    const r = transformHtmxOnEvents(src);
    expect(r.changed).toBe(true);
    expect(r.content).toBe(`<button onClick={fn}>click</button>`);
  });

  it("preserves whitespace around `=`", () => {
    const src = `<button hx-on:click = {fn}>x</button>`;
    const r = transformHtmxOnEvents(src);
    expect(r.content).toBe(`<button onClick = {fn}>x</button>`);
  });

  it("renames every standard event in the map", () => {
    for (const [htmxEvent, reactName] of Object.entries(STANDARD_EVENT_MAP)) {
      const src = `<x hx-on:${htmxEvent}={fn}/>`;
      const r = transformHtmxOnEvents(src);
      expect(r.content, `event=${htmxEvent}`).toBe(`<x ${reactName}={fn}/>`);
    }
  });

  it("renames every standard event in the map (dash variant)", () => {
    for (const [htmxEvent, reactName] of Object.entries(STANDARD_EVENT_MAP)) {
      const src = `<x hx-on-${htmxEvent}={fn}/>`;
      const r = transformHtmxOnEvents(src);
      expect(r.content, `event=${htmxEvent}`).toBe(`<x ${reactName}={fn}/>`);
    }
  });

  it("handles multiple events on the same element", () => {
    const src = `<input hx-on:change={a} hx-on:keyup={b} hx-on:focus={c}/>`;
    const r = transformHtmxOnEvents(src);
    expect(r.content).toBe(
      `<input onChange={a} onKeyUp={b} onFocus={c}/>`,
    );
    expect(r.notes[0]).toContain("Renamed 3 hx-on:* attribute(s)");
  });

  it("handles multi-line attribute values", () => {
    const src = `<button
  hx-on:click={() => {
    setLoading(true);
    doStuff();
  }}>
  Submit
</button>`;
    const r = transformHtmxOnEvents(src);
    expect(r.content).toContain("onClick={() => {");
    expect(r.content).toContain("setLoading(true);");
    expect(r.content).not.toContain("hx-on");
  });

  it("handles string-valued events (rare but legal htmx)", () => {
    const src = `<button hx-on:click="alert('hi')">x</button>`;
    const r = transformHtmxOnEvents(src);
    expect(r.content).toBe(`<button onClick="alert('hi')">x</button>`);
  });
});

describe("transformHtmxOnEvents — what stays untouched", () => {
  it("leaves htmx lifecycle events alone (htmx-config-request, htmx-before-request, ...)", () => {
    const src = `<form hx-post="/x"
      hx-on:htmx-before-request={a}
      hx-on:htmx-config-request={b}
      hx-on-htmx-after-swap={c}
    />`;
    const r = transformHtmxOnEvents(src);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(src);
  });

  it("renames standard events but preserves htmx lifecycle on the same element", () => {
    const src = `<form hx-post="/x" hx-on:submit={validate} hx-on:htmx-before-request={addCsrf}>...</form>`;
    const r = transformHtmxOnEvents(src);
    expect(r.changed).toBe(true);
    expect(r.content).toBe(
      `<form hx-post="/x" onSubmit={validate} hx-on:htmx-before-request={addCsrf}>...</form>`,
    );
  });

  it("leaves unknown/custom events alone (no React synthetic equivalent)", () => {
    const src = `<x hx-on:my-custom-event={fn} hx-on-other-thing={fn2}/>`;
    const r = transformHtmxOnEvents(src);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(src);
  });

  it("leaves non-event hx-* attributes alone (hx-post, hx-target, hx-swap, ...)", () => {
    const src = `<form hx-post="/x" hx-target="#r" hx-swap="innerHTML" hx-trigger="submit"/>`;
    const r = transformHtmxOnEvents(src);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(src);
  });

  it("leaves already-React onClick alone", () => {
    const src = `<button onClick={fn}>x</button>`;
    const r = transformHtmxOnEvents(src);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(src);
  });

  it("does not match attribute names that merely contain 'hx-on' as a substring", () => {
    const src = `<x data-hx-onfoo={fn} aria-hx-on="x"/>`;
    const r = transformHtmxOnEvents(src);
    expect(r.changed).toBe(false);
  });

  it("returns unchanged on files with no hx-on at all (fast path)", () => {
    const src = `<button onClick={fn}>x</button>\n<form hx-post="/x"/>`;
    const r = transformHtmxOnEvents(src);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(src);
    expect(r.notes).toEqual([]);
  });
});

describe("transformHtmxOnEvents — Fresh-isms TODO injection", () => {
  it("injects a top-of-file MIGRATION TODO when handler references useScript()", () => {
    const src = `import { useScript } from "site/sdk/useScript.ts";

export default function X() {
  return <button hx-on:click={useScript(handler)}>x</button>;
}
`;
    const r = transformHtmxOnEvents(src);
    expect(r.changed).toBe(true);
    expect(r.content.startsWith(TODO_MARKER)).toBe(true);
    expect(r.content).toContain("onClick={useScript(handler)}");
    expect(r.notes.some((n) => n.includes("Injected MIGRATION TODO"))).toBe(true);
  });

  it("injects a top-of-file MIGRATION TODO when handler references globalThis.window.STOREFRONT", () => {
    const src = `<button hx-on:click={() => { globalThis.window.STOREFRONT.CART.addToCart({}); }}>buy</button>`;
    const r = transformHtmxOnEvents(src);
    expect(r.content.startsWith(TODO_MARKER)).toBe(true);
  });

  it("injects a top-of-file MIGRATION TODO when handler references STOREFRONT.* (shorthand)", () => {
    const src = `import { STOREFRONT } from "site/sdk";\n<button hx-on:click={() => STOREFRONT.CART.addToCart()}>x</button>`;
    const r = transformHtmxOnEvents(src);
    expect(r.content.startsWith(TODO_MARKER)).toBe(true);
  });

  it("does NOT inject a TODO when no Fresh-isms are detected", () => {
    const src = `<button hx-on:click={() => setOpen(true)}>x</button>`;
    const r = transformHtmxOnEvents(src);
    expect(r.changed).toBe(true);
    expect(r.content.startsWith(TODO_MARKER)).toBe(false);
    expect(r.content).toBe(`<button onClick={() => setOpen(true)}>x</button>`);
    expect(r.notes.some((n) => n.includes("Injected MIGRATION TODO"))).toBe(false);
  });

  it("preserves a leading shebang and inserts the TODO after it", () => {
    const src = `#!/usr/bin/env node\n<button hx-on:click={useScript(fn)}>x</button>\n`;
    const r = transformHtmxOnEvents(src);
    expect(r.content.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(r.content.split("\n")[1]).toBe(TODO_MARKER);
  });

  it("does not inject the TODO twice when the codemod is rerun (idempotent)", () => {
    const src = `<button hx-on:click={useScript(fn)}>x</button>`;
    const first = transformHtmxOnEvents(src);
    const second = transformHtmxOnEvents(first.content);
    expect(second.changed).toBe(false);
    const occurrences = first.content.split(TODO_MARKER).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("transformHtmxOnEvents — idempotency + edge cases", () => {
  it("is idempotent on a clean rewritten file (rerunning is a no-op)", () => {
    const src = `<button onClick={fn}>x</button>`;
    const first = transformHtmxOnEvents(src);
    const second = transformHtmxOnEvents(first.content);
    expect(first.changed).toBe(false);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(src);
  });

  it("is idempotent on a file that just got rewritten (rerun produces same output)", () => {
    const src = `<button hx-on:click={fn}>x</button>`;
    const first = transformHtmxOnEvents(src);
    const second = transformHtmxOnEvents(first.content);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it("handles JSX components (capitalized tag names) just like lowercase intrinsics", () => {
    const src = `<Accordion.Trigger hx-on-click={toggle}>open</Accordion.Trigger>`;
    const r = transformHtmxOnEvents(src);
    expect(r.content).toBe(
      `<Accordion.Trigger onClick={toggle}>open</Accordion.Trigger>`,
    );
  });

  it("renames within a long file containing many tags", () => {
    const src = Array.from({ length: 20 })
      .map((_, i) => `<button key={${i}} hx-on:click={() => setCount(${i})}>${i}</button>`)
      .join("\n");
    const r = transformHtmxOnEvents(src);
    expect(r.notes[0]).toContain("Renamed 20 hx-on:* attribute(s)");
    expect(r.content.split("onClick=").length - 1).toBe(20);
    expect(r.content.includes("hx-on")).toBe(false);
  });
});

describe("transformHtmxOnEvents — als-shaped fixtures", () => {
  it("AddToBagButton: hx-on-click + Fresh useScript → onClick + TODO", () => {
    const src = `import { useScript } from "site/sdk/useScript.ts";

interface Props { productId: string; }

export default function AddToBagButton({ productId }: Props) {
  const handler = (id: string) => {
    globalThis.window.STOREFRONT.CART.addToCart({ id });
  };
  return (
    <button
      class="btn"
      hx-on-click={useScript(handler, productId)}
    >
      Add to bag
    </button>
  );
}
`;
    const r = transformHtmxOnEvents(src);
    expect(r.changed).toBe(true);
    expect(r.content).toContain("onClick={useScript(handler, productId)}");
    expect(r.content.startsWith(TODO_MARKER)).toBe(true);
    const codeBody = r.content.split("§ Pattern 1 (event-handler).\n")[1];
    expect(codeBody).not.toMatch(/\bhx-on\b/);
  });

  it("SearchInput: keeps hx-post/hx-target/etc, renames hx-on:change", () => {
    const src = `<input
  type="search"
  hx-post={searchUrl}
  hx-target="#suggestions"
  hx-swap="innerHTML"
  hx-trigger="keyup changed delay:300ms"
  hx-sync="closest form:abort"
  hx-on:change={(e) => { e.preventDefault(); }}
/>`;
    const r = transformHtmxOnEvents(src);
    expect(r.changed).toBe(true);
    expect(r.content).toContain(`onChange={(e) => { e.preventDefault(); }}`);
    expect(r.content).toContain("hx-post={searchUrl}");
    expect(r.content).toContain('hx-target="#suggestions"');
    expect(r.content).toContain('hx-swap="innerHTML"');
    expect(r.content).toContain('hx-sync="closest form:abort"');
  });

  it("RecoveryPassword: form with mixed standard + htmx lifecycle hooks", () => {
    const src = `<form
  hx-post={url}
  hx-target="#form"
  hx-swap="outerHTML"
  hx-trigger="submit"
  hx-disabled-elt="find button"
  hx-indicator="#loader"
  hx-select="#form"
  hx-on:submit={(e) => { /* validate */ }}
  hx-on-htmx-before-request={(e) => addCsrf(e)}
>
  …
</form>`;
    const r = transformHtmxOnEvents(src);
    expect(r.changed).toBe(true);
    expect(r.content).toContain(`onSubmit={(e) => { /* validate */ }}`);
    expect(r.content).toContain("hx-on-htmx-before-request={(e) => addCsrf(e)}");
    expect(r.content).toContain("hx-post={url}");
    expect(r.content).toContain('hx-trigger="submit"');
  });

  it("Footer.tsx-style: simple onClick with no Fresh-ism — no TODO", () => {
    const src = `<button hx-on:click={() => setOpen((p) => !p)}>menu</button>`;
    const r = transformHtmxOnEvents(src);
    expect(r.changed).toBe(true);
    expect(r.content.startsWith(TODO_MARKER)).toBe(false);
    expect(r.content).toBe(
      `<button onClick={() => setOpen((p) => !p)}>menu</button>`,
    );
  });
});
