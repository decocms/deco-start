import * as fs from "node:fs";
import * as path from "node:path";
import type { MigrationContext } from "../types.ts";
import { log } from "../types.ts";

export interface ExtractedTheme {
  /** Raw CSS variable -> hex color map from DEFAULT_THEME */
  variables: Record<string, string>;
  /** Font family string (from Theme.tsx or default_theme) */
  fontFamily: string | null;
  /** DaisyUI semantic colors derived from the brand palette */
  daisyUiColors: Record<string, string>;
}

const DAISYUI_MAPPING: Record<string, string[]> = {
  "--color-primary": ["--brand-primary-1"],
  "--color-secondary": ["--brand-secondary-1"],
  "--color-accent": ["--brand-terciary-1", "--brand-terciary-base"],
  "--color-neutral": ["--neutral-900", "--neutral-1"],
  "--color-base-100": ["--neutral-0", "--neutral-50"],
  "--color-base-200": ["--brand-secondary-50", "--neutral-100"],
  "--color-base-300": ["--brand-secondary-500", "--neutral-500"],
  "--color-info": ["--information"],
  "--color-success": ["--success"],
  "--color-warning": ["--warning"],
  "--color-error": ["--error"],
};

function extractDefaultTheme(sourceDir: string): Record<string, string> | null {
  const candidates = [
    "styles/default_theme.ts",
    "styles/defaultTheme.ts",
    "sdk/default_theme.ts",
  ];

  for (const candidate of candidates) {
    const filePath = path.join(sourceDir, candidate);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, "utf-8");

    const vars: Record<string, string> = {};
    const entryRe = /["'](--.+?)["']\s*:\s*["'](.+?)["']/g;
    let match: RegExpExecArray | null;
    while ((match = entryRe.exec(content)) !== null) {
      vars[match[1]] = match[2];
    }

    if (Object.keys(vars).length > 0) return vars;
  }

  return null;
}

function extractFontFamily(sourceDir: string): string | null {
  const candidates = [
    "sections/Theme/Theme.tsx",
    "sections/theme/Theme.tsx",
  ];

  for (const candidate of candidates) {
    const filePath = path.join(sourceDir, candidate);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, "utf-8");

    const fontMatch = content.match(
      /["']--font-family["']\s*,\s*\n?\s*["'](.*?)["']/,
    );
    if (fontMatch) {
      return fontMatch[1].split(",")[0].trim();
    }

    const fontMatch2 = content.match(
      /font.*?["']([\w\s]+(?:,\s*[\w\s-]+)*)/i,
    );
    if (fontMatch2) {
      const family = fontMatch2[1].split(",")[0].trim();
      if (family && family !== "sans-serif") return family;
    }
  }

  return null;
}

function deriveDaisyUiColors(vars: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [daisyKey, sourceKeys] of Object.entries(DAISYUI_MAPPING)) {
    for (const sourceKey of sourceKeys) {
      if (vars[sourceKey]) {
        result[daisyKey] = vars[sourceKey];
        break;
      }
    }
  }

  return result;
}

export function extractTheme(ctx: MigrationContext): ExtractedTheme {
  const vars = extractDefaultTheme(ctx.sourceDir);

  if (!vars) {
    log(ctx, "No styles/default_theme.ts found — using placeholder theme");
    return {
      variables: {},
      fontFamily: ctx.fontFamily,
      daisyUiColors: {},
    };
  }

  const fontFamily = extractFontFamily(ctx.sourceDir) || ctx.fontFamily;
  const daisyUiColors = deriveDaisyUiColors(vars);

  log(
    ctx,
    `Theme extracted: ${Object.keys(vars).length} variables, ${Object.keys(daisyUiColors).length} DaisyUI colors, font: ${fontFamily || "none"}`,
  );

  return { variables: vars, fontFamily, daisyUiColors };
}
