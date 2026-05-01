import type { TransformResult } from "../types";

/**
 * htmx → React event-name mapping for the seven `hx-on:*` / `hx-on-*`
 * patterns that have a 1:1 React equivalent.
 *
 * The codemod is intentionally narrow: only events present in this map
 * get renamed. Custom DOM events (`hx-on:my-thing`), htmx lifecycle
 * events (`hx-on:htmx-config-request`), and any event that requires a
 * React `addEventListener` in `useEffect` get left alone — the
 * `htmx-residue` audit rule catches them and points at the per-pattern
 * `htmx-rewrite.md` skill.
 *
 * Kept lowercase to mirror htmx's own naming and to keep the regex
 * simple. JSX attribute names ARE case-sensitive; htmx writers always
 * use lowercase.
 */
const STANDARD_EVENT_MAP: Record<string, string> = {
  click: "onClick",
  dblclick: "onDoubleClick",
  submit: "onSubmit",
  reset: "onReset",
  change: "onChange",
  input: "onInput",
  keyup: "onKeyUp",
  keydown: "onKeyDown",
  keypress: "onKeyPress",
  focus: "onFocus",
  blur: "onBlur",
  focusin: "onFocus",
  focusout: "onBlur",
  mouseover: "onMouseOver",
  mouseout: "onMouseOut",
  mouseenter: "onMouseEnter",
  mouseleave: "onMouseLeave",
  mousedown: "onMouseDown",
  mouseup: "onMouseUp",
  mousemove: "onMouseMove",
  contextmenu: "onContextMenu",
  load: "onLoad",
  scroll: "onScroll",
  paste: "onPaste",
  copy: "onCopy",
  cut: "onCut",
  dragstart: "onDragStart",
  drag: "onDrag",
  dragend: "onDragEnd",
  drop: "onDrop",
  dragenter: "onDragEnter",
  dragleave: "onDragLeave",
  dragover: "onDragOver",
  wheel: "onWheel",
  touchstart: "onTouchStart",
  touchend: "onTouchEnd",
  touchmove: "onTouchMove",
  touchcancel: "onTouchCancel",
};

/**
 * Marker comment we inject when a rename happened *and* the surviving
 * handler bodies reference Fresh-only globals (`useScript`,
 * `globalThis.window.STOREFRONT`, `STOREFRONT.*`). The comment is the
 * only file-level annotation the codemod emits — per-occurrence
 * comments would balloon the diff for a 88-rename file like
 * als-storefront's hot paths. It is detected by an idempotency check
 * so re-running the codemod does not double-inject.
 */
const TODO_MARKER = "// MIGRATION TODO (codemod: htmx-on-event-rename):";

const TODO_BLOCK = `${TODO_MARKER}
// hx-on:* attributes were auto-renamed to React event handlers, but
// the handler bodies were preserved verbatim. They may reference
// Fresh-only globals like \`globalThis.window.STOREFRONT\` or
// \`useScript(...)\`. Verify each handler matches a TanStack Start
// equivalent (state hook, platform hook, or server function) — see
// .agents/skills/deco-to-tanstack-migration/references/htmx-rewrite.md
// § Pattern 1 (event-handler).`;

/**
 * Matches a single `hx-on:eventname=` or `hx-on-eventname=` attribute
 * occurrence in the source.
 *
 * `\b` before `hx-on` keeps us from matching inside identifiers like
 * `withHx-on` (impossible in TS but defensive). The separator capture
 * group distinguishes colon vs dash so we can flip both syntactic
 * variants in one pass.
 *
 * The event name allows a-zA-Z0-9 and `-` so multi-segment htmx events
 * (`htmx-config-request`, `htmx-before-request`) are captured intact and
 * we can decide *after* the match whether to rename or skip.
 */
const HX_ON_ATTR_RE = /\bhx-on([:\-])([a-zA-Z][a-zA-Z0-9-]*)(\s*=)/g;

/**
 * Heuristic patterns for handler bodies that reference Fresh-specific
 * globals. Used only to gate TODO injection — false positives are
 * harmless (extra comment), false negatives are tolerable (audit will
 * still catch htmx residue elsewhere).
 */
const FRESH_BODY_PATTERNS: readonly RegExp[] = [
  /\buseScript\s*\(/,
  /\bglobalThis\.window\.STOREFRONT\b/,
  /\bSTOREFRONT\./,
];

/**
 * Rewrite `hx-on:click={...}` and `hx-on-click={...}` attributes to
 * the React equivalent (`onClick={...}`), preserving the handler value
 * verbatim. Renames only happen for events with a known React mapping.
 *
 * - htmx lifecycle events (`htmx-config-request`, `htmx-before-request`,
 *   `htmx-after-swap`, etc.) are left alone — they require manual
 *   rewrite per the htmx-rewrite skill, and the `htmx-residue` audit
 *   rule will catch them post-migration.
 * - Unknown custom events (e.g. `hx-on:my-custom-thing`) are left alone
 *   — React doesn't have synthetic equivalents for arbitrary custom
 *   events; the engineer must wire those via `addEventListener` in
 *   `useEffect`, which the codemod cannot generate safely.
 *
 * If any rename happens AND the file contains Fresh-only body
 * patterns, a single file-level TODO comment is injected at the top so
 * reviewers know the bodies still need attention. Idempotent — running
 * the codemod twice produces identical output.
 */
export function transformHtmxOnEvents(content: string): TransformResult {
  if (!content.includes("hx-on")) {
    return { content, changed: false, notes: [] };
  }

  const renamesByEvent = new Map<string, number>();
  let renamed = 0;

  const next = content.replace(
    HX_ON_ATTR_RE,
    (match, _sep: string, eventName: string, equals: string) => {
      const lower = eventName.toLowerCase();
      if (lower.startsWith("htmx-")) return match;

      const reactName = STANDARD_EVENT_MAP[lower];
      if (!reactName) return match;

      renamed += 1;
      renamesByEvent.set(reactName, (renamesByEvent.get(reactName) ?? 0) + 1);
      return `${reactName}${equals}`;
    },
  );

  if (renamed === 0) {
    return { content, changed: false, notes: [] };
  }

  const notes: string[] = [];
  const breakdown = [...renamesByEvent.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, n]) => `${name}=${n}`)
    .join(", ");
  notes.push(`Renamed ${renamed} hx-on:* attribute(s) → React events (${breakdown})`);

  const hasFreshIsms = FRESH_BODY_PATTERNS.some((re) => re.test(next));
  const hasMarker = next.includes(TODO_MARKER);

  if (!hasFreshIsms || hasMarker) {
    return { content: next, changed: true, notes };
  }

  const final = injectTopOfFileTodo(next);
  notes.push(
    "Injected MIGRATION TODO — handler body references Fresh-only globals (useScript / globalThis.window.STOREFRONT)",
  );
  return { content: final, changed: true, notes };
}

/**
 * Insert TODO_BLOCK as a top-of-file comment, *after* any leading
 * shebang line or block comment. Keeps directives like `"use client"`
 * intact (they live below the comment block, which is fine).
 */
function injectTopOfFileTodo(source: string): string {
  if (source.startsWith("#!")) {
    const newlineIdx = source.indexOf("\n");
    if (newlineIdx === -1) return `${source}\n${TODO_BLOCK}\n`;
    return `${source.slice(0, newlineIdx + 1)}${TODO_BLOCK}\n${source.slice(newlineIdx + 1)}`;
  }
  return `${TODO_BLOCK}\n${source}`;
}

/** Exported for direct unit tests. */
export const _internals = {
  STANDARD_EVENT_MAP,
  HX_ON_ATTR_RE,
  TODO_MARKER,
  FRESH_BODY_PATTERNS,
};
