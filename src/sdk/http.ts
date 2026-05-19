/**
 * HTTP constants and small typed helpers — replaces the parts of Deno's
 * `@std/http` (other than cookies, which live in `./cookie.ts`) that deco
 * storefronts touch.
 *
 * Currently exposes:
 *   - `STATUS_CODE` — full IANA status-code map (parity with @std/http).
 *   - `UserAgent`   — minimal class with the same shape; does not parse
 *                     the UA string (sites only used `.toString()` and
 *                     basic browser/os accessors in dev). Replace with a
 *                     real parser like `ua-parser-js` if you actually
 *                     depend on the parsed fields.
 */

export const STATUS_CODE = {
  Continue: 100,
  SwitchingProtocols: 101,
  Processing: 102,
  EarlyHints: 103,
  OK: 200,
  Created: 201,
  Accepted: 202,
  NonAuthoritativeInfo: 203,
  NoContent: 204,
  ResetContent: 205,
  PartialContent: 206,
  MultiStatus: 207,
  AlreadyReported: 208,
  IMUsed: 226,
  MultipleChoices: 300,
  MovedPermanently: 301,
  Found: 302,
  SeeOther: 303,
  NotModified: 304,
  UseProxy: 305,
  TemporaryRedirect: 307,
  PermanentRedirect: 308,
  BadRequest: 400,
  Unauthorized: 401,
  PaymentRequired: 402,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  NotAcceptable: 406,
  ProxyAuthRequired: 407,
  RequestTimeout: 408,
  Conflict: 409,
  Gone: 410,
  LengthRequired: 411,
  PreconditionFailed: 412,
  ContentTooLarge: 413,
  URITooLong: 414,
  UnsupportedMediaType: 415,
  RangeNotSatisfiable: 416,
  ExpectationFailed: 417,
  Teapot: 418,
  MisdirectedRequest: 421,
  UnprocessableEntity: 422,
  Locked: 423,
  FailedDependency: 424,
  TooEarly: 425,
  UpgradeRequired: 426,
  PreconditionRequired: 428,
  TooManyRequests: 429,
  RequestHeaderFieldsTooLarge: 431,
  UnavailableForLegalReasons: 451,
  InternalServerError: 500,
  NotImplemented: 501,
  BadGateway: 502,
  ServiceUnavailable: 503,
  GatewayTimeout: 504,
  HTTPVersionNotSupported: 505,
  VariantAlsoNegotiates: 506,
  InsufficientStorage: 507,
  LoopDetected: 508,
  NotExtended: 510,
  NetworkAuthenticationRequired: 511,
} as const;

export type StatusCode = typeof STATUS_CODE[keyof typeof STATUS_CODE];

/**
 * Minimal stand-in for Deno's `@std/http`'s `UserAgent`. Captures the raw
 * UA string and exposes the same field shape; does NOT parse. Replace with
 * a real parser when you start depending on parsed fields.
 */
export class UserAgent {
  ua: string;
  browser: { name?: string; version?: string };
  os: { name?: string; version?: string };
  device: { vendor?: string; model?: string; type?: string };
  cpu: { architecture?: string };
  engine: { name?: string; version?: string };

  constructor(ua: string | null) {
    this.ua = ua ?? "";
    this.browser = {};
    this.os = {};
    this.device = {};
    this.cpu = {};
    this.engine = {};
  }

  toString(): string {
    return this.ua;
  }
}

/**
 * Lightweight HTTP error class. Drop-in for the `HttpError` shape that
 * `deco-cx/apps` exposes — sites use it as `error instanceof HttpError &&
 * error.status === 304` and similar.
 */
export class HttpError extends Error {
  status: number;
  body?: unknown;

  constructor(status: number, message?: string, body?: unknown) {
    super(message ?? `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}
