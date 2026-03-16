/**
 * Shared HTML shell builder for admin preview iframes and render endpoints.
 *
 * Both `workerEntry.ts` (preview shell) and `admin/render.ts` (section render)
 * need to produce an HTML document with the site's CSS, fonts, and theme.
 * This module provides a single implementation to keep them consistent.
 */

import { getRenderShellConfig } from "../admin/setup";

export interface HtmlShellOptions {
  /** Content to inject into <body>. */
  body?: string;
  /** Inline <script> content to inject in <head>. */
  script?: string;
}

/**
 * Build a complete HTML shell using the current render config
 * (set via `setRenderShell()` in the site's setup.ts).
 */
export function buildHtmlShell(options: HtmlShellOptions = {}): string {
  const { cssHref, fontHrefs, themeName, bodyClass, htmlLang } = getRenderShellConfig();

  const themeAttr = themeName ? ` data-theme="${themeName}"` : "";
  const langAttr = htmlLang ? ` lang="${htmlLang}"` : "";
  const bodyAttr = bodyClass ? ` class="${bodyClass}"` : "";

  const stylesheets = [
    ...fontHrefs.map((href) => `<link rel="stylesheet" href="${href}" />`),
    cssHref ? `<link rel="stylesheet" href="${cssHref}" />` : "",
  ]
    .filter(Boolean)
    .join("\n    ");

  const scriptTag = options.script ? `<script>${options.script}</script>` : "";

  const bodyContent = options.body ?? `<div id="preview-root" style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui;color:#666;">
        Loading preview...
    </div>`;

  return `<!DOCTYPE html>
<html${langAttr}${themeAttr}>
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Preview</title>
    ${stylesheets}
    ${scriptTag}
</head>
<body${bodyAttr}>
${bodyContent}
</body>
</html>`;
}
