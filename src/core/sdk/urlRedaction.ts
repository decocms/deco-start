/**
 * URL redaction for observability surfaces.
 *
 * Strips secrets from outbound URLs before they land on a log line or a
 * span attribute. The redacted output preserves enough of the URL for
 * operators to recognize the call (host, path, which query keys were
 * present) without leaking values that may carry tokens, session IDs,
 * personal data, or other regulated content.
 *
 * Why a separate helper (instead of doing it in the ingestor):
 *
 *  - Spans land in CF Workers Tracing before they ever reach our
 *    ingestor; once the unredacted value is stamped on `http.url`, it's
 *    in the CF dashboard whether we like it or not.
 *  - Logs go through `console.log` which Cloudflare captures into
 *    Workers Logs immediately — same problem.
 *  - The ingestor's `redactSensitiveHeaders` only covers headers, not
 *    URLs. Redacting URLs at the emit site is the only way to avoid
 *    landing a token on a platform we don't control.
 *
 * Redaction rules:
 *
 *  - Strip userinfo (`https://user:pass@host`) entirely.
 *  - Drop the fragment (`#...`) — fragments are client-side only and
 *    may carry SPA state that includes tokens.
 *  - Replace every query value with `"REDACTED"` unless its key is in
 *    `keepQueryKeys`. Empty values stay empty so dashboards can still
 *    distinguish `?foo=` from `?foo=secret`.
 *  - Preserve the host and path verbatim. Path normalization (e.g.
 *    collapsing `/p/[slug]`) lives in `observability.ts:normalizePath`
 *    on the metrics side and is intentionally NOT bundled here.
 *  - Unparseable inputs fall back to a defensive substring before the
 *    `?`, so a malformed URL never accidentally surfaces a query string.
 */

const REDACTED = "REDACTED";

export interface RedactUrlOptions {
  /**
   * Query parameter names whose value should be left intact. Useful for
   * structural / debugging params like `page`, `sort`, `view` that don't
   * carry secrets. Names are case-sensitive (matches `URLSearchParams`).
   *
   * By default this is empty — every value is redacted.
   */
  keepQueryKeys?: ReadonlyArray<string>;
}

export function redactUrl(input: string, options: RedactUrlOptions = {}): string {
  const keep = options.keepQueryKeys ? new Set(options.keepQueryKeys) : null;

  try {
    const u = new URL(input);
    // userinfo — never preserve.
    u.username = "";
    u.password = "";
    // fragment — drop. Browsers don't send it, but it can sneak into
    // server-side URLs via misconfigured proxies.
    u.hash = "";

    // searchParams.set() mutates URLSearchParams in place. Iterating a
    // snapshot via [...entries()] is the supported way to avoid mutating
    // the iterator we're walking.
    const entries = [...u.searchParams.entries()];
    for (const [key, value] of entries) {
      if (keep && keep.has(key)) continue;
      // Preserve empty values (`?k=` stays `?k=`) so dashboards can still
      // distinguish empty from redacted-with-content.
      if (value.length === 0) continue;
      u.searchParams.set(key, REDACTED);
    }

    return u.toString();
  } catch {
    // Unparseable URL — defensively drop everything from the first `?`
    // OR `#` onwards. Either can carry a secret (`?token=…`,
    // `#access_token=…`); cutting at whichever appears first preserves
    // the most context while leaking nothing.
    const idx = input.search(/[?#]/);
    return idx >= 0 ? input.slice(0, idx) : input;
  }
}
