/**
 * Connect-style JWT auth middleware for Vite's middleware stack.
 *
 * The pure JWT primitives moved to `src/node/daemon/jwt.ts` so both the
 * Connect-style and Web-standard wrappers share the same trust chain. This
 * file is now only the Node-http adapter — the verification, payload type,
 * and URN matching all come from there.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { tokenIsValid, verifyAdminJwt } from "../../node/daemon/jwt";

export { verifyAdminJwt, tokenIsValid } from "../../node/daemon/jwt";
export type { JwtPayload } from "../../node/daemon/jwt";

const BYPASS_JWT = process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS === "true";

function extractToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth) {
    const parts = auth.split(/\s+/);
    if (parts.length === 2) return parts[1];
  }
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const t = url.searchParams.get("token");
    if (t) return t;
  } catch {
    // ignore
  }
  return null;
}

export type NextFn = () => void;

/**
 * Returns a Connect-style middleware that verifies JWT on every request.
 * If invalid, responds 401/403. If valid (or bypass enabled), calls next().
 */
export function createAuthMiddleware(site: string) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: NextFn,
  ): Promise<void> => {
    if (BYPASS_JWT) {
      next();
      return;
    }

    const token = extractToken(req);
    if (!token) {
      res.writeHead(401);
      res.end();
      return;
    }

    const jwt = await verifyAdminJwt(token);
    if (!jwt) {
      res.writeHead(401);
      res.end();
      return;
    }

    if (!tokenIsValid(site, jwt)) {
      res.writeHead(403);
      res.end();
      return;
    }

    next();
  };
}
