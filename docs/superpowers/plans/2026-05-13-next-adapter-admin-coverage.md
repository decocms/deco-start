# Next.js adapter admin coverage + shared daemon refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Next.js admin-protocol gap by extracting the daemon's request handlers from `src/tanstack/daemon/` into a Web-standard `src/node/daemon/` core, then wiring both adapters (TanStack via a thin Node-http shim, Next via direct App Router route handlers) to consume it. Add `/_healthcheck`, `/_ready`, configurable route groups, and fix the broken Next route-mounting documentation.

**Architecture:** Web-standard handlers (`Request → Response`) live in `src/node/daemon/`. Both adapters compose them via `createDecoAdminRoute(opts)`. The TanStack/Vite path wraps the composed handler in a Connect-style middleware via `toNodeMiddleware` for `vite dev`'s middleware stack. Next App Router consumes the composed handler directly from route handlers under escaped folder names.

**Tech Stack:** TypeScript, Vitest, Node 20+, Web Crypto, `node:fs/promises`, `chokidar` (TanStack-side via Vite watcher; Next-side via on-demand singleton), `fast-json-patch`.

**Reference spec:** `docs/superpowers/specs/2026-05-13-next-adapter-admin-coverage-design.md`.

---

## Pre-flight

- [ ] **Step 0: Confirm worktree is clean and tests pass before starting**

Run:
```bash
git status                                # expect: clean working tree
bun run typecheck
bun run test
```
Expected: typecheck passes, all existing tests pass. If anything is red here, stop and fix it before continuing — a failing baseline poisons every downstream verification.

---

## Phase 1 — Shared admin foundation in `core/`

### Task 1: Lift `ADMIN_COMPAT_VERSION` into `core/admin/`

**Files:**
- Create: `src/core/admin/version.ts`
- Create: `src/core/admin/version.test.ts`

- [ ] **Step 1.1: Write the test**

`src/core/admin/version.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ADMIN_COMPAT_VERSION } from "./version";

describe("ADMIN_COMPAT_VERSION", () => {
  it("is a non-empty semver string", () => {
    expect(ADMIN_COMPAT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is pinned to the deco-cx/deco 1.177.x compatibility range", () => {
    // This pin must NOT track @decocms/start's own version. Admin compares
    // against deco-cx/deco's range, so changing the major/minor here is a
    // breaking change for admin compatibility — bump deliberately.
    expect(ADMIN_COMPAT_VERSION.startsWith("1.177.")).toBe(true);
  });
});
```

- [ ] **Step 1.2: Run the test (expect failure)**

Run: `bunx vitest run src/core/admin/version.test.ts`
Expected: FAIL — `Cannot find module './version'`.

- [ ] **Step 1.3: Create the module**

`src/core/admin/version.ts`:
```ts
/**
 * Version reported to admin.deco.cx by `/_healthcheck` and similar probes.
 *
 * **Pinning contract:** this constant must NOT track `@decocms/start`'s own
 * version (currently 5.x). Admin compares the returned value against
 * `deco-cx/deco`'s release range (currently 1.177.x). Bumping it shifts the
 * admin compatibility window — change deliberately and document in the
 * release notes when you do.
 */
export const ADMIN_COMPAT_VERSION = "1.177.5";
```

- [ ] **Step 1.4: Run the test (expect pass)**

Run: `bunx vitest run src/core/admin/version.test.ts`
Expected: PASS.

- [ ] **Step 1.5: Commit**

```bash
git add src/core/admin/version.ts src/core/admin/version.test.ts
git commit -m "feat(core/admin): add ADMIN_COMPAT_VERSION pinned to deco-cx/deco 1.177.x

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2: Add `handleDecoReadiness` in `core/admin/`

**Files:**
- Create: `src/core/admin/readiness.ts`
- Create: `src/core/admin/readiness.test.ts`

- [ ] **Step 2.1: Write the test**

`src/core/admin/readiness.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBlocks } from "../cms/loader";
import { handleDecoReadiness } from "./readiness";

describe("handleDecoReadiness", () => {
  // Tests share globalThis-backed block state; isolate by resetting.
  beforeEach(() => {
    const g = globalThis as any;
    if (g.__deco) {
      g.__deco.blockData = undefined;
      g.__deco.revision = undefined;
    }
  });
  afterEach(() => {
    const g = globalThis as any;
    if (g.__deco) {
      g.__deco.blockData = undefined;
      g.__deco.revision = undefined;
    }
  });

  it("returns 503 'not ready' before setBlocks() has run", async () => {
    const res = handleDecoReadiness();
    expect(res.status).toBe(503);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(await res.text()).toBe("not ready");
  });

  it("returns 200 'ready' after setBlocks() has populated the registry", async () => {
    setBlocks({ "/": { name: "home" } });
    const res = handleDecoReadiness();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ready");
  });
});
```

- [ ] **Step 2.2: Run the test (expect failure)**

Run: `bunx vitest run src/core/admin/readiness.test.ts`
Expected: FAIL — `Cannot find module './readiness'`.

- [ ] **Step 2.3: Implement the handler**

`src/core/admin/readiness.ts`:
```ts
import { getRevision } from "../cms/loader";

/**
 * Web-standard readiness probe. Returns 200 once `setBlocks()` has been called
 * at least once (the block registry is hydrated and the storefront can serve
 * resolved pages), 503 otherwise.
 *
 * Suitable for k8s readinessProbe / Cloud Run health checks / our own infra.
 * Intentionally no CORS — readiness probes are intra-cluster.
 */
export function handleDecoReadiness(): Response {
  const ready = getRevision() !== null;
  return new Response(ready ? "ready" : "not ready", {
    status: ready ? 200 : 503,
    headers: { "Content-Type": "text/plain" },
  });
}
```

- [ ] **Step 2.4: Run the test (expect pass)**

Run: `bunx vitest run src/core/admin/readiness.test.ts`
Expected: PASS (both cases).

- [ ] **Step 2.5: Commit**

```bash
git add src/core/admin/readiness.ts src/core/admin/readiness.test.ts
git commit -m "feat(core/admin): add handleDecoReadiness backed by getRevision()

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Move JWT to `node/daemon/`

### Task 3: Create `src/node/daemon/jwt.ts` with the pure JWT primitives

**Files:**
- Create: `src/node/daemon/jwt.ts`
- Create: `src/node/daemon/jwt.test.ts`
- Modify: `src/tanstack/daemon/auth.ts` (turn JWT functions into re-exports)

- [ ] **Step 3.1: Write the test**

`src/node/daemon/jwt.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { tokenIsValid, type JwtPayload, verifyAdminJwt } from "./jwt";

describe("verifyAdminJwt", () => {
  it("returns null for malformed tokens", async () => {
    expect(await verifyAdminJwt("not-a-jwt")).toBeNull();
    expect(await verifyAdminJwt("a.b")).toBeNull();
    expect(await verifyAdminJwt("")).toBeNull();
  });

  it("returns null for tokens with invalid signatures", async () => {
    // header.payload.signature where signature does not verify
    const fake = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.AAAA";
    expect(await verifyAdminJwt(fake)).toBeNull();
  });
});

describe("tokenIsValid", () => {
  it("rejects payloads missing iss or sub", () => {
    expect(tokenIsValid("my-site", { iss: "x" } as JwtPayload)).toBe(false);
    expect(tokenIsValid("my-site", { sub: "x" } as JwtPayload)).toBe(false);
  });

  it("rejects expired tokens", () => {
    expect(
      tokenIsValid("my-site", {
        iss: "admin",
        sub: "urn:deco:site:org:my-site:deployment/123",
        exp: 1,
      }),
    ).toBe(false);
  });

  it("accepts a matching site URN", () => {
    expect(
      tokenIsValid("my-site", {
        iss: "admin",
        sub: "urn:deco:site:org:my-site:deployment/123",
        exp: 9999999999,
      }),
    ).toBe(true);
  });

  it("rejects mismatched site", () => {
    expect(
      tokenIsValid("other-site", {
        iss: "admin",
        sub: "urn:deco:site:org:my-site:deployment/123",
        exp: 9999999999,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 3.2: Run the test (expect failure)**

Run: `bunx vitest run src/node/daemon/jwt.test.ts`
Expected: FAIL — `Cannot find module './jwt'`.

- [ ] **Step 3.3: Create `src/node/daemon/jwt.ts`**

Port the JWT logic from `src/tanstack/daemon/auth.ts` lines 1–142 (everything up to but not including `extractToken`). Remove the `IncomingMessage`/`ServerResponse` imports — this file is purely Web-Crypto. Paste:

```ts
/**
 * JWT verification primitives — Web Crypto only, no Node-http coupling.
 *
 * Moved from `src/tanstack/daemon/auth.ts` so both the Connect-style
 * (`createAuthMiddleware`) and Web-standard (`requireAdminJwt`) wrappers
 * can share the same trust chain.
 */

const ADMIN_PUBLIC_KEY =
  process.env.DECO_ADMIN_PUBLIC_KEY ??
  "eyJrdHkiOiJSU0EiLCJhbGciOiJSUzI1NiIsIm4iOiJ1N0Y3UklDN19Zc3ljTFhEYlBvQ1pUQnM2elZ6VjVPWkhXQ0M4akFZeFdPUnByem9WNDJDQ1JBVkVOVjJldzk1MnJOX2FTMmR3WDlmVGRvdk9zWl9jX2RVRXctdGlPN3hJLXd0YkxsanNUbUhoNFpiYXU0aUVoa0o1VGNHc2VaelhFYXNOSEhHdUo4SzY3WHluRHJSX0h4Ym9kQ2YxNFFJTmc5QnJjT3FNQmQyMUl4eUctVVhQampBTnRDTlNici1rXzFKeTZxNmtPeVJ1ZmV2Mjl0djA4Ykh5WDJQenp5Tnp3RWpjY0lROWpmSFdMN0JXX2tzdFpOOXU3TUtSLWJ4bjlSM0FKMEpZTHdXR3VnZGpNdVpBRnk0dm5BUXZzTk5Cd3p2YnFzMnZNd0dDTnF1ZE1tVmFudlNzQTJKYkE3Q0JoazI5TkRFTXRtUS1wbmo1cUlYSlEiLCJlIjoiQVFBQiIsImtleV9vcHMiOlsidmVyaWZ5Il0sImV4dCI6dHJ1ZX0";

const ALG = "RSASSA-PKCS1-v1_5";
const HASH = "SHA-256";

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

function base64UrlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const binary = atob(b64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function verifyAdminJwt(token: string): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
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

function matchPart(urnPart: string, otherPart: string): boolean {
  return urnPart === "*" || otherPart === urnPart;
}

function matchParts(urn: string[], resource: string[]): boolean {
  return urn.every((part, idx) => matchPart(part, resource[idx]));
}

function matches(urnParts: string[]) {
  return (resourceUrn: string) => {
    const resourceParts = resourceUrn.split(":");
    if (resourceParts.length > urnParts.length) return false;
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
```

- [ ] **Step 3.4: Run the new test (expect pass)**

Run: `bunx vitest run src/node/daemon/jwt.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 3.5: Convert `src/tanstack/daemon/auth.ts` to re-export and keep Connect middleware**

Replace the contents of `src/tanstack/daemon/auth.ts` with:

```ts
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
```

- [ ] **Step 3.6: Verify TanStack daemon tests still pass**

Run: `bunx vitest run src/tanstack/daemon/`
Expected: PASS — no behaviour change for Connect-style middleware.

- [ ] **Step 3.7: Verify tier boundaries**

The tier-boundary check runs against compiled `dist/`. For now, confirm `src/node/` exists as a directory and the new import path resolves at typecheck:

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3.8: Commit**

```bash
git add src/node/daemon/jwt.ts src/node/daemon/jwt.test.ts src/tanstack/daemon/auth.ts
git commit -m "refactor(daemon): move JWT primitives to src/node/daemon/jwt

Pure Web-Crypto verifyAdminJwt + tokenIsValid relocate to a framework-neutral
tier so the new Web-standard auth wrapper can consume them without crossing
the next/ → tanstack/ boundary. tanstack/daemon/auth.ts keeps its Connect-style
middleware and re-exports the JWT symbols for back-compat.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 4: Add Web-standard `requireAdminJwt` guard

**Files:**
- Create: `src/node/daemon/auth.ts`
- Create: `src/node/daemon/auth.test.ts`

- [ ] **Step 4.1: Write the test**

`src/node/daemon/auth.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireAdminJwt } from "./auth";

describe("requireAdminJwt", () => {
  const originalBypass = process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS;
  beforeEach(() => {
    delete process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS;
  });
  afterEach(() => {
    if (originalBypass === undefined) {
      delete process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS;
    } else {
      process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS = originalBypass;
    }
  });

  it("returns 401 Response when no token is present", async () => {
    const req = new Request("http://t/fs/file/x");
    const res = await requireAdminJwt(req, "my-site");
    expect(res).toBeInstanceOf(Response);
    expect(res?.status).toBe(401);
  });

  it("returns 401 Response when token is malformed", async () => {
    const req = new Request("http://t/fs/file/x", {
      headers: { authorization: "Bearer not-a-jwt" },
    });
    const res = await requireAdminJwt(req, "my-site");
    expect(res?.status).toBe(401);
  });

  it("returns null (pass) when DANGEROUSLY_ALLOW_PUBLIC_ACCESS=true", async () => {
    process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS = "true";
    const req = new Request("http://t/fs/file/x");
    const res = await requireAdminJwt(req, "my-site");
    expect(res).toBeNull();
  });

  it("accepts a ?token= query param fallback", async () => {
    // Token is malformed but exercises the extraction path.
    const req = new Request("http://t/fs/file/x?token=abc");
    const res = await requireAdminJwt(req, "my-site");
    // Still 401 because token is invalid — but path was attempted.
    expect(res?.status).toBe(401);
  });
});
```

- [ ] **Step 4.2: Run the test (expect failure)**

Run: `bunx vitest run src/node/daemon/auth.test.ts`
Expected: FAIL — `Cannot find module './auth'`.

- [ ] **Step 4.3: Implement the guard**

`src/node/daemon/auth.ts`:
```ts
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
```

- [ ] **Step 4.4: Run the test (expect pass)**

Run: `bunx vitest run src/node/daemon/auth.test.ts`
Expected: PASS.

- [ ] **Step 4.5: Commit**

```bash
git add src/node/daemon/auth.ts src/node/daemon/auth.test.ts
git commit -m "feat(node/daemon): add requireAdminJwt Web-standard guard

Returns Response (401/403) to short-circuit or null to continue. Mirrors
createAuthMiddleware's semantics including the DANGEROUSLY_ALLOW_PUBLIC_ACCESS
bypass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Web-standard handlers in `node/daemon/`

### Task 5: `handleDecoHealthcheck`

**Files:**
- Create: `src/node/daemon/healthcheck.ts`
- Create: `src/node/daemon/healthcheck.test.ts`

- [ ] **Step 5.1: Write the test**

`src/node/daemon/healthcheck.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ADMIN_COMPAT_VERSION } from "../../core/admin/version";
import { handleDecoHealthcheck } from "./healthcheck";

describe("handleDecoHealthcheck", () => {
  it("returns 200 with the ADMIN_COMPAT_VERSION body", async () => {
    const res = handleDecoHealthcheck();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ADMIN_COMPAT_VERSION);
  });

  it("emits text/plain", () => {
    expect(handleDecoHealthcheck().headers.get("Content-Type")).toBe("text/plain");
  });

  it("emits the CORS headers admin.deco.cx expects", () => {
    const res = handleDecoHealthcheck();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
  });
});
```

- [ ] **Step 5.2: Run the test (expect failure)**

Run: `bunx vitest run src/node/daemon/healthcheck.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 5.3: Implement the handler**

`src/node/daemon/healthcheck.ts`:
```ts
import { ADMIN_COMPAT_VERSION } from "../../core/admin/version";

/**
 * Web-standard `/_healthcheck` handler.
 *
 * Returns the admin-compatibility version (NOT @decocms/start's own version)
 * with the CORS headers admin.deco.cx expects from the daemon endpoint.
 */
export function handleDecoHealthcheck(): Response {
  return new Response(ADMIN_COMPAT_VERSION, {
    status: 200,
    headers: {
      "Content-Type": "text/plain",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
```

- [ ] **Step 5.4: Run the test (expect pass)**

Run: `bunx vitest run src/node/daemon/healthcheck.test.ts`
Expected: PASS.

- [ ] **Step 5.5: Commit**

```bash
git add src/node/daemon/healthcheck.ts src/node/daemon/healthcheck.test.ts
git commit -m "feat(node/daemon): add handleDecoHealthcheck Web-standard handler

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 6: Move the broadcast channel + watcher to `node/daemon/`

This task ports the existing channel/watcher logic out of `src/tanstack/daemon/watch.ts` so it can be shared. We keep the same module-level singletons (`channel`, `inferMetadata`) but expose Web-standard helpers.

**Files:**
- Create: `src/node/daemon/watch.ts` (broadcast channel + `inferMetadata` + types)
- Create: `src/node/daemon/watcher.ts` (chokidar wrapper for Next-side use)
- Modify: `src/tanstack/daemon/watch.ts` (becomes a thin re-export + Connect-style handler that consumes the new core)

- [ ] **Step 6.1: Write the broadcast-channel test**

`src/node/daemon/watch.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { broadcastFsEvent, subscribeFsEvents, type FsEvent } from "./watch";

describe("broadcast channel", () => {
  it("delivers events to subscribers and stops after unsubscribe", () => {
    const seen: FsEvent[] = [];
    const unsubscribe = subscribeFsEvents((e) => seen.push(e));
    broadcastFsEvent({ type: "worker-status", detail: { state: "ready" } });
    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe("worker-status");
    unsubscribe();
    broadcastFsEvent({ type: "worker-status", detail: { state: "ready" } });
    expect(seen.length).toBe(1);
  });
});
```

- [ ] **Step 6.2: Run the test (expect failure)**

Run: `bunx vitest run src/node/daemon/watch.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 6.3: Create `src/node/daemon/watch.ts`**

This file consolidates the *non-handler* pieces from `src/tanstack/daemon/watch.ts`: the broadcast channel, the `inferMetadata` JSON-resolveType inference, and the `scanFiles` initial-sync generator. The Connect-style and Web-standard handlers consume these. Paste:

```ts
/**
 * Daemon broadcast channel + .deco/ file scanner + metadata inference.
 *
 * Framework-neutral. Both the Connect-style watch handler (consumed by Vite's
 * middleware stack) and the Web-standard `handleWatchSse` consume from here.
 *
 * Ported from: deco-cx/deco daemon/sse/api.ts + daemon/sse/channel.ts
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";

export interface FsEvent {
  type: "fs-sync" | "fs-snapshot" | "worker-status" | "meta-info";
  detail: Record<string, unknown>;
}

const channel = new EventTarget();

/** Publish an event to all subscribers. */
export function broadcastFsEvent(event: FsEvent): void {
  channel.dispatchEvent(new CustomEvent("broadcast", { detail: event }));
}

/** Subscribe to broadcast events. Returns an unsubscribe function. */
export function subscribeFsEvents(listener: (event: FsEvent) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<FsEvent>).detail);
  channel.addEventListener("broadcast", handler);
  return () => channel.removeEventListener("broadcast", handler);
}

const toPosix = (p: string) => p.replaceAll(sep, "/");

function shouldIgnore(path: string): boolean {
  return (
    path.includes(`${sep}.git${sep}`) ||
    path.includes(`${sep}node_modules${sep}`) ||
    path.includes(`${sep}.agent-home${sep}`) ||
    path.includes(`${sep}.claude${sep}`)
  );
}

function inferBlockType(resolveType: string): string | null {
  if (!resolveType) return null;
  if (resolveType.includes("/pages/")) return "pages";
  if (resolveType.includes("/sections/")) return "sections";
  if (resolveType.includes("/loaders/")) return "loaders";
  if (resolveType.includes("/actions/")) return "actions";
  if (resolveType.includes("/matchers/")) return "matchers";
  if (resolveType.includes("/flags/")) return "sections";
  return null;
}

export interface Metadata {
  kind: "block" | "file";
  blockType?: string;
  __resolveType?: string;
  name?: string;
  path?: string;
}

/** Read a JSON file and infer its block metadata (block type, resolveType, …). */
export async function inferMetadata(filepath: string): Promise<Metadata | null> {
  try {
    const raw = await readFile(filepath, "utf-8");
    const parsed = JSON.parse(raw);
    const { __resolveType, name, path: pagePath } = parsed;

    if (!__resolveType) return { kind: "file" };
    const blockType = inferBlockType(__resolveType);
    if (!blockType) return { kind: "file" };

    if (blockType === "pages") {
      return {
        kind: "block",
        blockType,
        __resolveType,
        name: name ?? undefined,
        path: pagePath ?? undefined,
      };
    }
    return { kind: "block", blockType, __resolveType };
  } catch {
    return { kind: "file" };
  }
}

/** Yield fs-sync events for every .deco/ file modified after `since`. */
export async function* scanDecoFiles(cwd: string, since: number): AsyncGenerator<FsEvent> {
  const decoDir = join(cwd, ".deco");
  try {
    const entries = await readdir(decoDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = join(entry.parentPath, entry.name);
      if (shouldIgnore(fullPath)) continue;

      let mtime: number;
      try {
        const stats = await stat(fullPath);
        mtime = stats.mtimeMs;
      } catch {
        mtime = Date.now();
      }
      if (mtime < since) continue;

      const metadata = await inferMetadata(fullPath);
      const filepath = toPosix(fullPath.replace(cwd, ""));
      yield { type: "fs-sync", detail: { metadata, filepath, timestamp: mtime } };
    }
  } catch {
    // .deco dir might not exist yet
  }
  yield { type: "fs-snapshot", detail: { timestamp: Date.now() } };
}

/** Common ignore predicate, exported for the watcher wrappers. */
export function shouldIgnorePath(path: string): boolean {
  return shouldIgnore(path);
}

export const toPosixPath = toPosix;
```

- [ ] **Step 6.4: Create `src/node/daemon/watcher.ts`**

`src/node/daemon/watcher.ts`:
```ts
/**
 * Chokidar watcher wrapper for the Next-side daemon path.
 *
 * The TanStack-side daemon receives Vite's existing watcher via
 * `createDaemonMiddleware`'s options and binds it via `bindWatcherToChannel`;
 * it never calls this function. The Next-side daemon has no Vite, so it
 * spins up its own chokidar instance lazily on the first watch/fs request.
 */
import chokidar from "chokidar";
import { stat } from "node:fs/promises";
import {
  broadcastFsEvent,
  inferMetadata,
  shouldIgnorePath,
  toPosixPath,
} from "./watch";

export interface DecoWatcher {
  watcher: chokidar.FSWatcher;
  close: () => Promise<void>;
}

export function createDecoWatcher(cwd: string): DecoWatcher {
  const watcher = chokidar.watch(cwd, {
    ignoreInitial: true,
    ignored: (p: string) => shouldIgnorePath(p),
  });
  bindWatcherToChannel(watcher, cwd);
  return {
    watcher,
    close: () => watcher.close(),
  };
}

/**
 * Wire any chokidar-style watcher (Vite's or our own) to the broadcast channel.
 * Pure side-effect helper — does not own the watcher's lifecycle.
 */
export function bindWatcherToChannel(
  watcher: { on(event: string, cb: (...args: unknown[]) => void): void },
  cwd: string = process.cwd(),
): void {
  const onChange = async (filePath: unknown, deleted = false) => {
    if (typeof filePath !== "string") return;
    if (shouldIgnorePath(filePath)) return;

    const metadata = deleted ? null : await inferMetadata(filePath);
    let mtime = Date.now();
    if (!deleted) {
      try {
        const stats = await stat(filePath);
        mtime = stats.mtimeMs;
      } catch {
        // use Date.now()
      }
    }

    broadcastFsEvent({
      type: "fs-sync",
      detail: {
        metadata,
        filepath: toPosixPath(filePath.replace(cwd, "")),
        timestamp: mtime,
      },
    });
  };

  watcher.on("change", (path: unknown) => onChange(path));
  watcher.on("add", (path: unknown) => onChange(path));
  watcher.on("unlink", (path: unknown) => onChange(path, true));
}
```

- [ ] **Step 6.5: Run the broadcast-channel test (expect pass)**

Run: `bunx vitest run src/node/daemon/watch.test.ts`
Expected: PASS.

- [ ] **Step 6.6: Update `src/tanstack/daemon/watch.ts` to re-export from `node/daemon/watch`**

Replace the contents of `src/tanstack/daemon/watch.ts` with a slim file that keeps the Connect-style `createWatchHandler` (used by the existing middleware until Task 12 retires it), but delegates the channel + scanner to the new shared module:

```ts
/**
 * Connect-style SSE handler — wraps the shared Web-standard `handleWatchSse`
 * for Vite's middleware stack. New code should consume `handleWatchSse`
 * directly from `src/node/daemon/watch-sse` and bind it via `toNodeMiddleware`
 * (introduced in Task 9).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  broadcastFsEvent,
  inferMetadata,
  type FsEvent,
  scanDecoFiles,
  subscribeFsEvents,
} from "../../node/daemon/watch";
import { bindWatcherToChannel } from "../../node/daemon/watcher";

export {
  broadcastFsEvent as broadcastFSEvent,
  inferMetadata,
  type FsEvent,
  type Metadata,
} from "../../node/daemon/watch";

/**
 * Back-compat shim — TanStack daemon middleware still constructs this.
 * The implementation reuses the new shared scanner + channel.
 */
export function createWatchHandler(opts?: { getPort?: () => number }) {
  const cwd = process.cwd();
  const getPort = opts?.getPort ?? (() => 5173);

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/watch" && url.pathname !== "/") return next();
    if (req.method !== "GET") return next();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const since = Number(url.searchParams.get("since")) || 0;
    let closed = false;

    const sendEvent = (event: FsEvent) => {
      if (closed) return;
      const data = encodeURIComponent(JSON.stringify(event));
      res.write(`event: message\ndata: ${data}\n\n`);
    };

    const unsubscribe = subscribeFsEvents(sendEvent);
    req.on("close", () => {
      closed = true;
      unsubscribe();
    });

    for await (const event of scanDecoFiles(cwd, since)) {
      if (closed) break;
      sendEvent(event);
    }
    if (closed) return;

    sendEvent({ type: "worker-status", detail: { state: "ready" } });

    try {
      const metaResponse = await fetch(`http://localhost:${getPort()}/live/_meta`);
      if (metaResponse.ok) {
        const metaData = await metaResponse.json();
        sendEvent({ type: "meta-info", detail: { ...metaData, timestamp: Date.now() } });
      }
    } catch {
      // schema not initialised yet
    }
  };
}

/** Back-compat — TanStack daemon binds Vite's watcher into the shared channel here. */
export function watchFS(watcher: {
  on(event: string, cb: (...args: unknown[]) => void): void;
}): void {
  bindWatcherToChannel(watcher);
}
```

- [ ] **Step 6.7: Verify nothing regressed**

Run:
```bash
bun run typecheck
bunx vitest run src/tanstack/daemon/ src/node/daemon/
```
Expected: PASS.

- [ ] **Step 6.8: Commit**

```bash
git add src/node/daemon/watch.ts src/node/daemon/watcher.ts src/node/daemon/watch.test.ts src/tanstack/daemon/watch.ts
git commit -m "refactor(daemon): move broadcast channel + .deco scanner to src/node/daemon

src/tanstack/daemon/watch.ts becomes a thin Connect-style shim over the
new shared scanner + channel; the chokidar wrapper for Next-side use lives
in src/node/daemon/watcher.ts (lazy singleton, never instantiated from
TanStack).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 7: Web-standard SSE handler

**Files:**
- Create: `src/node/daemon/watch-sse.ts`
- Create: `src/node/daemon/watch-sse.test.ts`

- [ ] **Step 7.1: Write the test**

`src/node/daemon/watch-sse.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { broadcastFsEvent } from "./watch";
import { handleWatchSse } from "./watch-sse";

describe("handleWatchSse", () => {
  it("returns a text/event-stream Response", () => {
    const controller = new AbortController();
    const req = new Request("http://t/_watch", { signal: controller.signal });
    const res = handleWatchSse(req, { cwd: process.cwd() });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    controller.abort();
  });

  it("forwards broadcast events to the SSE stream", async () => {
    const controller = new AbortController();
    const req = new Request("http://t/_watch?since=" + Date.now(), { signal: controller.signal });
    const res = handleWatchSse(req, { cwd: process.cwd() });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Drain the initial fs-snapshot before publishing — scanner emits it last.
    let buffer = "";
    while (!buffer.includes("fs-snapshot")) {
      const { value } = await reader.read();
      buffer += decoder.decode(value);
    }

    broadcastFsEvent({ type: "worker-status", detail: { state: "ready" } });
    let received = "";
    while (!received.includes("worker-status")) {
      const { value } = await reader.read();
      received += decoder.decode(value);
    }
    expect(received).toContain("worker-status");
    controller.abort();
  });
});
```

- [ ] **Step 7.2: Run the test (expect failure)**

Run: `bunx vitest run src/node/daemon/watch-sse.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 7.3: Implement the handler**

`src/node/daemon/watch-sse.ts`:
```ts
import {
  type FsEvent,
  scanDecoFiles,
  subscribeFsEvents,
} from "./watch";

export interface WatchSseOptions {
  /** Watch root. Defaults to process.cwd(). */
  cwd?: string;
  /** Resolves the loopback port the meta-info fetch should hit. Defaults to 5173. */
  getPort?: () => number;
}

/**
 * Web-standard SSE handler for `/_watch` and `/watch`.
 *
 * Emits the initial .deco/ snapshot, then forwards broadcast-channel events
 * for the lifetime of the connection. Closes cleanly when the request signal
 * aborts.
 */
export function handleWatchSse(req: Request, opts: WatchSseOptions = {}): Response {
  const url = new URL(req.url);
  const since = Number(url.searchParams.get("since")) || 0;
  const cwd = opts.cwd ?? process.cwd();
  const getPort = opts.getPort ?? (() => 5173);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const send = (event: FsEvent) => {
        if (closed) return;
        const data = encodeURIComponent(JSON.stringify(event));
        controller.enqueue(encoder.encode(`event: message\ndata: ${data}\n\n`));
      };

      const unsubscribe = subscribeFsEvents(send);

      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      req.signal.addEventListener("abort", close);

      try {
        for await (const event of scanDecoFiles(cwd, since)) {
          if (closed) return;
          send(event);
        }
        if (closed) return;

        send({ type: "worker-status", detail: { state: "ready" } });

        try {
          const metaResponse = await fetch(`http://localhost:${getPort()}/live/_meta`);
          if (metaResponse.ok) {
            const metaData = await metaResponse.json();
            send({ type: "meta-info", detail: { ...metaData, timestamp: Date.now() } });
          }
        } catch {
          // schema not initialised yet — admin will retry via /live/_meta
        }
      } catch (err) {
        if (!closed) {
          try {
            controller.error(err);
          } catch {
            // ignore
          }
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 7.4: Run the test (expect pass)**

Run: `bunx vitest run src/node/daemon/watch-sse.test.ts`
Expected: PASS (both cases).

- [ ] **Step 7.5: Commit**

```bash
git add src/node/daemon/watch-sse.ts src/node/daemon/watch-sse.test.ts
git commit -m "feat(node/daemon): Web-standard handleWatchSse SSE handler

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 8: Web-standard FS handler

**Files:**
- Create: `src/node/daemon/fs.ts`
- Create: `src/node/daemon/fs.test.ts`

- [ ] **Step 8.1: Write the test**

`src/node/daemon/fs.test.ts`:
```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleFsRequest } from "./fs";

describe("handleFsRequest", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "deco-fs-test-"));
    await mkdir(join(cwd, ".deco", "blocks"), { recursive: true });
    await writeFile(
      join(cwd, ".deco", "blocks", "site.json"),
      JSON.stringify({ greeting: "hello" }),
    );
  });
  afterEach(() => rm(cwd, { recursive: true, force: true }));

  it("GET returns the file content with metadata + mtime", async () => {
    const req = new Request("http://t/fs/file/.deco/blocks/site.json");
    const res = await handleFsRequest(req, { cwd });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.parse(body.content).greeting).toBe("hello");
    expect(body.timestamp).toBeGreaterThan(0);
  });

  it("GET returns 404 with a timestamp for a missing file", async () => {
    const req = new Request("http://t/fs/file/.deco/missing.json");
    const res = await handleFsRequest(req, { cwd });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.timestamp).toBeGreaterThan(0);
  });

  it("rejects path traversal", async () => {
    const req = new Request("http://t/fs/file/../../etc/passwd");
    const res = await handleFsRequest(req, { cwd });
    expect(res.status).toBe(403);
  });

  it("PATCH applies a JSON patch", async () => {
    const patch = {
      type: "json" as const,
      payload: [{ op: "replace", path: "/greeting", value: "hi" }],
    };
    const req = new Request("http://t/fs/file/.deco/blocks/site.json", {
      method: "PATCH",
      body: JSON.stringify({ patch, timestamp: 0 }),
    });
    const res = await handleFsRequest(req, { cwd });
    expect(res.status).toBe(200);
    const after = JSON.parse(await readFile(join(cwd, ".deco/blocks/site.json"), "utf-8"));
    expect(after.greeting).toBe("hi");
  });

  it("DELETE removes the file", async () => {
    const req = new Request("http://t/fs/file/.deco/blocks/site.json", { method: "DELETE" });
    const res = await handleFsRequest(req, { cwd });
    expect(res.status).toBe(200);
    await expect(readFile(join(cwd, ".deco/blocks/site.json"), "utf-8")).rejects.toThrow();
  });

  it("/fs/grep stub returns an empty matches array", async () => {
    const req = new Request("http://t/fs/grep", { method: "POST" });
    const res = await handleFsRequest(req, { cwd });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ matches: [], totalMatches: 0 });
  });
});
```

- [ ] **Step 8.2: Run the test (expect failure)**

Run: `bunx vitest run src/node/daemon/fs.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 8.3: Implement the handler**

`src/node/daemon/fs.ts`:
```ts
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import fjp from "fast-json-patch";
import type { Operation } from "fast-json-patch";
import { broadcastFsEvent, inferMetadata, toPosixPath } from "./watch";

export interface FsHandlerOptions {
  /** Filesystem root that path resolutions must stay within. */
  cwd: string;
}

interface Patch {
  type: "json" | "text";
  payload: Operation[];
}

/**
 * Web-standard `/fs/*` handler. Implements GET/PATCH/DELETE on
 * `/fs/file/<path>` and a `/fs/grep` stub used by the admin search UI.
 */
export async function handleFsRequest(
  req: Request,
  opts: FsHandlerOptions,
): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname === "/fs/grep") {
    return jsonResponse(200, { matches: [], totalMatches: 0 });
  }

  if (!pathname.startsWith("/fs/file")) {
    return new Response(null, { status: 404 });
  }

  const filePath = extractFilePath(pathname);
  const systemPath = safePath(opts.cwd, filePath);
  if (!systemPath) return jsonResponse(403, { error: "Path traversal denied" });

  if (req.method === "GET") return getFile(systemPath);
  if (req.method === "PATCH") return patchFile(req, opts.cwd, systemPath);
  if (req.method === "DELETE") return deleteFile(opts.cwd, systemPath);
  return new Response(null, { status: 405 });
}

function safePath(cwd: string, untrusted: string): string | null {
  const resolved = resolve(cwd, untrusted.startsWith("/") ? `.${untrusted}` : untrusted);
  if (!resolved.startsWith(cwd + sep) && resolved !== cwd) return null;
  return resolved;
}

function extractFilePath(url: string): string {
  const [, ...segments] = url.split("/file");
  return segments.join("/file") || "/";
}

async function mtimeFor(filepath: string): Promise<number> {
  try {
    return (await stat(filepath)).mtimeMs;
  } catch {
    return Date.now();
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function getFile(systemPath: string): Promise<Response> {
  try {
    const [content, metadata, timestamp] = await Promise.all([
      readFile(systemPath, "utf-8"),
      inferMetadata(systemPath),
      mtimeFor(systemPath),
    ]);
    return jsonResponse(200, { content, metadata, timestamp });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return jsonResponse(404, { timestamp: Date.now() });
    }
    throw err;
  }
}

function applyPatch(
  content: string | null,
  patch: Patch,
): { conflict: boolean; content?: string } {
  try {
    if (patch.type === "json") {
      const result = patch.payload.reduce(
        fjp.applyReducer,
        JSON.parse(content ?? "{}"),
      );
      return { conflict: false, content: JSON.stringify(result, null, 2) };
    }
    if (patch.type === "text") {
      const result = patch.payload.reduce(
        fjp.applyReducer,
        content?.split("\n") ?? [],
      );
      return { conflict: false, content: (result as string[]).join("\n") };
    }
  } catch (err: unknown) {
    if (err instanceof fjp.JsonPatchError && err.name === "TEST_OPERATION_FAILED") {
      return { conflict: true };
    }
    throw err;
  }
  return { conflict: true };
}

async function patchFile(
  req: Request,
  cwd: string,
  systemPath: string,
): Promise<Response> {
  let body: { patch: Patch; timestamp: number };
  try {
    body = (await req.json()) as { patch: Patch; timestamp: number };
  } catch {
    return jsonResponse(400, { error: "Invalid JSON" });
  }

  const mtimeBefore = await mtimeFor(systemPath);
  let content: string | null;
  try {
    content = await readFile(systemPath, "utf-8");
  } catch {
    content = null;
  }

  const result = applyPatch(content, body.patch);
  if (!result.conflict && result.content != null) {
    await mkdir(join(systemPath, ".."), { recursive: true });
    await writeFile(systemPath, result.content, "utf-8");
  }

  const [metadata, mtimeAfter] = await Promise.all([
    inferMetadata(systemPath),
    mtimeFor(systemPath),
  ]);

  broadcastFsEvent({
    type: "fs-sync",
    detail: {
      metadata,
      timestamp: mtimeAfter,
      filepath: toPosixPath(systemPath.replace(cwd, "")),
    },
  });

  const update = result.conflict
    ? { conflict: true, metadata, timestamp: mtimeAfter, content }
    : {
        conflict: false,
        metadata,
        timestamp: mtimeAfter,
        content: mtimeBefore !== body.timestamp ? result.content : undefined,
      };
  return jsonResponse(200, update);
}

async function deleteFile(cwd: string, systemPath: string): Promise<Response> {
  try {
    await rm(systemPath, { force: true });
  } catch {
    // ignore
  }

  broadcastFsEvent({
    type: "fs-sync",
    detail: {
      metadata: null,
      timestamp: Date.now(),
      filepath: toPosixPath(systemPath.replace(cwd, "")),
    },
  });
  return jsonResponse(200, { conflict: false, metadata: null, timestamp: Date.now() });
}
```

- [ ] **Step 8.4: Run the test (expect pass)**

Run: `bunx vitest run src/node/daemon/fs.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 8.5: Commit**

```bash
git add src/node/daemon/fs.ts src/node/daemon/fs.test.ts
git commit -m "feat(node/daemon): Web-standard handleFsRequest

GET/PATCH/DELETE on /fs/file/<path> plus the /fs/grep stub the admin search
UI hits. Refuses path traversal. Broadcasts fs-sync events on mutate paths
so the existing SSE channel stays in sync.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Composition + Node-http adapter

### Task 9: Node-http adapter `toNodeMiddleware`

**Files:**
- Create: `src/node/daemon/nodeHttpAdapter.ts`
- Create: `src/node/daemon/nodeHttpAdapter.test.ts`

- [ ] **Step 9.1: Write the test**

`src/node/daemon/nodeHttpAdapter.test.ts`:
```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toNodeMiddleware } from "./nodeHttpAdapter";

describe("toNodeMiddleware", () => {
  let httpServer: ReturnType<typeof createServer>;
  let url: string;
  let nextWasCalled = false;

  beforeEach(async () => {
    nextWasCalled = false;
    const handler = toNodeMiddleware(async (req: Request) => {
      const u = new URL(req.url);
      if (u.pathname === "/fall") {
        // Returning null signals fall-through.
        return null;
      }
      if (u.pathname === "/echo-body" && req.method === "POST") {
        const body = await req.text();
        return new Response(`echo:${body}`, { status: 201 });
      }
      return new Response("hello", {
        status: 200,
        headers: { "X-Foo": "bar" },
      });
    });

    httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      handler(req, res, () => {
        nextWasCalled = true;
        res.statusCode = 418;
        res.end();
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const addr = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));

  it("translates a Web Response to a Node ServerResponse", async () => {
    const r = await fetch(url + "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("X-Foo")).toBe("bar");
    expect(await r.text()).toBe("hello");
  });

  it("forwards request bodies", async () => {
    const r = await fetch(url + "/echo-body", { method: "POST", body: "ping" });
    expect(r.status).toBe(201);
    expect(await r.text()).toBe("echo:ping");
  });

  it("calls next() when the handler returns null", async () => {
    const r = await fetch(url + "/fall");
    expect(r.status).toBe(418);
    expect(nextWasCalled).toBe(true);
  });
});
```

- [ ] **Step 9.2: Run the test (expect failure)**

Run: `bunx vitest run src/node/daemon/nodeHttpAdapter.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 9.3: Implement the adapter**

`src/node/daemon/nodeHttpAdapter.ts`:
```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

export type WebHandler = (req: Request) => Promise<Response | null> | Response | null;

/**
 * Wrap a Web-standard `Request → Response` handler as Connect-style middleware
 * for `vite dev`'s server.middlewares.use(...) stack.
 *
 * Returning `null` from the inner handler delegates to `next()` (fall-through).
 * Streaming bodies are piped through with backpressure preserved.
 */
export function toNodeMiddleware(handler: WebHandler) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    let webResponse: Response | null;
    try {
      const webReq = toWebRequest(req);
      webResponse = await handler(webReq);
    } catch (err) {
      console.error("[deco] daemon handler threw:", err);
      res.statusCode = 500;
      res.end();
      return;
    }
    if (!webResponse) return next();
    await writeWebResponse(res, webResponse);
  };
}

function toWebRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  const method = (req.method ?? "GET").toUpperCase();
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    (init as any).duplex = "half"; // required by Node's Web Request for streaming bodies
  }
  return new Request(url, init);
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  res.on("close", () => reader.cancel().catch(() => undefined));
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // Honor backpressure: pause reading until drain when write returns false.
      if (!res.write(value)) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
    res.end();
  } catch (err) {
    console.error("[deco] error streaming Response body:", err);
    res.destroy(err as Error);
  }
}
```

- [ ] **Step 9.4: Run the test (expect pass)**

Run: `bunx vitest run src/node/daemon/nodeHttpAdapter.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 9.5: Commit**

```bash
git add src/node/daemon/nodeHttpAdapter.ts src/node/daemon/nodeHttpAdapter.test.ts
git commit -m "feat(node/daemon): toNodeMiddleware Web↔Connect adapter

Lets the new Web-standard route handlers plug into Vite's middleware stack
without duplicating any dispatch logic. Honors backpressure and treats a
null return as fall-through.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 10: Route dispatcher `createDecoAdminRoute`

**Files:**
- Create: `src/node/daemon/route.ts`
- Create: `src/node/daemon/route.test.ts`

- [ ] **Step 10.1: Write the test**

`src/node/daemon/route.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_COMPAT_VERSION } from "../../core/admin/version";
import { createDecoAdminRoute } from "./route";

describe("createDecoAdminRoute", () => {
  const originalEnv = process.env.NODE_ENV;
  const originalBypass = process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS;

  beforeEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
    if (originalBypass === undefined) delete process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS;
    else process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS = originalBypass;
  });

  it("serves /_healthcheck with the version body", async () => {
    const handler = createDecoAdminRoute({ site: "my-site" });
    const res = await handler(new Request("http://t/_healthcheck"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ADMIN_COMPAT_VERSION);
  });

  it("serves /_ready (503 before setBlocks-equivalent state)", async () => {
    const handler = createDecoAdminRoute({ site: "my-site" });
    const res = await handler(new Request("http://t/_ready"));
    expect([200, 503]).toContain(res.status);
  });

  it("returns 404 when the master enabled switch is false", async () => {
    const handler = createDecoAdminRoute({ site: "my-site", enabled: false });
    const res = await handler(new Request("http://t/_healthcheck"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when an individual group is disabled", async () => {
    const handler = createDecoAdminRoute({ site: "my-site", healthcheck: false });
    expect((await handler(new Request("http://t/_healthcheck"))).status).toBe(404);
    expect((await handler(new Request("http://t/_ready"))).status).not.toBe(404);
  });

  it("disables /fs/* and /_watch in production by default", async () => {
    process.env.NODE_ENV = "production";
    const handler = createDecoAdminRoute({ site: "my-site" });
    expect((await handler(new Request("http://t/_watch"))).status).toBe(404);
    expect((await handler(new Request("http://t/fs/file/anything"))).status).toBe(404);
  });

  it("enables /fs/* and /_watch in development by default", async () => {
    process.env.NODE_ENV = "development";
    process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS = "true";
    // manageWatcher: false avoids spinning up a real chokidar against repo root
    // for unit tests; the lazy-watcher integration is exercised in src/next/.
    const handler = createDecoAdminRoute({
      site: "my-site",
      cwd: process.cwd(),
      manageWatcher: false,
    });
    const fsRes = await handler(new Request("http://t/fs/file/.deco/missing.json"));
    // 404 here means "file not found", not "route disabled" — assert it's not the route-404 case.
    expect(fsRes.status).toBe(404);
    expect((await fsRes.json()).timestamp).toBeGreaterThan(0);
  });

  it("gates /fs/* on JWT when bypass is not set", async () => {
    process.env.NODE_ENV = "development";
    const handler = createDecoAdminRoute({
      site: "my-site",
      manageWatcher: false,
    });
    const res = await handler(new Request("http://t/fs/file/.deco/anything"));
    expect(res.status).toBe(401);
  });

  it("creates the chokidar watcher lazily on first /fs/* hit when manageWatcher is on", async () => {
    process.env.NODE_ENV = "development";
    process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS = "true";
    const handler = createDecoAdminRoute({
      site: "my-site",
      cwd: process.cwd(),
      manageWatcher: true,
    });
    // Hit a non-existent path so we don't depend on repo contents; we only care
    // that the call succeeds without crashing the lazy-watcher boot.
    const res = await handler(new Request("http://t/fs/file/.deco/missing.json"));
    expect(res.status).toBe(404);
  });

  it("returns 501 for /volumes/<id>/files (Next path)", async () => {
    const handler = createDecoAdminRoute({ site: "my-site" });
    const res = await handler(new Request("http://t/volumes/abc/files"));
    expect(res.status).toBe(501);
  });

  it("throws at construction when site is missing and admin-protocol is enabled", () => {
    expect(() => createDecoAdminRoute({})).toThrow(/site/);
  });

  it("does not require site when only probes are enabled", () => {
    expect(() =>
      createDecoAdminRoute({
        adminProtocol: false,
        fs: false,
        watch: false,
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 10.2: Run the test (expect failure)**

Run: `bunx vitest run src/node/daemon/route.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 10.3: Implement the dispatcher**

`src/node/daemon/route.ts`:
```ts
import { handleDecofileRead, handleDecofileReload } from "../../core/admin/decofile";
import { handleInvoke } from "../../core/admin/invoke";
import { handleMeta } from "../../core/admin/meta";
import { handleRender } from "../../core/admin/render";
import { handleDecoReadiness } from "../../core/admin/readiness";
import { requireAdminJwt } from "./auth";
import { handleFsRequest } from "./fs";
import { handleDecoHealthcheck } from "./healthcheck";
import { handleWatchSse } from "./watch-sse";

export interface DecoAdminRouteOptions {
  /** Master switch — false short-circuits everything to 404. */
  enabled?: boolean;
  /** Hosting probe `/_healthcheck`. Default: true. */
  healthcheck?: boolean;
  /** Hosting probe `/_ready`. Default: true. */
  readiness?: boolean;
  /** Admin protocol (`/live/_meta`, `/.decofile`, `/deco/*`, `/live/previews/*`). Default: true. */
  adminProtocol?: boolean;
  /** Dev tooling SSE (`/_watch`, `/watch`). Default: NODE_ENV !== "production". */
  watch?: boolean;
  /** Dev tooling JSON-patch FS (`/fs/*`). Default: NODE_ENV !== "production". */
  fs?: boolean;
  /** Filesystem root for fs + watch handlers. Default: process.cwd(). */
  cwd?: string;
  /**
   * Site name for JWT validation. Required when any auth-gated group
   * (`adminProtocol`, `watch`, or `fs`) is enabled.
   */
  site?: string;
  /** Watch handler's loopback meta-info port resolver. Default: () => 5173. */
  getPort?: () => number;
  /**
   * Lazily create + bind a chokidar watcher on the first /watch or /fs/* request
   * when watch or fs is enabled. Default: true.
   *
   * Set to `false` on the TanStack/Vite path — Vite already provides the watcher
   * via `bindWatcherToChannel`. Two watchers on the same tree work but waste
   * inotify handles.
   */
  manageWatcher?: boolean;
}

interface ResolvedOptions {
  enabled: boolean;
  healthcheck: boolean;
  readiness: boolean;
  adminProtocol: boolean;
  watch: boolean;
  fs: boolean;
  cwd: string;
  site?: string;
  getPort: () => number;
  manageWatcher: boolean;
}

function resolve(opts: DecoAdminRouteOptions): ResolvedOptions {
  const isProd = process.env.NODE_ENV === "production";
  const resolved: ResolvedOptions = {
    enabled: opts.enabled ?? true,
    healthcheck: opts.healthcheck ?? true,
    readiness: opts.readiness ?? true,
    adminProtocol: opts.adminProtocol ?? true,
    watch: opts.watch ?? !isProd,
    fs: opts.fs ?? !isProd,
    cwd: opts.cwd ?? process.cwd(),
    site: opts.site,
    getPort: opts.getPort ?? (() => 5173),
    manageWatcher: opts.manageWatcher ?? true,
  };
  const authGroupActive =
    resolved.enabled && (resolved.adminProtocol || resolved.watch || resolved.fs);
  if (authGroupActive && !resolved.site) {
    throw new Error(
      "createDecoAdminRoute: `site` is required when adminProtocol, watch, or fs is enabled.",
    );
  }
  return resolved;
}

/**
 * Compose a Web-standard handler for the daemon's full route surface.
 *
 * Each route group can be independently toggled. Disabled groups short-circuit
 * to 404 — callers can't distinguish a disabled deploy from one that never had
 * the route, which keeps the surface honest.
 */
// Lazy chokidar singleton keyed by cwd — created on the first /watch or /fs/*
// request when manageWatcher is enabled. Module-level so two `createDecoAdminRoute`
// calls in the same process share a watcher per cwd.
const watcherSingletons = new Map<string, Promise<{ close: () => Promise<void> }>>();

async function ensureWatcher(cwd: string): Promise<void> {
  if (watcherSingletons.has(cwd)) return;
  // Dynamic import keeps chokidar out of the synchronous module graph for
  // callers that only need probes (e.g. production builds).
  const promise = import("./watcher").then(({ createDecoWatcher }) =>
    createDecoWatcher(cwd),
  );
  watcherSingletons.set(cwd, promise);
  await promise;
}

export function createDecoAdminRoute(
  opts: DecoAdminRouteOptions = {},
): (req: Request) => Promise<Response> {
  const cfg = resolve(opts);
  const watcherNeeded =
    cfg.manageWatcher &&
    (cfg.watch || cfg.fs) &&
    process.env.NODE_ENV !== "production";

  return async (req: Request): Promise<Response> => {
    if (!cfg.enabled) return notFound();
    const { pathname } = new URL(req.url);

    // Probes — no auth.
    if (pathname === "/_healthcheck") {
      return cfg.healthcheck ? handleDecoHealthcheck() : notFound();
    }
    if (pathname === "/_ready") {
      return cfg.readiness ? handleDecoReadiness() : notFound();
    }

    // Volumes — TanStack-only (WebSocket). Next-style returns 501.
    if (pathname.includes("/volumes/") && pathname.includes("/files")) {
      if (!cfg.adminProtocol) return notFound();
      return new Response(
        "Volumes WebSocket is not supported in the Next adapter. " +
          "Use the TanStack/Vite daemon for /volumes/<id>/files.",
        { status: 501, headers: { "Content-Type": "text/plain" } },
      );
    }

    // Dev tooling — auth-gated.
    if (pathname === "/_watch" || pathname === "/watch") {
      if (!cfg.watch) return notFound();
      const guard = await requireAdminJwt(req, cfg.site!);
      if (guard) return guard;
      if (watcherNeeded) await ensureWatcher(cfg.cwd);
      return handleWatchSse(req, { cwd: cfg.cwd, getPort: cfg.getPort });
    }

    if (pathname.startsWith("/fs/")) {
      if (!cfg.fs) return notFound();
      const guard = await requireAdminJwt(req, cfg.site!);
      if (guard) return guard;
      if (watcherNeeded) await ensureWatcher(cfg.cwd);
      return handleFsRequest(req, { cwd: cfg.cwd });
    }

    // Admin protocol — handlers self-authenticate today (see src/core/admin/*).
    if (cfg.adminProtocol) {
      if (pathname === "/live/_meta") return handleMeta(req);
      if (pathname === "/.decofile") {
        return req.method === "POST" ? handleDecofileReload(req) : handleDecofileRead();
      }
      if (pathname === "/deco/render" || pathname.startsWith("/live/previews/")) {
        return handleRender(req);
      }
      if (pathname === "/deco/invoke" || pathname.startsWith("/deco/invoke/")) {
        return handleInvoke(req);
      }
    }

    return notFound();
  };
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}
```

- [ ] **Step 10.4: Run the test (expect pass)**

Run: `bunx vitest run src/node/daemon/route.test.ts`
Expected: PASS (all 10 cases).

- [ ] **Step 10.5: Commit**

```bash
git add src/node/daemon/route.ts src/node/daemon/route.test.ts
git commit -m "feat(node/daemon): createDecoAdminRoute dispatcher

Single Web-standard entry point composing all daemon handlers behind
configurable route-group flags. Defaults dev tooling (watch, fs) to off
in production; throws at construction if an auth-gated group is enabled
without a site name.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 11: Public barrel + package export

**Files:**
- Create: `src/node/daemon/index.ts`
- Modify: `package.json` (add `./node/daemon` export)

- [ ] **Step 11.1: Create the barrel**

`src/node/daemon/index.ts`:
```ts
/**
 * @decocms/start/node/daemon — Web-standard daemon handlers.
 *
 * Node-only (depends on `node:fs/promises`, `chokidar`, `fast-json-patch`).
 * Consumed by both `@decocms/start/next` (directly) and
 * `@decocms/start/tanstack/daemon` (via `toNodeMiddleware` for Vite).
 */
export { handleDecoHealthcheck } from "./healthcheck";
export { handleDecoReadiness } from "../../core/admin/readiness";
export { ADMIN_COMPAT_VERSION } from "../../core/admin/version";
export { requireAdminJwt } from "./auth";
export { verifyAdminJwt, tokenIsValid } from "./jwt";
export type { JwtPayload } from "./jwt";
export { handleFsRequest } from "./fs";
export type { FsHandlerOptions } from "./fs";
export {
  broadcastFsEvent,
  subscribeFsEvents,
  inferMetadata,
  scanDecoFiles,
  type FsEvent,
  type Metadata,
} from "./watch";
export { handleWatchSse } from "./watch-sse";
export type { WatchSseOptions } from "./watch-sse";
export { createDecoWatcher, bindWatcherToChannel } from "./watcher";
export type { DecoWatcher } from "./watcher";
export { createDecoAdminRoute } from "./route";
export type { DecoAdminRouteOptions } from "./route";
export { toNodeMiddleware } from "./nodeHttpAdapter";
export type { WebHandler } from "./nodeHttpAdapter";
```

- [ ] **Step 11.2: Add the package export**

Edit `package.json`. Locate the existing `"./node"` block in `exports`:
```json
    "./node": {
      "types": "./dist/node/index.d.ts",
      "import": "./dist/node/index.js",
      "require": "./dist/node/index.cjs"
    },
```

Insert immediately after (preserving JSON validity — comma after the new block):
```json
    "./node/daemon": {
      "types": "./dist/node/daemon/index.d.ts",
      "import": "./dist/node/daemon/index.js",
      "require": "./dist/node/daemon/index.cjs"
    },
```

- [ ] **Step 11.3: Verify typecheck + tests**

Run:
```bash
bun run typecheck
bunx vitest run src/node/daemon/
```
Expected: PASS.

- [ ] **Step 11.4: Commit**

```bash
git add src/node/daemon/index.ts package.json
git commit -m "feat(pkg): export @decocms/start/node/daemon

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — TanStack refactor

### Task 12: Refactor `createDaemonMiddleware` to compose the shared core

**Files:**
- Modify: `src/tanstack/daemon/middleware.ts`
- Create: `src/tanstack/daemon/middleware.test.ts`

- [ ] **Step 12.1: Write the integration test**

`src/tanstack/daemon/middleware.test.ts`:
```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDaemonMiddleware } from "./middleware";

describe("createDaemonMiddleware (integration)", () => {
  let httpServer: ReturnType<typeof createServer>;
  let url: string;
  const noopWatcher = { on: () => undefined };

  beforeEach(async () => {
    const middleware = createDaemonMiddleware({
      site: "my-site",
      server: { httpServer: null, watcher: noopWatcher },
    });
    httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      middleware(req, res, () => {
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise<void>((r) => httpServer.listen(0, r));
    url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => httpServer.close(() => r())));

  it("serves /_healthcheck without auth", async () => {
    const r = await fetch(url + "/_healthcheck");
    expect(r.status).toBe(200);
    expect((await r.text()).length).toBeGreaterThan(0);
  });

  it("serves /_ready without auth", async () => {
    const r = await fetch(url + "/_ready");
    expect([200, 503]).toContain(r.status);
  });

  it("returns 401 for /fs/file/anything without a token", async () => {
    process.env.DANGEROUSLY_ALLOW_PUBLIC_ACCESS = "";
    const r = await fetch(url + "/fs/file/.deco/anything", {
      headers: { "x-daemon-api": "true" },
    });
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 12.2: Run the test (expect failure)**

Run: `bunx vitest run src/tanstack/daemon/middleware.test.ts`
Expected: at least one assertion fails (current middleware does not serve `/_ready` or treat `/_healthcheck` via shared route).

- [ ] **Step 12.3: Replace `src/tanstack/daemon/middleware.ts`**

Replace the entire file with the version below. It keeps the public signature, the existing `x-daemon-api` gating, and the volumes WebSocket binding intact, but delegates all HTTP-shape routes (probes + fs + watch + admin protocol) to `createDecoAdminRoute` via `toNodeMiddleware`.

```ts
/**
 * Daemon middleware — Connect-style entry point used by Vite's middleware
 * stack.
 *
 * All HTTP-shape routes (probes, fs, watch, admin protocol) are composed by
 * `createDecoAdminRoute` from `src/node/daemon/route.ts` and wrapped via
 * `toNodeMiddleware`. The volumes WebSocket binding stays in this file
 * because it needs `httpServer.on("upgrade")`, which is not expressible via
 * Request → Response.
 */
import type { IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import { createAuthMiddleware } from "./auth";
import {
  createDecoAdminRoute,
  type DecoAdminRouteOptions,
} from "../../node/daemon/route";
import { toNodeMiddleware } from "../../node/daemon/nodeHttpAdapter";
import { bindWatcherToChannel } from "../../node/daemon/watcher";
import { createVolumesHandler } from "./volumes";

const DAEMON_API_SPECIFIER = "x-daemon-api";
const HYPERVISOR_API_SPECIFIER = "x-hypervisor-api";

export interface DaemonOptions {
  /** Site name for JWT validation. */
  site: string;
  /** Vite dev server instance. */
  server: {
    httpServer: HttpServer | null;
    watcher: { on(event: string, cb: (...args: unknown[]) => void): void };
  };
  /**
   * Optional per-group toggles, forwarded to createDecoAdminRoute.
   * Site is taken from the top-level `site` field; the watch port defaults
   * to the Vite httpServer's bound port.
   */
  routes?: Omit<DecoAdminRouteOptions, "site" | "getPort">;
}

export function createDaemonMiddleware(opts: DaemonOptions) {
  const auth = createAuthMiddleware(opts.site);
  const httpServer = opts.server.httpServer;

  // Volumes still owns its httpServer.on("upgrade") binding — not portable.
  const volumes = httpServer
    ? createVolumesHandler({ httpServer, watcher: opts.server.watcher })
    : null;

  // Vite's watcher feeds the shared broadcast channel.
  bindWatcherToChannel(opts.server.watcher);

  const webRouteHandler = createDecoAdminRoute({
    site: opts.site,
    getPort: () => {
      const addr = httpServer?.address();
      return typeof addr === "object" && addr ? addr.port : 5173;
    },
    // Vite already provides the watcher via `bindWatcherToChannel` above;
    // skip the Next-style lazy chokidar singleton so we don't double-watch.
    manageWatcher: false,
    ...opts.routes,
  });

  const webMiddleware = toNodeMiddleware(async (req) => {
    const { pathname } = new URL(req.url);
    // /_healthcheck is the only daemon route that bypasses x-daemon-api gating
    // (admin uses it before authenticating to verify reachability).
    if (pathname === "/_healthcheck") return webRouteHandler(req);
    // Everything else returns a real Response from createDecoAdminRoute; the
    // null-fallthrough branch is for the volumes paths, which we handle below.
    return webRouteHandler(req);
  });

  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      pathname = req.url ?? "/";
    }

    // Healthcheck — no auth, no x-daemon-api header required.
    if (pathname === "/_healthcheck") {
      webMiddleware(req, res, next);
      return;
    }

    const isDaemonAPI =
      req.headers[DAEMON_API_SPECIFIER] ??
      req.headers[HYPERVISOR_API_SPECIFIER] ??
      false;

    if (!isDaemonAPI) {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.searchParams.get(DAEMON_API_SPECIFIER) !== "true") {
          next();
          return;
        }
      } catch {
        next();
        return;
      }
    }

    // CORS for admin.deco.cx.
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-daemon-api, x-hypervisor-api");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth before any /fs/*, /watch, /volumes/*, admin protocol routes.
    auth(req, res, () => {
      // Volumes API — TanStack-only, requires raw httpServer.
      if (pathname.includes("/volumes/") && pathname.includes("/files") && volumes) {
        volumes(req, res, next);
        return;
      }
      // All other HTTP-shape routes flow through the Web-standard dispatcher.
      webMiddleware(req, res, next);
    });
  };
}
```

- [ ] **Step 12.4: Run all tanstack daemon tests**

Run:
```bash
bunx vitest run src/tanstack/daemon/
```
Expected: PASS (including the new middleware integration tests).

- [ ] **Step 12.5: Run full test suite**

Run: `bunx vitest run`
Expected: PASS — no regressions elsewhere.

- [ ] **Step 12.6: Commit**

```bash
git add src/tanstack/daemon/middleware.ts src/tanstack/daemon/middleware.test.ts
git commit -m "refactor(tanstack/daemon): compose shared Web-standard route handler

createDaemonMiddleware delegates probes, fs, watch, and admin-protocol
dispatch to createDecoAdminRoute via toNodeMiddleware. Volumes WebSocket
binding stays in-place because it requires raw httpServer access. Public
signature unchanged; new optional routes field forwards group toggles.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 6 — Next adapter

### Task 13: Refactor `src/next/adminRoute.ts` to use the shared dispatcher

**Files:**
- Modify: `src/next/adminRoute.ts`
- Modify: `src/next/adminRoute.test.ts` (extend coverage)

- [ ] **Step 13.1: Extend the test**

Append to `src/next/adminRoute.test.ts`:
```ts
import { afterEach, beforeEach } from "vitest";

describe("handleDecoAdminRoute — extended dispatch", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  beforeEach(() => {
    delete process.env.NODE_ENV;
    process.env.DECO_SITE = "my-site";
  });
  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    delete process.env.DECO_SITE;
  });

  it("serves /_healthcheck", async () => {
    const res = await handleDecoAdminRoute(new Request("http://t/_healthcheck"));
    expect(res.status).toBe(200);
  });

  it("serves /_ready", async () => {
    const res = await handleDecoAdminRoute(new Request("http://t/_ready"));
    expect([200, 503]).toContain(res.status);
  });

  it("returns 501 for /volumes/<id>/files", async () => {
    const res = await handleDecoAdminRoute(new Request("http://t/volumes/abc/files"));
    expect(res.status).toBe(501);
  });

  it("disables /_watch in production", async () => {
    process.env.NODE_ENV = "production";
    const res = await handleDecoAdminRoute(new Request("http://t/_watch"));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 13.2: Replace `src/next/adminRoute.ts`**

Replace the existing file. The JSDoc gets the escape-rule fix; the implementation defers entirely to `createDecoAdminRoute`. Paste:

```ts
import {
  createDecoAdminRoute,
  type DecoAdminRouteOptions,
} from "../node/daemon/route";

/**
 * Dispatch a Next.js App Router request to the appropriate Deco daemon handler.
 *
 * Mount as both GET and POST in dedicated route files under your `app/` tree.
 * Next App Router needs escaped folder names because it treats `_folder` as
 * private and excludes it from routing:
 *
 *   app/
 *   ├── %5Fhealthcheck/route.ts     (literal %5F — Next/Turbopack do not URL-decode this)
 *   ├── %5Fready/route.ts
 *   ├── %5Fwatch/route.ts
 *   ├── .decofile/route.ts           (literal `.`, not %2E — Turbopack does not decode %2E)
 *   ├── live/
 *   │   ├── %5Fmeta/route.ts
 *   │   └── previews/[[...path]]/route.ts
 *   ├── deco/
 *   │   ├── render/route.ts
 *   │   └── invoke/[[...path]]/route.ts
 *   └── fs/file/[[...path]]/route.ts
 *
 * Each route file is two lines:
 *
 *   export const dynamic = "force-dynamic";
 *   export { GET, POST } from "@/lib/deco-admin";  // ← your config module
 *
 * Where `@/lib/deco-admin` instantiates a single configuration:
 *
 *   import { createDecoAdminRouteHandlers } from "@decocms/start/next";
 *   export const { GET, POST } = createDecoAdminRouteHandlers({ site: "my-site" });
 *
 * For one-off mounting without a config module, `handleDecoAdminRoute` is the
 * pre-instantiated default. It reads `DECO_SITE` from the environment for JWT
 * validation; if you need richer options, use `createDecoAdminRoute` or
 * `createDecoAdminRouteHandlers`.
 *
 * Disabled groups return 404 (looks like the route doesn't exist).
 * `/volumes/<id>/files` returns 501 — the WebSocket flow is TanStack-only.
 */
// Lazy construction so a consumer importing this module without
// `DECO_SITE` set yet (e.g. before .env load completes in some setups)
// does not crash at import time — the auth-gated `adminProtocol` group
// defaults on and would throw from `createDecoAdminRoute`.
let _handler: ((req: Request) => Promise<Response>) | null = null;
function getDefaultHandler(): (req: Request) => Promise<Response> {
  if (!_handler) {
    _handler = createDecoAdminRoute({ site: process.env.DECO_SITE });
  }
  return _handler;
}

export const handleDecoAdminRoute: (req: Request) => Promise<Response> = (req) =>
  getDefaultHandler()(req);

export { createDecoAdminRoute };
export type { DecoAdminRouteOptions };
```

- [ ] **Step 13.3: Run the Next adapter tests**

Run: `bunx vitest run src/next/adminRoute.test.ts`
Expected: PASS (existing two + extended four).

- [ ] **Step 13.4: Commit**

```bash
git add src/next/adminRoute.ts src/next/adminRoute.test.ts
git commit -m "refactor(next): handleDecoAdminRoute composes shared dispatcher

Brings probes, watch, fs, and the corrected route-mounting JSDoc into the
Next adapter without duplicating logic. handleDecoAdminRoute is now a
pre-instantiated createDecoAdminRoute that reads DECO_SITE.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 14: `createDecoAdminRouteHandlers` convenience factory

**Files:**
- Create: `src/next/routeHandlers.ts`
- Create: `src/next/routeHandlers.test.ts`

- [ ] **Step 14.1: Write the test**

`src/next/routeHandlers.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createDecoAdminRouteHandlers, decoAdminRouteHandlers } from "./routeHandlers";

describe("createDecoAdminRouteHandlers", () => {
  it("returns identical handlers for GET and POST that delegate to the dispatcher", async () => {
    const { GET, POST } = createDecoAdminRouteHandlers({ site: "my-site" });
    const a = await GET(new Request("http://t/_healthcheck"));
    const b = await POST(new Request("http://t/_healthcheck"));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it("decoAdminRouteHandlers is the default-options instance", async () => {
    process.env.DECO_SITE = "my-site";
    const res = await decoAdminRouteHandlers.GET(new Request("http://t/_healthcheck"));
    expect(res.status).toBe(200);
    delete process.env.DECO_SITE;
  });
});
```

- [ ] **Step 14.2: Run the test (expect failure)**

Run: `bunx vitest run src/next/routeHandlers.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 14.3: Implement**

`src/next/routeHandlers.ts`:
```ts
import {
  createDecoAdminRoute,
  type DecoAdminRouteOptions,
} from "../node/daemon/route";

export interface DecoAdminRouteHandlers {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
}

/**
 * Build a `{ GET, POST }` pair suitable for one-line `export` from every
 * App Router route file under your `app/` tree. Instantiate once in a shared
 * module and re-export from each route file.
 *
 * @example
 * // app/lib/deco-admin.ts
 * import { createDecoAdminRouteHandlers } from "@decocms/start/next";
 * export const { GET, POST } = createDecoAdminRouteHandlers({ site: "my-site" });
 *
 * // app/%5Fhealthcheck/route.ts
 * export const dynamic = "force-dynamic";
 * export { GET, POST } from "@/lib/deco-admin";
 */
export function createDecoAdminRouteHandlers(
  opts: DecoAdminRouteOptions = {},
): DecoAdminRouteHandlers {
  const handler = createDecoAdminRoute(opts);
  return { GET: handler, POST: handler };
}

/**
 * Pre-instantiated handlers using all defaults (reads `DECO_SITE` from env).
 * Use this only for the simplest setup — most apps will call
 * `createDecoAdminRouteHandlers` to lock options at the call site.
 *
 * Implemented lazily so importing this module without `DECO_SITE` set yet
 * does not crash at import time.
 */
let _defaultHandlers: DecoAdminRouteHandlers | null = null;
function getDefaultHandlers(): DecoAdminRouteHandlers {
  if (!_defaultHandlers) {
    _defaultHandlers = createDecoAdminRouteHandlers({ site: process.env.DECO_SITE });
  }
  return _defaultHandlers;
}

export const decoAdminRouteHandlers: DecoAdminRouteHandlers = {
  GET: (req) => getDefaultHandlers().GET(req),
  POST: (req) => getDefaultHandlers().POST(req),
};
```

- [ ] **Step 14.4: Run the test (expect pass)**

Run: `bunx vitest run src/next/routeHandlers.test.ts`
Expected: PASS.

- [ ] **Step 14.5: Commit**

```bash
git add src/next/routeHandlers.ts src/next/routeHandlers.test.ts
git commit -m "feat(next): createDecoAdminRouteHandlers convenience factory

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 15: Update `src/next/index.ts` exports

**Files:**
- Modify: `src/next/index.ts`

- [ ] **Step 15.1: Replace the file**

`src/next/index.ts`:
```ts
/**
 * @decocms/start/next — Next.js App Router adapter.
 *
 * App Router only. Pages Router not supported.
 */
export { loadCmsPage } from "./loadCmsPage";
export { buildMatcherContextFromNext } from "./ctx";
export {
  createDecoAdminRoute,
  handleDecoAdminRoute,
  type DecoAdminRouteOptions,
} from "./adminRoute";
export {
  createDecoAdminRouteHandlers,
  decoAdminRouteHandlers,
  type DecoAdminRouteHandlers,
} from "./routeHandlers";
export { DecoPage } from "./DecoPage";

// Probe handlers — re-exported so consumers can mount a single route file
// without the full dispatcher.
export { handleDecoHealthcheck } from "../node/daemon/healthcheck";
export { handleDecoReadiness } from "../core/admin/readiness";
export { ADMIN_COMPAT_VERSION } from "../core/admin/version";
```

- [ ] **Step 15.2: Typecheck + full test run**

Run:
```bash
bun run typecheck
bunx vitest run
```
Expected: PASS — no regressions.

- [ ] **Step 15.3: Commit**

```bash
git add src/next/index.ts
git commit -m "feat(next): expose new admin coverage surface from the barrel

Adds createDecoAdminRoute, createDecoAdminRouteHandlers, decoAdminRouteHandlers,
handleDecoHealthcheck, handleDecoReadiness, ADMIN_COMPAT_VERSION, and the
related types.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 7 — Documentation + final verification

### Task 16: Rewrite `docs/using-from-nextjs.md`

**Files:**
- Modify: `docs/using-from-nextjs.md`

- [ ] **Step 16.1: Replace the file**

`docs/using-from-nextjs.md`:
```markdown
# Using @decocms/start from Next.js (App Router)

`@decocms/start` ships a first-party Next.js adapter at `@decocms/start/next`. App Router only.

## Install

```bash
bun add @decocms/start
# Required peer dependencies (you almost certainly already have these in a Next 15/16 app)
bun add next@^15 react@^19 react-dom@^19
```

`tsconfig.json` must use `moduleResolution: "bundler"` (the Next 15+ default).

## Configure

No `transpilePackages` in `next.config.js` is needed — the package ships compiled JavaScript.

Set `DECO_SITE=<your-site>` in your environment so the admin protocol routes can validate JWTs from `admin.deco.cx`.

## Render a CMS page from a route

```tsx
// app/[[...path]]/page.tsx
import { loadCmsPage } from "@decocms/start/next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

export default async function Page() {
  const h = await headers();
  const url = new URL(h.get("x-url") ?? `http://localhost${h.get("x-pathname") ?? "/"}`);
  const reqHeaders = new Headers();
  h.forEach((value, key) => reqHeaders.set(key, value));
  const req = new Request(url, { headers: reqHeaders });

  const result = await loadCmsPage(req);
  if (!result) notFound();

  return <YourSectionsRenderer result={result} />;
}
```

Populate `x-url` / `x-pathname` from a Next middleware:

```ts
// middleware.ts
import { NextResponse } from "next/server";
export function middleware(req: Request) {
  const res = NextResponse.next();
  res.headers.set("x-url", req.url);
  res.headers.set("x-pathname", new URL(req.url).pathname);
  return res;
}
export const config = { matcher: ["/((?!_next).*)"] };
```

## Wire admin protocol routes

The Deco admin UI talks to your storefront via:

- `/_healthcheck`, `/_ready` — hosting probes
- `/live/_meta`, `/.decofile`, `/live/previews/*`, `/deco/render`, `/deco/invoke/*` — admin protocol
- `/_watch`, `/fs/*` — dev-time admin editor (auto-disabled in production)

**Do not mount a single root-level catchall.** Earlier versions of these docs recommended `app/(deco-admin)/[...path]/route.ts`, which intercepts every non-root request in your app and breaks any storefront with pages at `/products`, `/cart`, etc. Use dedicated route files instead.

### One config module + dedicated route files

App Router treats `_folder` as a *private folder* and excludes it from routing, so daemon paths starting with `_` need to be escaped in the folder name. Turbopack does not URL-decode `%2E`, so `.`-prefixed folders must use a literal dot. The exact layout that works:

```
app/
├── lib/
│   └── deco-admin.ts
├── %5Fhealthcheck/route.ts
├── %5Fready/route.ts
├── %5Fwatch/route.ts
├── .decofile/route.ts                 (literal . — NOT %2E)
├── live/
│   ├── %5Fmeta/route.ts
│   └── previews/[[...path]]/route.ts
├── deco/
│   ├── render/route.ts
│   └── invoke/[[...path]]/route.ts
└── fs/file/[[...path]]/route.ts
```

Instantiate the dispatcher once:

```ts
// app/lib/deco-admin.ts
import { createDecoAdminRouteHandlers } from "@decocms/start/next";

export const { GET, POST } = createDecoAdminRouteHandlers({
  site: "my-site",
  // Optional — defaults shown:
  //   enabled: true
  //   healthcheck: true
  //   readiness: true
  //   adminProtocol: true
  //   watch: NODE_ENV !== "production"
  //   fs: NODE_ENV !== "production"
  //   cwd: process.cwd()
});
```

Then every route file is two lines:

```ts
// app/%5Fhealthcheck/route.ts (and every other route file above)
export const dynamic = "force-dynamic";
export { GET, POST } from "@/lib/deco-admin";
```

### Disabling specific routes

Each group has its own flag:

```ts
export const { GET, POST } = createDecoAdminRouteHandlers({
  site: "my-site",
  watch: false,             // disable dev-time SSE even in dev
  fs: false,                // disable dev-time filesystem REST
  adminProtocol: false,     // disable admin editing entirely against this deploy
});
```

Disabled groups return 404 — callers cannot distinguish a disabled deploy from one that never had the route.

## Register sections

At app boot (before any request handler runs):

```ts
// src/sections/registry.ts
import { registerSectionsSync, setBlocks } from "@decocms/start/cms";
import * as MyHero from "./MyHero";
import blocks from "../.deco/blocks/site.json";

setBlocks(blocks);
registerSectionsSync({
  "site/sections/MyHero.tsx": MyHero.default,
});
```

Import this from `app/layout.tsx` (or any module that runs at boot) so it executes before any page renders.

## Limitations

- App Router only. Pages Router is not supported.
- `/volumes/<id>/files` (WebSocket) is **not** supported — it requires `httpServer.on("upgrade")`, which Next App Router does not expose. Calls to that path return 501. Use the TanStack/Vite daemon if you need volumes.
- The minimal `DecoPage` server component is a starting point; production renderers should provide their own.
- `@decocms/start/next/client` exports only `useDevice` and `signal`. The TanStack-specific hooks (`LiveControls`, `LazySection`) are not yet ported.
```

- [ ] **Step 16.2: Commit**

```bash
git add docs/using-from-nextjs.md
git commit -m "docs(next): rewrite App Router integration guide with correct route layout

Removes the broken single-catchall recipe and replaces it with the
escaped-folder layout that survives Next App Router's _folder privacy rule
and Turbopack's %2E behaviour. Documents the createDecoAdminRouteHandlers
config pattern and the per-group toggles.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 17: Final verification

**Files:** none (all verification commands).

- [ ] **Step 17.1: Full typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 17.2: Full test suite**

Run: `bunx vitest run`
Expected: PASS.

- [ ] **Step 17.3: Build + tier-boundary check**

Run: `bun run build`
Expected: builds successfully; the `scripts/check-tier-boundaries.ts` post-build step (if wired into `build`) reports zero violations. If the tier check is run separately, run it explicitly:
```bash
bun run scripts/check-tier-boundaries.ts
```
Expected: zero violations. `next/` files do not import from `tanstack/`; `tanstack/` files do not import from `next/`; `core/` is clean of `@tanstack/*`, `next`, `node:async_hooks`, and Node-only modules.

- [ ] **Step 17.4: Smoke-check the package exports**

Run:
```bash
node -e "console.log(Object.keys(require('./dist/next/index.cjs')))"
```
Expected output (set; order may vary):
```
[
  'loadCmsPage',
  'buildMatcherContextFromNext',
  'createDecoAdminRoute',
  'handleDecoAdminRoute',
  'createDecoAdminRouteHandlers',
  'decoAdminRouteHandlers',
  'DecoPage',
  'handleDecoHealthcheck',
  'handleDecoReadiness',
  'ADMIN_COMPAT_VERSION'
]
```

```bash
node -e "console.log(Object.keys(require('./dist/node/daemon/index.cjs')))"
```
Expected: at minimum `handleDecoHealthcheck`, `handleDecoReadiness`, `requireAdminJwt`, `verifyAdminJwt`, `tokenIsValid`, `handleFsRequest`, `handleWatchSse`, `createDecoAdminRoute`, `toNodeMiddleware`, `createDecoWatcher`, `bindWatcherToChannel`, `broadcastFsEvent`, `subscribeFsEvents`, `inferMetadata`, `scanDecoFiles`, `ADMIN_COMPAT_VERSION`.

- [ ] **Step 17.5: Changelog entry**

Append to `CHANGELOG.md` (or wherever the project records release notes — confirm with `ls CHANGELOG*`). The release tooling is semantic-release, so the canonical place to surface this is the merge commit + the conventional-commits-derived notes; if there's no manual CHANGELOG, skip this step. If one exists, add:

```markdown
## Unreleased

### Added
- `@decocms/start/next`: `handleDecoHealthcheck`, `handleDecoReadiness`, `createDecoAdminRoute`, `createDecoAdminRouteHandlers`, `decoAdminRouteHandlers`, `ADMIN_COMPAT_VERSION`.
- `@decocms/start/node/daemon`: new export surface for the framework-neutral, Web-standard daemon handlers (`handleFsRequest`, `handleWatchSse`, `requireAdminJwt`, `createDecoAdminRoute`, `toNodeMiddleware`, `createDecoWatcher`, `bindWatcherToChannel`, …).
- Per-group route toggles via `DecoAdminRouteOptions` on both adapters. Dev tooling (`/_watch`, `/fs/*`) defaults to off in production.

### Changed
- The Next.js admin route layout documented in `docs/using-from-nextjs.md` was rewritten. The previous single-catchall recipe (`app/(deco-admin)/[...path]/route.ts`) intercepts non-admin requests and is incorrect — migrate to dedicated route files under escaped folder names.
- `src/tanstack/daemon/middleware.ts` now composes the Web-standard handlers from `src/node/daemon/` via `toNodeMiddleware`. Public signature unchanged; new optional `routes` field forwards per-group toggles.
- `ADMIN_COMPAT_VERSION` (formerly inline in `src/tanstack/daemon/middleware.ts`) is now `src/core/admin/version.ts`. Still pinned to the deco-cx/deco 1.177.x range — does NOT track `@decocms/start`'s own version.

### Not changed
- `/volumes/<id>/files` (WebSocket) remains TanStack-only; calls through the Next adapter return 501.
```

- [ ] **Step 17.6: Commit changelog (if it exists)**

```bash
git add CHANGELOG.md   # only if the file exists and was modified
git commit -m "docs(changelog): record next adapter admin coverage release

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 17.7: Final visual diff against `origin/next`**

Run:
```bash
git log --oneline origin/next..HEAD
git diff --stat origin/next..HEAD
```
Expected: linear history of 17 commits (one per task), no stray files.

---

## Acceptance criteria (mirrors the spec)

- [ ] `ADMIN_COMPAT_VERSION` defined in `src/core/admin/version.ts` with pinning JSDoc and consumed by both adapters.
- [ ] `handleDecoHealthcheck` exported from `@decocms/start/next` and `@decocms/start/node/daemon`, returning `ADMIN_COMPAT_VERSION` with CORS.
- [ ] `handleDecoReadiness` exported from both adapters; 503/200 against `getRevision()`.
- [ ] `createDecoAdminRoute` and `createDecoAdminRouteHandlers` exported from `@decocms/start/next` with the full options shape.
- [ ] `createDaemonMiddleware` accepts the same options under `routes`; existing TanStack consumers see no behaviour change without supplying `routes`.
- [ ] `/_watch` (SSE) and `/fs/*` work in Next dev, are 404 in Next prod, and continue to work in TanStack dev.
- [ ] `/volumes/<id>/files` returns 501 from the Next adapter; unchanged on the TanStack side.
- [ ] `src/next/adminRoute.ts` JSDoc updated with the escaped-folder layout and the `%5F` / literal-`.` rules.
- [ ] `docs/using-from-nextjs.md` rewritten with the escaped-folder layout and the `createDecoAdminRouteHandlers` pattern.
- [ ] Tier-boundary check passes; `next/` does not import from `tanstack/`.
- [ ] Integration tests in place (TanStack daemon end-to-end; Next adapter probes, `/_watch`, `/fs/file/...`).
- [ ] Changelog entry (if applicable).
