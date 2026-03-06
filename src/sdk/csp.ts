/**
 * Content Security Policy header utilities.
 *
 * Sets frame-ancestors to allow the Deco admin to embed the
 * storefront in an iframe for live preview.
 */

const DEFAULT_ADMIN_ORIGINS = [
  "https://admin.deco.cx",
  "https://deco.cx",
  "https://localhost:*",
];

export interface CSPOptions {
  /** Additional origins allowed to frame the storefront. */
  extraOrigins?: string[];
  /**
   * Deco admin origins. Defaults to admin.deco.cx + localhost.
   * Set to empty array to disallow all external framing.
   */
  adminOrigins?: string[];
}

/**
 * Set Content-Security-Policy frame-ancestors header on a Response.
 *
 * This is required for the Deco admin live preview iframe to work.
 * Also removes X-Frame-Options if present (CSP supersedes it).
 *
 * @example
 * ```ts
 * import { setCSPHeaders } from "@decocms/start/sdk/csp";
 *
 * // In middleware:
 * const response = await next();
 * setCSPHeaders(response);
 * return response;
 * ```
 */
export function setCSPHeaders(
  response: Response,
  options?: CSPOptions,
): void {
  const origins = [
    "'self'",
    ...(options?.adminOrigins ?? DEFAULT_ADMIN_ORIGINS),
    ...(options?.extraOrigins ?? []),
  ];

  response.headers.set(
    "Content-Security-Policy",
    `frame-ancestors ${origins.join(" ")}`,
  );

  response.headers.delete("X-Frame-Options");
}

/**
 * Build the CSP header value string without applying it.
 * Useful when constructing headers in route definitions.
 */
export function buildCSPHeaderValue(options?: CSPOptions): string {
  const origins = [
    "'self'",
    ...(options?.adminOrigins ?? DEFAULT_ADMIN_ORIGINS),
    ...(options?.extraOrigins ?? []),
  ];
  return `frame-ancestors ${origins.join(" ")}`;
}
