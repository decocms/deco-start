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

// ── Fix opacity modifier classes within a class list ────────────
// Handles non-adjacent cases like: "bg-black/50 flex ... hover:bg-opacity-30"
// Finds the base color class and merges the opacity into it.
function fixOrphanedOpacity(classList: string[]): { result: string[]; changes: string[] } {
  const changes: string[] = [];
  const prefixes = ["bg", "text", "border", "ring", "divide", "placeholder"];

  // Find base color classes: bg-{color} or bg-{color}/{opacity}
  const colorClasses: Record<string, { color: string; prefix: string }> = {};
  for (const cls of classList) {
    for (const pfx of prefixes) {
      const match = cls.match(new RegExp(`^${pfx}-(\\w[\\w-]*?)(?:\\/(\\d+))?$`));
      if (match && match[1] !== "opacity") {
        colorClasses[pfx] = { color: match[1], prefix: pfx };
      }
    }
  }

  // Replace orphaned opacity classes with proper merged versions
  const result: string[] = [];
  for (const cls of classList) {
    const opMatch = cls.match(/^((?:hover:|focus:|active:)*)(\w+)-opacity-(\d+)$/);
    if (!opMatch) {
      result.push(cls);
      continue;
    }

    const modifier = opMatch[1]; // "hover:" or ""
    const prefix = opMatch[2]; // "bg", "text", etc.
    const opacity = opMatch[3]; // "20", "50", etc.

    const base = colorClasses[prefix];
    if (!base) {
      result.push(cls); // No base color found, keep as-is
      continue;
    }

    const opacityStr = opacity === "100" ? "" : `/${opacity}`;
    const replacement = `${modifier}${prefix}-${base.color}${opacityStr}`;
    result.push(replacement);
    changes.push(`Merged ${cls} → ${replacement}`);
  }

  return { result, changes };
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

  // 3. Fix orphaned opacity classes (non-adjacent to color class)
  const opacityFix = fixOrphanedOpacity(classList);
  if (opacityFix.changes.length > 0) {
    classList = opacityFix.result;
    changes.push(...opacityFix.changes);
  }

  // 4. Fix responsive ordering
  if (hasOrderIssues(classList)) {
    const reordered = fixResponsiveOrder(classList);
    if (reordered.join(" ") !== classList.join(" ")) {
      changes.push("Reordered responsive classes (mobile-first)");
      classList = reordered;
    }
  }

  return { fixed: classList.join(" "), changes };
}

// ── Fix negative z-index on background images ──────────────────
// In Tailwind v3, `-z-10` on an absolute image inside a relative parent worked
// to push the image behind the parent's content. In Tailwind v4 + React,
// stacking contexts from wrappers (section elements, animation, etc.) can trap
// the negative z-index, making the image invisible.
// Fix: replace `-z-{n}` with `z-0` on images. Since the image comes first in DOM,
// content siblings (which have z-index: auto) render on top naturally.
const NEG_Z_ON_IMAGE_REGEX = /\b-z-\d+\b/g;

function fixNegativeZIndex(content: string): { content: string; changed: boolean; notes: string[] } {
  const notes: string[] = [];
  let changed = false;
  let result = content;

  // Step 1: Replace -z-{n} with z-0 on img/Image elements + add inset-0
  result = result.replace(
    /<(?:img|Image)\b[\s\S]*?(?:\/>|>)/g,
    (tag) => {
      if (!/-z-\d+/.test(tag)) return tag;
      let fixed = tag.replace(/(?<=\s|"|`)-z-(\d+)\b/g, (m) => {
        changed = true;
        notes.push(`Background image: replaced ${m} with z-0`);
        return "z-0";
      });
      // Add inset-0 if not present (ensures absolute image covers parent)
      if (fixed.includes("absolute") && !fixed.includes("inset-0")) {
        fixed = fixed.replace(/\babsolute\b/, "absolute inset-0");
        notes.push("Added inset-0 to absolute background image");
      }
      return fixed;
    },
  );

  // Step 2: When parent div has backgroundColor inline style + child img with z-0,
  // extract backgroundColor into a separate overlay div and bump content to z-20.
  // Use a simple two-pass approach to avoid JSX nesting issues:
  //   a) Extract and remove backgroundColor from parent div
  //   b) Insert overlay div before the content div (after the image conditional block)
  if (changed && /style=\{\{[^}]*backgroundColor/.test(result)) {
    const bgMatch = result.match(/style=\{\{\s*backgroundColor:\s*"([^"]+)"\s*\}\}/);
    if (bgMatch) {
      const bgValue = bgMatch[1];

      // Remove the style attribute from the parent div
      result = result.replace(/\s*style=\{\{\s*backgroundColor:\s*"[^"]+"\s*\}\}/, "");

      // Insert overlay div. Find the closing of the image conditional block:
      // Pattern: )} followed by whitespace then <div
      // This handles {imageBg && (<Image ... />)}  <div content>
      let insertedOverlay = false;

      // Try pattern: )} then <div (conditional image)
      if (/\)\}\s*\n\s*<div/.test(result)) {
        result = result.replace(
          /(\)\})([\s\n]*)(<div\b)/,
          (m, closing, ws, divTag) => {
            if (insertedOverlay) return m;
            insertedOverlay = true;
            return `${closing}${ws}{/* Overlay */}\n      <div className="absolute inset-0 z-10" style={{ backgroundColor: "${bgValue}" }} />${ws}${divTag}`;
          },
        );
      }

      // Try pattern: /> then <div (direct image, no conditional)
      if (!insertedOverlay && /\/>\s*\n\s*<div/.test(result)) {
        result = result.replace(
          /(\/>\s*\n)([\s]*)(<div\b)/,
          (m, closing, ws, divTag) => {
            if (insertedOverlay) return m;
            insertedOverlay = true;
            return `${closing}${ws}{/* Overlay */}\n${ws}<div className="absolute inset-0 z-10" style={{ backgroundColor: "${bgValue}" }} />\n${ws}${divTag}`;
          },
        );
      }

      if (insertedOverlay) {
        // Bump the first content div after the overlay to z-20.
        // Find the overlay marker, then the next className= string after it.
        const overlayMarker = `style={{ backgroundColor: "${bgValue}" }} />`;
        const overlayIdx = result.indexOf(overlayMarker);
        if (overlayIdx !== -1) {
          const afterOverlay = result.substring(overlayIdx + overlayMarker.length);
          // Find first className= after overlay (handles both className="..." and className={clx("...")})
          const classMatch = afterOverlay.match(/className=(?:\{clx\(\s*)?[""`]([^""`]*)/);
          if (classMatch && classMatch[1] && !/z-\d+/.test(classMatch[1])) {
            const originalClass = classMatch[1];
            const fixedClass = `relative z-20 ${originalClass}`;
            // Replace only the first occurrence after the overlay
            const beforeOverlay = result.substring(0, overlayIdx + overlayMarker.length);
            const fixed = afterOverlay.replace(originalClass, fixedClass);
            result = beforeOverlay + fixed;
          }
        }
        notes.push(`Extracted backgroundColor overlay: ${bgValue}`);
      }
    }
  }

  // Step 3: For content divs that are siblings of z-0 images,
  // add `relative z-10` so content renders above the background image.
  // Uses a line-by-line approach to avoid regex issues with JSX nesting.
  if (changed) {
    const lines = result.split("\n");
    let foundZ0Image = false;
    let needsContentZIndex = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Detect start of an image element (may span multiple lines)
      if (/<(?:img|Image)\b/.test(line)) {
        foundZ0Image = true;
        if (/\bz-0\b/.test(line)) {
          needsContentZIndex = true;
        }
        continue;
      }
      // Detect z-0 on a subsequent line of the image element
      if (foundZ0Image && !needsContentZIndex && /\bz-0\b/.test(line)) {
        needsContentZIndex = true;
        continue;
      }
      // Detect end of multi-line image element (self-closing />)
      if (foundZ0Image && !needsContentZIndex && /\/>/.test(line)) {
        // Image closed without z-0, reset
        foundZ0Image = false;
        continue;
      }

      // When we hit the closing of an Image block, start looking for content div
      if (foundZ0Image && /\)\}/.test(line)) {
        // The conditional image block closed, content div should be next
        continue;
      }

      // Skip overlay divs we inserted
      if (/Overlay/.test(line)) continue;
      if (/absolute inset-0 z-10/.test(line)) continue;

      // Find the first content div after the image
      if (needsContentZIndex && /^\s*<div\b/.test(line)) {
        // Check if this div already has a z-index
        if (/z-\d+/.test(line)) {
          needsContentZIndex = false;
          foundZ0Image = false;
          continue;
        }
        // Also check the next few lines for z-index (multi-line className)
        let hasZ = false;
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
          if (/z-\d+/.test(lines[j])) { hasZ = true; break; }
          if (/>/.test(lines[j]) && j !== i) break;
        }
        if (hasZ) {
          needsContentZIndex = false;
          foundZ0Image = false;
          continue;
        }

        // Add relative z-10 to the className — may be on this line or a subsequent one
        let classLine = i;
        for (let k = i; k < Math.min(i + 4, lines.length); k++) {
          if (/className=/.test(lines[k])) {
            classLine = k;
            break;
          }
        }

        if (/className="/.test(lines[classLine])) {
          lines[classLine] = lines[classLine].replace(/className="/, 'className="relative z-10 ');
          notes.push("Added relative z-10 to content div sibling of background image");
        } else if (/className=\{clx\(/.test(lines[classLine])) {
          // clx( may have its first string on the same line or the next
          if (/className=\{clx\(\s*"/.test(lines[classLine])) {
            lines[classLine] = lines[classLine].replace(/className=\{clx\(\s*"/, 'className={clx("relative z-10 ');
          } else {
            // First string argument is on the next line
            for (let k = classLine + 1; k < Math.min(classLine + 3, lines.length); k++) {
              if (/^\s*"/.test(lines[k])) {
                lines[k] = lines[k].replace(/^(\s*)"/, '$1"relative z-10 ');
                break;
              }
            }
          }
          notes.push("Added relative z-10 to content div sibling of background image");
        } else if (/className=\{`/.test(lines[classLine])) {
          lines[classLine] = lines[classLine].replace(/className=\{`/, 'className={`relative z-10 ');
          notes.push("Added relative z-10 to content div sibling of background image");
        }

        needsContentZIndex = false;
        foundZ0Image = false;
      }
    }

    result = lines.join("\n");
  }

  // Step 4: Flag remaining -z-{n} on non-image elements for manual review
  const remainingNegZ = result.match(/(?<=\s|"|`)-z-\d+/g);
  if (remainingNegZ) {
    notes.push(`MANUAL: ${remainingNegZ.length} remaining negative z-index usage(s) — may need manual fix for stacking context issues`);
  }

  return { content: result, changed, notes };
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

  // ── Fix negative z-index on background images ──────────────────
  const zFix = fixNegativeZIndex(result);
  if (zFix.changed) {
    result = zFix.content;
    changed = true;
    notes.push(...zFix.notes);
  }

  // ── Fix opacity utility pattern (Tailwind v4 breaking change) ──
  // bg-black bg-opacity-20 → bg-black/20
  // border-white border-opacity-20 → border-white/20
  // text-gray-600 text-opacity-50 → text-gray-600/50
  //
  // The pattern is: {prefix}-{color} {prefix}-opacity-{N} → {prefix}-{color}/{N}
  // prefix can be: bg, text, border, ring, divide, placeholder
  if (/(?:bg|text|border|ring|divide|placeholder)-opacity-\d+/.test(result)) {
    // Match: bg-{color} bg-opacity-{N}
    result = result.replace(
      /\b(bg-[\w-]+?)\s+bg-opacity-(\d+)/g,
      "$1/$2",
    );
    // Match: text-{color} text-opacity-{N}
    result = result.replace(
      /\b(text-[\w-]+?)\s+text-opacity-(\d+)/g,
      "$1/$2",
    );
    // Match: border-{color} border-opacity-{N}
    result = result.replace(
      /\b(border-[\w-]+?)\s+border-opacity-(\d+)/g,
      "$1/$2",
    );
    // Match: ring-{color} ring-opacity-{N}
    result = result.replace(
      /\b(ring-[\w-]+?)\s+ring-opacity-(\d+)/g,
      "$1/$2",
    );
    // Match: divide-{color} divide-opacity-{N}
    result = result.replace(
      /\b(divide-[\w-]+?)\s+divide-opacity-(\d+)/g,
      "$1/$2",
    );
    // Match: placeholder-{color} placeholder-opacity-{N}
    result = result.replace(
      /\b(placeholder-[\w-]+?)\s+placeholder-opacity-(\d+)/g,
      "$1/$2",
    );
    // Handle hover:/focus:/active: prefixed opacity (e.g. hover:bg-opacity-100)
    result = result.replace(
      /\b((?:hover:|focus:|active:)(?:bg|text|border|ring)-[\w-]+?)\s+(?:hover:|focus:|active:)(?:bg|text|border|ring)-opacity-(\d+)/g,
      "$1/$2",
    );
    // Handle hover:bg-opacity-N when bg-{color}/{N} already exists
    // e.g. "bg-white/80 hover:bg-opacity-100" → "bg-white/80 hover:bg-white"
    // e.g. "bg-black/60 hover:bg-opacity-50" → "bg-black/60 hover:bg-black/50"
    result = result.replace(
      /\b(bg|text|border|ring)-([\w-]+?)\/(\d+)\s+((?:hover:|focus:|active:)+)\1-opacity-(\d+)/g,
      (_m, prefix, color, _baseOp, modifier, hoverOp) => {
        const opacityStr = hoverOp === "100" ? "" : `/${hoverOp}`;
        return `${prefix}-${color}/${_baseOp} ${modifier}${prefix}-${color}${opacityStr}`;
      },
    );

    // Handle standalone orphaned opacity classes that weren't caught
    if (/(?:bg|text|border|ring)-opacity-\d+/.test(result)) {
      notes.push("MANUAL: Some *-opacity-N classes remain — color class may not be adjacent");
    }
    changed = true;
    notes.push("Converted *-opacity-N to modifier syntax (e.g. bg-black/20)");
  }

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
