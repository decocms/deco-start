import { tokenIsValid, verifyAdminJwt } from "./jwt";

/**
 * Web-standard JWT guard. Returns a Response (401/403) to short-circuit, or
 * null to indicate the request is authorized and should continue.
 *
 * Honors the `DANGEROUSLY_ALLOW_PUBLIC_ACCESS=true` env bypass, matching
 * the existing Connect-style `createAuthMiddleware` semantics.
 */
export async function requireAdminJwt(
  req: Request,
  site: string,
): Promise<Response | null> {
  if (process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS === "true") return null;

  const token = extractToken(req);
  if (!token) return new Response(null, { status: 401 });

  const jwt = await verifyAdminJwt(token);
  if (!jwt) return new Response(null, { status: 401 });

  if (!tokenIsValid(site, jwt)) return new Response(null, { status: 403 });
  return null;
}

function extractToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const parts = auth.split(/\s+/);
    if (parts.length === 2) return parts[1];
  }
  const url = new URL(req.url);
  return url.searchParams.get("token");
}
