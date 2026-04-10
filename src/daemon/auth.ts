/**
 * JWT verification for admin.deco.cx requests.
 * Uses Web Crypto only — no external dependencies.
 *
 * Ported from: deco-cx/deco daemon/auth.ts + commons/jwt/*
 */
import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Public key — same key used by all sites (from commons/jwt/trusted.ts)
// ---------------------------------------------------------------------------

const ADMIN_PUBLIC_KEY =
  process.env.DECO_ADMIN_PUBLIC_KEY ??
  "eyJrdHkiOiJSU0EiLCJhbGciOiJSUzI1NiIsIm4iOiJ1N0Y3UklDN19Zc3ljTFhEYlBvQ1pUQnM2elZ6VjVPWkhXQ0M4akFZeFdPUnByem9WNDJDQ1JBVkVOVjJldzk1MnJOX2FTMmR3WDlmVGRvdk9zWl9jX2RVRXctdGlPN3hJLXd0YkxsanNUbUhoNFpiYXU0aUVoa0o1VGNHc2VaelhFYXNOSEhHdUo4SzY3WHluRHJSX0h4Ym9kQ2YxNFFJTmc5QnJjT3FNQmQyMUl4eUctVVhQampBTnRDTlNici1rXzFKeTZxNmtPeVJ1ZmV2Mjl0djA4Ykh5WDJQenp5Tnp3RWpjY0lROWpmSFdMN0JXX2tzdFpOOXU3TUtSLWJ4bjlSM0FKMEpZTHdXR3VnZGpNdVpBRnk0dm5BUXZzTk5Cd3p2YnFzMnZNd0dDTnF1ZE1tVmFudlNzQTJKYkE3Q0JoazI5TkRFTXRtUS1wbmo1cUlYSlEiLCJlIjoiQVFBQiIsImtleV9vcHMiOlsidmVyaWZ5Il0sImV4dCI6dHJ1ZX0";

const BYPASS_JWT =
  process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS === "true";

// ---------------------------------------------------------------------------
// JWT types
// ---------------------------------------------------------------------------

export interface JwtPayload {
  [key: string]: unknown;
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
}

// ---------------------------------------------------------------------------
// Crypto helpers — ported from commons/jwt/keys.ts
// ---------------------------------------------------------------------------

const ALG = "RSASSA-PKCS1-v1_5";
const HASH = "SHA-256";

function parseJWK(b64: string): JsonWebKey {
  return JSON.parse(atob(b64));
}

let cachedKey: Promise<CryptoKey> | null = null;

function getAdminPublicKey(): Promise<CryptoKey> {
  cachedKey ??= crypto.subtle.importKey(
    "jwk",
    parseJWK(ADMIN_PUBLIC_KEY),
    { name: ALG, hash: HASH },
    false,
    ["verify"],
  );
  return cachedKey;
}

// ---------------------------------------------------------------------------
// JWT verification — ported from commons/jwt/jwt.ts
// ---------------------------------------------------------------------------

function base64UrlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const binary = atob(b64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function verifyAdminJwt(
  token: string,
): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = new TextEncoder().encode(
    `${headerB64}.${payloadB64}`,
  );
  const signature = base64UrlDecode(signatureB64);

  try {
    const key = await getAdminPublicKey();
    const valid = await crypto.subtle.verify(
      ALG,
      key,
      new Uint8Array(signature),
      new Uint8Array(signingInput),
    );
    if (!valid) return null;
  } catch {
    return null;
  }

  try {
    const payload: JwtPayload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payloadB64)),
    );
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// URN matching — ported from commons/jwt/engine.ts
// ---------------------------------------------------------------------------

function matchPart(urnPart: string, otherPart: string): boolean {
  return urnPart === "*" || otherPart === urnPart;
}

function matchParts(urn: string[], resource: string[]): boolean {
  return urn.every((part, idx) => matchPart(part, resource[idx]));
}

function matches(urnParts: string[]) {
  return (resourceUrn: string) => {
    const resourceParts = resourceUrn.split(":");
    const lastIdx = resourceParts.length - 1;
    return resourceParts.every((part, idx) => {
      if (part === "*") return true;
      if (lastIdx === idx) {
        return matchParts(part.split("/"), urnParts[idx].split("/"));
      }
      return part === urnParts[idx];
    });
  };
}

export function tokenIsValid(site: string, jwt: JwtPayload): boolean {
  const { iss, sub, exp } = jwt;
  if (!iss || !sub) return false;
  if (exp && exp * 1000 <= Date.now()) return false;
  const siteUrn = `urn:deco:site:*:${site}:deployment/*`;
  return matches(sub.split(":"))(siteUrn);
}

// ---------------------------------------------------------------------------
// Auth middleware for Connect (Vite dev server)
// ---------------------------------------------------------------------------

function extractToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth) {
    const parts = auth.split(/\s+/);
    if (parts.length === 2) return parts[1];
  }
  // Fallback: ?token= query param
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
