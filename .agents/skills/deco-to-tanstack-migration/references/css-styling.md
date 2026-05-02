# CSS / Tailwind v4 / DaisyUI Gotchas

> oklch triplets, logical properties, DaisyUI collapse, theme prefixes, sidebar.


## 15. DaisyUI v4 Theme in Preview Shell

DaisyUI v4 with Tailwind v4's `@plugin "daisyui/theme"` scopes all color variables to `[data-theme="light"]`. The admin preview HTML shell (`/live/previews/*`) must include this attribute, or colors will be wrong.

**Symptom**: Preview in admin shows default/missing colors while production looks correct.

**Fix**: Configure the preview shell in `setup.ts`:

```typescript
setRenderShell({
  css: appCss,
  fonts: [...],
  theme: "light",     // adds data-theme="light" to <html>
  bodyClass: "bg-base-100 text-base-content",
  lang: "pt-BR",
});
```

The production HTML has `<html lang="pt-BR" data-theme="light">` set by the TanStack root layout. The preview shell must replicate this.


## 17. SiteTheme is a Stub

`Theme.tsx` returns `null`. Colors come from CSS at build time, not CMS at runtime.


## 31. CSS Theme Class Prefixes Must Not Be Renamed

**Severity**: HIGH — breaks all theme colors

The original site uses `seasonal-*` CSS class prefixes for theme variables (e.g., `bg-seasonal-brand-terciary-1`, `text-seasonal-neutral-1`). During migration, do NOT rename these to `header-*`, `footer-*`, or any other prefix. The theme variables are defined centrally and all components reference the same `seasonal-*` namespace.

**Fix**: Only change what React strictly requires: `class` → `className`, `for` → `htmlFor`. Preserve all original CSS class names exactly.


## 37. DaisyUI v4 Collapse Broken with Tailwind v4

**Severity**: MEDIUM — filter sidebars, FAQ accordions, any collapsible section renders collapsed

DaisyUI v4's collapse component uses `grid-template-rows: auto 0fr` with `content-visibility: hidden` and expands via `:has(>input:checked)`. In combination with Tailwind v4, the expand chain breaks — content stays collapsed regardless of checkbox state.

**Symptom**: Filter sidebar shows as empty space. Collapse titles may render but content is permanently hidden. Custom CSS overrides on `.collapse` conflict with DaisyUI's generated styles.

**Fix**: Replace DaisyUI collapse with native `<details>/<summary>` HTML elements:

```typescript
// Before: DaisyUI collapse with hidden checkbox
<div className="collapse">
  <input type="checkbox" defaultChecked />
  <div className="collapse-title">Category</div>
  <div className="collapse-content">...filters...</div>
</div>

// After: Native HTML, works everywhere
<details open className="group">
  <summary className="cursor-pointer font-semibold">Category</summary>
  <div className="mt-2">...filters...</div>
</details>
```


## 40. Filter Sidebar Invisible Due to Background Color Match

**Severity**: LOW — cosmetic, but confusing during development

The aside element for search/category filters renders correctly in the DOM (proper width, height, content) but appears invisible because its background matches the page background (e.g., both `#E9E9E9`).

**Symptom**: Filters appear "non-existent" even though they're in the DOM. Filter links are accessible but invisible.

**Fix**: Add a contrasting background to the filter aside:

```typescript
<aside className="... bg-white rounded-lg p-4">
```


## 42. Tailwind v4 Logical vs Physical Property Cascade Conflict

**Severity**: CRITICAL — causes container width mismatches across the entire site

Tailwind v4 generates **logical CSS properties** (`padding-inline`, `margin-inline`) while Tailwind v3 generated **physical properties** (`padding-left`, `padding-right`). When an element has BOTH shorthand (`px-*`) and longhand (`pl-*`/`pr-*`) responsive classes, the cascade breaks silently.

**Symptom**: Containers are narrower or have asymmetric padding compared to production. The layout "looks off" at certain breakpoints but works at others.

**Root cause**: In Tailwind v3, `md:px-6` and `sm:pl-0` both target `padding-left` — same CSS property, media query specificity decides the winner. In Tailwind v4, `md:px-6` targets `padding-inline` (shorthand) while `sm:pl-0` targets `padding-inline-start` (longhand). These are different CSS properties. If `padding-inline-start` appears later in the compiled stylesheet, it overrides the shorthand's start value, creating asymmetric padding.

**Example**:
```html
<!-- This pattern exists in many Deco storefronts -->
<div class="pl-4 sm:pl-0 md:px-6 xl-b:px-0 max-w-[1280px] mx-auto">
```

In Tailwind v3: at `md` viewport, `px-6` sets `padding-left: 1.5rem` and `padding-right: 1.5rem`, cleanly overriding `sm:pl-0`.

In Tailwind v4: at `md` viewport, `px-6` sets `padding-inline: 1.5rem`, but `pl-0` (from `sm:`) may still override `padding-inline-start` depending on stylesheet order.

**Fix**: Replace mixed shorthand + longhand patterns with consistent longhand properties:

```
md:px-6 xl-b:px-0       →  md:pl-6 md:pr-6 xl-b:pl-0 xl-b:pr-0
px-4 lg:px-6 xl-b:px-0  →  pl-4 pr-4 lg:pl-6 lg:pr-6 xl-b:pl-0 xl-b:pr-0
```

**Detection**: Find all elements with mixed patterns:
```bash
grep -rn 'px-[0-9].*pl-\|pl-.*px-[0-9]\|px-[0-9].*pr-\|pr-.*px-[0-9]' src/ --include='*.tsx'
```

Only convert `px-*` on elements that ALSO have `pl-*` or `pr-*`. Don't blindly replace all `px-*` across the codebase — elements with only `px-*` (no mixed longhand) work fine.

Also check for the same issue with `mx-*` mixed with `ml-*`/`mr-*`, and `my-*` mixed with `mt-*`/`mb-*`.


## 43. CSS oklch() Color Variables Must Store Triplets, Not Hex

**Severity**: HIGH — all SVG icons render as black, brand colors break

Sites that use `oklch(var(--variable))` in SVG fill/stroke attributes (common in Deco storefronts with seasonal/theme color systems) require the CSS variables to store **oklch triplets** (`100% 0.00 0deg`), NOT hex values (`#FFF`). `oklch(#FFF)` is invalid CSS — the browser ignores it and falls back to black.

**Symptom**: Slider arrows, footer icons, search icons, filter icons — anything using `oklch(var(--...))` — renders as black circles/shapes instead of the brand colors.

**Root cause**: The original site's Theme section (via Deco CMS) outputs oklch triplets into CSS variables. During migration, if the CSS variables are manually set to hex values, every `oklch()` wrapper produces invalid CSS.

**Fix**: Convert all theme CSS variables from hex to oklch triplets:
```css
/* WRONG — invalid CSS when used as oklch(var(--bg-seasonal-2)) */
--bg-seasonal-2: #FFF;

/* CORRECT — oklch(100% 0.00 0deg) is valid */
--bg-seasonal-2: 100% 0.00 0deg;
```

**Dual-usage caveat**: Variables used BOTH inside `oklch()` wrappers AND directly in CSS properties need different handling:

```css
/* @theme entries for Tailwind utilities — need oklch() wrapper */
--color-bg-seasonal-1: oklch(var(--bg-seasonal-1));

/* Direct CSS usage — also needs oklch() wrapper */
background-color: oklch(var(--bg-seasonal-1));
```

The DaisyUI v4 pattern: `@theme` entries map `--color-X` to `var(--Y)`. Tailwind generates `background-color: var(--color-X)` which resolves to the raw triplet — invalid without the `oklch()` wrapper. Wrap all `@theme` entries that reference oklch-triplet variables.

**Python conversion helper**:
```python
from colorjs import Color
c = Color("#EE4F31")
l, c_val, h = c.convert("oklch").coords()
print(f"{l*100:.2f}% {c_val:.2f} {h:.0f}deg")  # 64.42% 0.20 33deg
```


## 48. Custom Color Palette + fontFamily Dropped on Migration

**Severity**: HIGH — entire pages render unstyled and Vite throws "unknown utility class" hot-overlay errors

The migrator's scaffold writes a minimal `app.css` with `@theme` containing only the gray scale + a couple of colors. Sites that defined custom palettes in `tailwind.config.ts` `theme.extend.colors` (e.g. an `als: { gray: {...}, blue: {...} }` namespace, or seasonal/brand maps) lose ALL of those tokens on migration. Same for `theme.extend.fontFamily`.

**Symptom**:
- Vite HMR overlay: `Cannot apply unknown utility class 'font-bebas-neue'` / `'bg-als-blue-500'`
- Or for CSS files using the v3 `theme()` helper: `Could not resolve value for theme function: theme(colors.als.gray.50)`
- Page DOM renders correctly but visually unstyled — no colors, default fonts.

**Detection** (run before booting dev for a fresh migration):
```bash
# Find all <prefix>-{custom-name}-* tailwind classes used in the codebase
grep -rEo '\b(bg|text|border|fill|stroke|ring|outline|divide|placeholder|caret|accent|shadow|from|to|via)-[a-z]+-[a-z-]+(-[0-9]+)?\b' src/ \
  | awk -F: '{print $2}' | sort -u

# Find theme() calls in CSS that need v4 vars
grep -rE 'theme\(colors\.|theme\(fontFamily\.' src/styles/
```

Cross-reference against the original `tailwind.config.ts` `theme.extend.colors` / `theme.extend.fontFamily` keys.

**Fix** — port the missing tokens into `@theme`:

```css
/* src/styles/app.css */
@theme {
  --color-*: initial;
  /* gray scale + std colors ... */

  /* Custom brand palette (ported from tailwind.config.ts) */
  --color-als-gray-50: #E4E4E4;
  --color-als-gray-100: #BBBBBB;
  /* ...etc */
  --color-als-blue-500: #1C4DA1;

  /* Custom fonts (ported from tailwind.config.ts) */
  --font-bebas-neue: "Bebas Neue", sans-serif;
  --font-bebas-neue-pro: "bebas-neue-pro", sans-serif;
  --font-suisse-intl: "SuisseIntl", sans-serif;
}
```

Tailwind v4 auto-generates `bg-als-blue-500`, `font-bebas-neue` etc. from these vars.

**For raw `theme()` calls in CSS files** — Tailwind v4's `theme()` resolver accepts the dot path but only for tokens registered under `@theme`. Easier and more idiomatic: rewrite as `var(--color-...)`:

```css
/* v3 → v4 */
background-color: theme(colors.als.gray.50);   /* old */
background-color: var(--color-als-gray-50);    /* new */
```


## 49. `@layer components` Custom Classes Can't Be `@apply`d in v4

**Severity**: MEDIUM — Vite overlay error `Cannot apply unknown utility class 'container-pdp'`

Tailwind v4 only allows `@apply` to reference *utility classes* (built-ins or those declared with `@utility`). Custom classes declared inside `@layer components { .my-class { ... } }` are not utilities and can't be `@apply`d from elsewhere.

**Symptom**:
```css
@layer components {
  .container-pdp { @apply max-w-[1920px] md:!ml-[83px]; }
}

/* Later: */
.product-details ~ .pdt-div { @apply container-pdp w-full; }
/* ❌ "Cannot apply unknown utility class 'container-pdp'" */
```

**Fix** — promote the helper to a `@utility` directive:
```css
@utility container-pdp {
  @apply max-w-[1920px] md:!ml-[83px] lg:!ml-[167px] ml-0;
}
```

Then `@apply container-pdp` works, and so do variants (`hover:container-pdp`).
