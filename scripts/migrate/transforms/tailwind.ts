import type { TransformResult } from "../types.ts";

/**
 * Tailwind v3 → v4 class migration transform.
 *
 * Handles:
 * 1. Renamed/removed utility classes
 * 2. DaisyUI v4 → v5 class changes
 * 3. Responsive class ordering (base → sm → md → lg → xl → 2xl)
 * 4. Arbitrary values → native equivalents (px-[16px] → px-4)
 * 5. Deprecated patterns
 */

// ── Breakpoint order (mobile-first) ─────────────────────────────
const BREAKPOINT_ORDER = ["sm", "md", "lg", "xl", "2xl"] as const;
const BP_INDEX: Record<string, number> = {};
BREAKPOINT_ORDER.forEach((bp, i) => {
  BP_INDEX[bp] = i + 1; // base = 0
});

// ── Tailwind v3 → v4 class renames ──────────────────────────────
// These are direct 1:1 replacements
const CLASS_RENAMES: Record<string, string> = {
  // Flexbox/Grid
  "flex-grow-0": "grow-0",
  "flex-grow": "grow",
  "flex-shrink-0": "shrink-0",
  "flex-shrink": "shrink",

  // Overflow
  "overflow-ellipsis": "text-ellipsis",

  // Decoration
  "decoration-clone": "box-decoration-clone",
  "decoration-slice": "box-decoration-slice",

  // Transforms (v4 applies transforms automatically)
  "transform": "",  // remove — v4 applies automatically
  "transform-gpu": "",
  "transform-none": "transform-none", // this one stays

  // Blur/filter (v4 applies automatically)
  "filter": "",  // remove
  "backdrop-filter": "",  // remove

  // Ring width default
  "ring": "ring-3", // v4 changed default from 3px to 1px
};

// ── DaisyUI v4 → v5 class renames ──────────────────────────────
const DAISYUI_RENAMES: Record<string, string> = {
  // Button changes
  "btn-ghost": "btn-ghost",  // kept
  "btn-outline": "btn-outline",  // kept
  "btn-active": "btn-active",  // kept

  // Alert/Badge
  "badge-ghost": "badge-soft",
  "alert-info": "alert-info",
  "alert-success": "alert-success",
  "alert-warning": "alert-warning",
  "alert-error": "alert-error",

  // Card
  "card-compact": "card-sm",

  // Modal
  "modal-open": "modal-open",

  // Drawer
  "drawer-end": "drawer-end",

  // Menu
  "menu-horizontal": "menu-horizontal",

  // Toast position classes (daisy v5 uses different system)
  "toast-top": "toast-top",
  "toast-bottom": "toast-bottom",
  "toast-center": "toast-center",
  "toast-end": "toast-end",
  "toast-start": "toast-start",
  "toast-middle": "toast-middle",

  // Loading
  "loading-spinner": "loading-spinner",
  "loading-dots": "loading-dots",
  "loading-ring": "loading-ring",
  "loading-ball": "loading-ball",
  "loading-bars": "loading-bars",
  "loading-infinity": "loading-infinity",

  // Sizes (daisy v5 naming)
  "btn-xs": "btn-xs",
  "btn-sm": "btn-sm",
  "btn-md": "btn-md",
  "btn-lg": "btn-lg",
};

// ── Spacing scale: px → Tailwind unit ───────────────────────────
const PX_TO_SPACING: Record<number, string> = {};
for (let i = 0; i <= 96; i++) {
  PX_TO_SPACING[i * 4] = String(i);
}
PX_TO_SPACING[2] = "0.5";
PX_TO_SPACING[6] = "1.5";
PX_TO_SPACING[10] = "2.5";
PX_TO_SPACING[14] = "3.5";

// Text size: px → native class
const TEXT_SIZE_MAP: Record<string, string> = {
  "12": "xs",
  "14": "sm",
  "16": "base",
  "18": "lg",
  "20": "xl",
  "24": "2xl",
  "30": "3xl",
  "36": "4xl",
  "48": "5xl",
  "60": "6xl",
  "72": "7xl",
  "96": "8xl",
  "128": "9xl",
};

// Properties that accept spacing values
const SPACING_PROPS = new Set([
  "p", "px", "py", "pt", "pb", "pl", "pr",
  "m", "mx", "my", "mt", "mb", "ml", "mr",
  "gap", "gap-x", "gap-y", "space-x", "space-y",
  "w", "h", "min-w", "min-h", "max-w", "max-h",
  "top", "right", "bottom", "left", "inset", "inset-x", "inset-y",
  "rounded", "rounded-t", "rounded-b", "rounded-l", "rounded-r",
  "rounded-tl", "rounded-tr", "rounded-bl", "rounded-br",
  "border", "border-t", "border-b", "border-l", "border-r",
  "text",
]);

// ── CSS category resolution (avoid false positives) ─────────────
const TEXT_SIZE_VALUES = new Set([
  "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl",
  "7xl", "8xl", "9xl",
]);
const TEXT_ALIGN_VALUES = new Set([
  "left", "center", "right", "justify", "start", "end",
]);

function getCssCategory(prop: string, value: string): string {
  if (prop === "text" || prop === "-text") {
    if (TEXT_SIZE_VALUES.has(value) || /^\[\d/.test(value)) return "text-size";
    if (TEXT_ALIGN_VALUES.has(value)) return "text-align";
    return "text-color";
  }
  if (prop === "flex") {
    if (value === "") return "display";
    if (["1", "auto", "initial", "none"].includes(value)) return "flex-grow";
    if (["row", "col", "row-reverse", "col-reverse"].includes(value)) return "flex-direction";
    if (["wrap", "nowrap", "wrap-reverse"].includes(value)) return "flex-wrap";
    return "flex";
  }
  if (prop === "font") {
    if (["bold", "semibold", "medium", "normal", "light", "thin", "extrabold", "black", "extralight"].includes(value)) return "font-weight";
    return "font-family";
  }
  return prop;
}

// ── Parse class ─────────────────────────────────────────────────
interface ParsedClass {
  raw: string;
  modifiers: string[];
  bpIndex: number;
  property: string;
  value: string;
  cssCategory: string;
}

function parseClass(cls: string): ParsedClass {
  const parts = cls.split(":");
  const utility = parts.pop()!;
  const modifiers = parts;

  let bpIndex = 0;
  for (const mod of modifiers) {
    if (BP_INDEX[mod] !== undefined && BP_INDEX[mod] > bpIndex) {
      bpIndex = BP_INDEX[mod];
    }
  }

  const negMatch = utility.match(/^(-?)(.+)-(.+)$/);
  let property = utility;
  let value = "";
  if (negMatch) {
    property = negMatch[1] + negMatch[2];
    value = negMatch[3];
  }

  return { raw: cls, modifiers, bpIndex, property, value, cssCategory: getCssCategory(property, value) };
}

// ── Fix class renames ───────────────────────────────────────────
function fixRenames(cls: string): string {
  const parts = cls.split(":");
  const utility = parts.pop()!;

  // Check direct rename
  if (CLASS_RENAMES[utility] !== undefined) {
    const renamed = CLASS_RENAMES[utility];
    if (renamed === "") return ""; // Remove class entirely
    parts.push(renamed);
    return parts.join(":");
  }

  // Check DaisyUI rename
  if (DAISYUI_RENAMES[utility] && DAISYUI_RENAMES[utility] !== utility) {
    parts.push(DAISYUI_RENAMES[utility]);
    return parts.join(":");
  }

  return cls;
}

// ── Fix arbitrary values ────────────────────────────────────────
function fixArbitrary(cls: string): string {
  const parsed = parseClass(cls);
  const arbMatch = parsed.value.match(/^\[(-?\d+(?:\.\d+)?)(px|rem|%)?\]$/);
  if (!arbMatch) {
    // w-[100%] → w-full, h-[100%] → h-full
    if (parsed.value === "[100%]" && (parsed.property === "w" || parsed.property === "h")) {
      const prefix = parsed.modifiers.length ? parsed.modifiers.join(":") + ":" : "";
      return `${prefix}${parsed.property}-full`;
    }
    if (parsed.value === "[auto]" && (parsed.property === "w" || parsed.property === "h")) {
      const prefix = parsed.modifiers.length ? parsed.modifiers.join(":") + ":" : "";
      return `${prefix}${parsed.property}-auto`;
    }
    return cls;
  }

  const num = parseFloat(arbMatch[1]);
  const unit = arbMatch[2] || "px";
  const baseProp = parsed.property.replace(/^-/, "");
  const isNeg = parsed.property.startsWith("-");
  const prefix = parsed.modifiers.length ? parsed.modifiers.join(":") + ":" : "";
  const negPrefix = isNeg ? "-" : "";

  // text-[Npx] → text-{size}
  if (baseProp === "text" && unit === "px") {
    const native = TEXT_SIZE_MAP[String(num)];
    if (native) return `${prefix}text-${native}`;
    return cls;
  }

  // Spacing: px-[16px] → px-4
  if (SPACING_PROPS.has(baseProp)) {
    let pxValue: number | null = null;
    if (unit === "px") pxValue = num;
    else if (unit === "rem") pxValue = num * 16;

    if (pxValue !== null && PX_TO_SPACING[pxValue] !== undefined) {
      return `${prefix}${negPrefix}${baseProp}-${PX_TO_SPACING[pxValue]}`;
    }
  }

  return cls;
}

// ── Fix responsive ordering ─────────────────────────────────────
function fixResponsiveOrder(classes: string[]): string[] {
  const parsed = classes.map((cls, i) => ({ ...parseClass(cls), idx: i }));

  // Group by CSS category
  const groups: Record<string, typeof parsed> = {};
  for (const p of parsed) {
    if (!groups[p.cssCategory]) groups[p.cssCategory] = [];
    groups[p.cssCategory].push(p);
  }

  const result = [...classes];
  for (const group of Object.values(groups)) {
    if (group.length < 2) continue;
    const positions = group.map((g) => g.idx).sort((a, b) => a - b);
    const sorted = [...group].sort((a, b) => a.bpIndex - b.bpIndex);
    for (let i = 0; i < positions.length; i++) {
      result[positions[i]] = sorted[i].raw;
    }
  }

  return result;
}

// ── Check if ordering is wrong ──────────────────────────────────
function hasOrderIssues(classes: string[]): boolean {
  const parsed = classes.map((cls, i) => ({ ...parseClass(cls), idx: i }));
  const groups: Record<string, typeof parsed> = {};
  for (const p of parsed) {
    if (!groups[p.cssCategory]) groups[p.cssCategory] = [];
    groups[p.cssCategory].push(p);
  }

  for (const group of Object.values(groups)) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a.idx < b.idx && a.bpIndex > b.bpIndex) return true;
        if (b.idx < a.idx && b.bpIndex > a.bpIndex) return true;
      }
    }
  }
  return false;
}

// ── Fix a className string ──────────────────────────────────────
function fixClassNameString(classes: string): { fixed: string; changes: string[] } {
  const changes: string[] = [];
  let classList = classes.split(/\s+/).filter(Boolean);

  // 1. Apply renames
  classList = classList.map((cls) => {
    const renamed = fixRenames(cls);
    if (renamed !== cls) {
      if (renamed === "") {
        changes.push(`Removed deprecated: ${cls}`);
      } else {
        changes.push(`Renamed: ${cls} → ${renamed}`);
      }
    }
    return renamed;
  }).filter(Boolean); // Remove empty strings (deleted classes)

  // 2. Fix arbitrary values
  classList = classList.map((cls) => {
    if (!cls.includes("[")) return cls;
    const fixed = fixArbitrary(cls);
    if (fixed !== cls) {
      changes.push(`Arbitrary: ${cls} → ${fixed}`);
    }
    return fixed;
  });

  // 3. Fix responsive ordering
  if (hasOrderIssues(classList)) {
    const reordered = fixResponsiveOrder(classList);
    if (reordered.join(" ") !== classList.join(" ")) {
      changes.push("Reordered responsive classes (mobile-first)");
      classList = reordered;
    }
  }

  return { fixed: classList.join(" "), changes };
}

/**
 * Transform Tailwind classes in a file.
 *
 * Finds all className="..." and class="..." attributes and applies:
 * - v3→v4 class renames
 * - DaisyUI v4→v5 renames
 * - Arbitrary value → native equivalent
 * - Responsive class ordering fix
 */
export function transformTailwind(content: string): TransformResult {
  const notes: string[] = [];
  let changed = false;
  let result = content;

  // Match className="...", className={`...`}, class="..."
  const patterns = [
    /(?<=className\s*=\s*")([^"]+)(?=")/g,
    /(?<=className\s*=\s*{`)([^`]+)(?=`})/g,
    /(?<=className\s*=\s*{\s*")([^"]+)(?="\s*})/g,
    /(?<=class\s*=\s*")([^"]+)(?=")/g,
  ];

  for (const pattern of patterns) {
    result = result.replace(pattern, (match) => {
      // Handle multiline class strings
      if (match.includes("\n")) {
        const lines = match.split("\n");
        const fixedLines = lines.map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          const indent = line.match(/^(\s*)/)?.[1] ?? "";
          const { fixed, changes } = fixClassNameString(trimmed);
          if (changes.length > 0) {
            changed = true;
            notes.push(...changes);
          }
          return indent + fixed;
        });
        return fixedLines.join("\n");
      }

      const { fixed, changes } = fixClassNameString(match);
      if (changes.length > 0) {
        changed = true;
        notes.push(...changes);
      }
      return fixed;
    });
  }

  // Deduplicate notes
  const uniqueNotes = [...new Set(notes)];

  return { content: result, changed, notes: uniqueNotes };
}
