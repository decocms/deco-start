export function getCookie(name: string): string {
  return (
    globalThis.window?.document?.cookie?.split("; ").reduce((r, v) => {
      const parts = v.split("=");
      return parts[0] === name ? decodeURIComponent(parts[1]) : r;
    }, "") ?? ""
  );
}

export function setCookie(name: string, value: string, days: number) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  if (globalThis?.window?.document) {
    globalThis.window.document.cookie =
      name + "=" + encodeURIComponent(value) + "; expires=" + expires + "; path=/";
  }
}

export function deleteCookie(name: string) {
  if (globalThis?.window?.document) {
    globalThis.window.document.cookie = name + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  }
}

export function getServerSideCookie(req: Request, name: string): string {
  const cookie = req.headers
    .get("cookie")
    ?.split(";")
    .find((c) => c.trim().startsWith(name))
    ?.split("=")[1];
  return cookie ? decodeURIComponent(cookie) : "";
}

export function decodeCookie(cookieValue: string): any {
  try {
    return JSON.parse(decodeURIComponent(cookieValue));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Server-side cookie helpers — Web-platform / Workers-friendly.
//
// These mirror the surface area of Deno's `@std/http/cookie`, which deco
// storefronts depended on heavily before TanStack/Workers migration. Sites
// can now import from "@decocms/start/sdk/cookie" instead of shipping a
// per-site shim or pulling JSR.
// ---------------------------------------------------------------------------

export interface Cookie {
  name: string;
  value: string;
  expires?: Date | number;
  maxAge?: number;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/**
 * Parse all cookies from a Request's `Cookie` header into a plain object.
 * Returns `{}` when no cookies are present. Values are URL-decoded.
 *
 * Equivalent to `getCookies(req.headers)` from `@std/http/cookie`.
 */
export function getCookies(headers: Headers): Record<string, string> {
  const cookie = headers.get("cookie");
  if (!cookie) return {};
  const out: Record<string, string> = {};
  for (const pair of cookie.split(/;\s*/)) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (!name) continue;
    const value = pair.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Serialize a cookie spec and append a `Set-Cookie` header to a Response's
 * `Headers`. Equivalent to `setCookie(headers, cookie)` from `@std/http/cookie`.
 *
 * Note: this uses `headers.append`, not `set`, so multiple cookies stack
 * correctly (a single `Set-Cookie` header cannot represent multiple cookies).
 */
export function setResponseCookie(headers: Headers, cookie: Cookie): void {
  const parts = [`${cookie.name}=${cookie.value}`];
  if (cookie.expires !== undefined) {
    const date = cookie.expires instanceof Date
      ? cookie.expires
      : new Date(cookie.expires);
    parts.push(`Expires=${date.toUTCString()}`);
  }
  if (cookie.maxAge !== undefined) parts.push(`Max-Age=${cookie.maxAge}`);
  if (cookie.domain) parts.push(`Domain=${cookie.domain}`);
  if (cookie.path) parts.push(`Path=${cookie.path}`);
  if (cookie.secure) parts.push("Secure");
  if (cookie.httpOnly) parts.push("HttpOnly");
  if (cookie.sameSite) parts.push(`SameSite=${cookie.sameSite}`);
  headers.append("Set-Cookie", parts.join("; "));
}

/**
 * Append a delete instruction (`Max-Age=0` + epoch `Expires`) for a cookie.
 * `path` and `domain` should match the original `setResponseCookie` call to
 * actually clear the cookie in the browser.
 */
export function deleteResponseCookie(
  headers: Headers,
  name: string,
  attributes: { path?: string; domain?: string } = {},
): void {
  setResponseCookie(headers, {
    name,
    value: "",
    expires: new Date(0),
    maxAge: 0,
    path: attributes.path,
    domain: attributes.domain,
  });
}
