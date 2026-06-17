/**
 * CDN-safe cookie injection — mirrors deco/runtime/clientCookies.ts.
 *
 * When CDNs strip Set-Cookie from cached responses, mirror framework
 * cookies into an inline `<script>document.cookie=…</script>` so
 * matcher stickiness and deco_segment survive cache hits.
 */

import { DECO_MATCHER_PREFIX } from "../cms/matcherStickiness";

export const DECO_SEGMENT = "deco_segment";

const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const frameworkCookiePrefixes = (): readonly string[] => [
  DECO_MATCHER_PREFIX,
  DECO_SEGMENT,
];

const escapeForScript = (s: string): string =>
  s.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/**
 * Build an inline script that sets framework cookies via document.cookie.
 * Returns null when no framework Set-Cookie headers are present.
 */
export function buildClientCookieScript(headers: Headers): string | null {
  const setters: string[] = [];
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  const rawCookies = getSetCookie?.call(headers) ?? [];

  for (const raw of rawCookies) {
    const semi = raw.indexOf(";");
    const nameValue = semi >= 0 ? raw.slice(0, semi) : raw;
    const eq = nameValue.indexOf("=");
    if (eq < 0) continue;
    const name = nameValue.slice(0, eq);
    if (!frameworkCookiePrefixes().some((p) => name.startsWith(p))) continue;
    const cookie =
      `${nameValue}; path=/; max-age=${MAX_AGE_SECONDS}; samesite=Lax`;
    setters.push(`document.cookie=${escapeForScript(JSON.stringify(cookie))};`);
  }

  if (setters.length === 0) return null;
  return `<script>${setters.join("")}</script>`;
}

/**
 * Inject script into HTML at the first `<head>` (or `<body>`, or append).
 */
export function injectScriptIntoHtml(html: string, script: string): string {
  const idxHead = html.indexOf("<head");
  if (idxHead >= 0) {
    const close = html.indexOf(">", idxHead);
    if (close >= 0) {
      return html.slice(0, close + 1) + script + html.slice(close + 1);
    }
  }
  const idxBody = html.indexOf("<body");
  if (idxBody >= 0) {
    const close = html.indexOf(">", idxBody);
    if (close >= 0) {
      return html.slice(0, close + 1) + script + html.slice(close + 1);
    }
  }
  return html + script;
}

/** Remove framework Set-Cookies from headers after script capture. */
export function stripFrameworkSetCookies(headers: Headers): void {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  const all = getSetCookie?.call(headers) ?? [];
  const remaining = all.filter((raw) => {
    const eq = raw.indexOf("=");
    if (eq < 0) return true;
    const name = raw.slice(0, eq);
    return !frameworkCookiePrefixes().some((p) => name.startsWith(p));
  });
  headers.delete("Set-Cookie");
  for (const raw of remaining) {
    headers.append("Set-Cookie", raw);
  }
}
