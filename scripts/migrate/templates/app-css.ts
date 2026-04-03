import type { MigrationContext } from "../types.ts";
import type { ExtractedTheme } from "../analyzers/theme-extractor.ts";

export function generateAppCss(ctx: MigrationContext, theme?: ExtractedTheme): string {
  const sections: string[] = [];

  // ── DaisyUI theme plugin ──────────────────────────────────────────
  const daisyColors = theme?.daisyUiColors ?? {};
  const c = ctx.themeColors;

  const semanticColors: Record<string, string> = {
    "--color-primary": daisyColors["--color-primary"] || c["primary"] || "#B10200",
    "--color-secondary": daisyColors["--color-secondary"] || c["secondary"] || "#141414",
    "--color-accent": daisyColors["--color-accent"] || c["tertiary"] || "#FFF100",
    "--color-neutral": daisyColors["--color-neutral"] || c["neutral"] || "#393939",
    "--color-base-100": daisyColors["--color-base-100"] || c["base-100"] || "#FFFFFF",
    "--color-base-200": daisyColors["--color-base-200"] || c["base-200"] || "#F3F3F3",
    "--color-base-300": daisyColors["--color-base-300"] || c["base-300"] || "#868686",
    "--color-info": daisyColors["--color-info"] || c["info"] || "#006CA1",
    "--color-success": daisyColors["--color-success"] || c["success"] || "#007552",
    "--color-warning": daisyColors["--color-warning"] || c["warning"] || "#F8D13A",
    "--color-error": daisyColors["--color-error"] || c["error"] || "#CF040A",
  };

  const colorLines = Object.entries(semanticColors)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");

  sections.push(`@import "tailwindcss";
@plugin "daisyui";
@plugin "daisyui/theme" {
  name: "light";
  default: true;
  color-scheme: light;
${colorLines}
}`);

  // ── @theme block: Tailwind v3->v4 color migration ─────────────────
  const fontFamily = theme?.fontFamily || ctx.fontFamily;
  let fontLine = "";
  if (fontFamily) {
    const firstFont = fontFamily.split(",")[0].trim().replace(/['"]/g, "");
    fontLine = `\n  --font-sans: "${firstFont}", ui-sans-serif, system-ui, sans-serif;`;
  }

  let themeBlock = `/* Tailwind v4: reset default palette (old sites replaced it entirely via theme.colors)
   then re-add only the colors used by this site. */
@theme {
  --color-*: initial;

  --color-white: #fff;
  --color-black: #000;
  --color-transparent: transparent;
  --color-current: currentColor;
  --color-inherit: inherit;${fontLine}`;

  // Add extracted theme variables to @theme
  const vars = theme?.variables ?? {};
  if (Object.keys(vars).length > 0) {
    themeBlock += `\n`;
    const grouped: Record<string, Array<[string, string]>> = {};
    for (const [k, v] of Object.entries(vars)) {
      const prefix = k.replace(/^--/, "").split("-").slice(0, 2).join("-");
      if (!grouped[prefix]) grouped[prefix] = [];
      grouped[prefix].push([k, v]);
    }

    for (const [prefix, entries] of Object.entries(grouped)) {
      themeBlock += `\n  /* ${prefix} */`;
      for (const [k, v] of entries) {
        themeBlock += `\n  ${k}: ${v};`;
      }
    }
  }

  // Gray scale compat (Tailwind v3 had gray-50..gray-950 by default)
  themeBlock += `

  /* Gray scale (Tailwind v3 default, required for bg-gray-*, text-gray-*, etc.) */
  --color-gray-50: #f9fafb;
  --color-gray-100: #f3f4f6;
  --color-gray-200: #e5e7eb;
  --color-gray-300: #d1d5db;
  --color-gray-400: #9ca3af;
  --color-gray-500: #6b7280;
  --color-gray-600: #4b5563;
  --color-gray-700: #374151;
  --color-gray-800: #1f2937;
  --color-gray-900: #111827;
  --color-gray-950: #030712;
}`;
  sections.push(themeBlock);

  // ── DaisyUI v5 compat ─────────────────────────────────────────────
  sections.push(`/* DaisyUI v5: flatten depth/noise to match v4 look */
:root {
  --depth: 0;
  --noise: 0;
}`);

  // ── :root theme variables ─────────────────────────────────────────
  if (Object.keys(vars).length > 0) {
    let rootBlock = `:root {\n`;
    for (const [k, v] of Object.entries(vars)) {
      rootBlock += `  ${k}: ${v};\n`;
    }
    if (fontFamily) {
      const firstFont = fontFamily.split(",")[0].trim().replace(/['"]/g, "");
      rootBlock += `  --font-family: ${firstFont}, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif;\n`;
    }
    rootBlock += `}`;
    sections.push(rootBlock);
  }

  // ── DaisyUI v5 carousel overflow fix ──────────────────────────────
  sections.push(`/* DaisyUI v5 removed carousel overflow — re-add for horizontal scroll */
.carousel {
  -webkit-overflow-scrolling: touch;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  scroll-behavior: smooth;
}

.carousel > * {
  scroll-snap-align: start;
}

ul.carousel,
ol.carousel {
  list-style: none;
  padding: 0;
}`);

  // ── Container utility (v3 -> v4 migration) ────────────────────────
  sections.push(`/* Container: replaces Tailwind v3 container plugin config */
@utility container {
  margin-inline: auto;
  padding-inline: 1rem;
  width: 100%;

  @media (width >= 640px) { max-width: 640px; }
  @media (width >= 768px) { max-width: 768px; }
  @media (width >= 1024px) { max-width: 1024px; }
  @media (width >= 1280px) { max-width: 1280px; }
  @media (width >= 1536px) { max-width: 1536px; }
}`);

  // ── Deferred section visibility ───────────────────────────────────
  sections.push(`/* Deferred section visibility — reduces layout shift while loading */
section[data-deferred="true"] {
  content-visibility: auto;
  contain-intrinsic-size: auto 300px;
}

.deferred-section {
  content-visibility: auto;
  contain-intrinsic-size: auto 300px;
}`);

  // ── View transitions ──────────────────────────────────────────────
  sections.push(`@view-transition {
  navigation: auto;
}`);

  // ── Base layer resets ─────────────────────────────────────────────
  sections.push(`@layer base {
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  body {
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  img,
  picture,
  video,
  canvas,
  svg {
    display: block;
    max-width: 100%;
  }

  /* Drawer / modal scroll lock */
  body:has(dialog[open]),
  body:has(.drawer-toggle:checked) {
    overflow: hidden;
  }
}`);

  // ── Scrollbar utility ─────────────────────────────────────────────
  sections.push(`.scrollbar-none {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.scrollbar-none::-webkit-scrollbar {
  display: none;
}`);

  return sections.join("\n\n") + "\n";
}
