# Next.js adapter — full admin protocol + shared daemon refactor

**Status:** design, awaiting approval
**Author:** brainstorming session 2026-05-13
**Scope:** close the gaps between `src/next/` and `src/tanstack/` admin coverage by refactoring the daemon to a Web-standard core shared by both adapters.

## Problem

Consumers wiring `@decocms/start@5.1.x` into Next 16 / App Router / Turbopack storefronts hit three gaps:

1. **No hosting probes in the Next adapter.** `/_healthcheck` and `/_ready` exist only on the TanStack side (inline in `src/tanstack/daemon/middleware.ts`), so Next consumers have no version-pinned alive/ready signal for k8s, Cloud Run, or our own infra.
2. **Broken route-mounting guidance.** The JSDoc on `handleDecoAdminRoute` recommends `app/live/_meta/route.ts` and `app/.decofile/route.ts`. Next App Router treats `_folder` as private and excludes it from routing; `%2E…` is not decoded by Turbopack. The escape path is `app/live/%5Fmeta/route.ts` (literal `%5F`) and `app/.decofile/route.ts` (literal dot, not `%2E`). The current `docs/using-from-nextjs.md` proposes a single root-level catchall, which intercepts every non-root request and breaks any storefront with non-root pages.
3. **No `/watch` or `/fs/*` story.** The Vite/TanStack daemon ships an SSE file-change channel and a JSON-patch filesystem API, both required for admin's in-browser editor against a dev environment. Next consumers cannot run those today.

Underneath these three is a structural problem: the daemon's handlers are Connect-style (`IncomingMessage`, `ServerResponse`, `next`) and live in `src/tanstack/daemon/`. The tier-boundary checker (`scripts/check-tier-boundaries.ts:138`) forbids `next/` from importing `tanstack/`. Any port to Next means either duplicating logic, violating tiers, or refactoring the shared core to a framework-neutral home.

## Architectural decisions

1. **Refactor the daemon's request handlers to Web-standard (`Request → Response`).** The Connect-style signatures are an artefact of plugging into Vite's middleware stack, which is the only place in our stack that doesn't speak Web-standard natively. Next App Router, TanStack production (Nitro/H3), and Cloudflare Workers all speak Web-standard directly.
2. **Place the shared core in a new `src/node/daemon/` tier.** Node-only because the handler bodies use `node:fs/promises` and `chokidar`. The public contract is Web-standard. Both `src/tanstack/daemon/` and `src/next/` consume it. `src/node/` is already an existing tier (today's `loadAllDecofileBlocks`); the tier-boundary checker does not treat `node/` as a restricted tier, so `next/ → node/` and `tanstack/ → node/` are both allowed.
3. **Ship a one-file Node-http adapter for Vite.** `src/node/daemon/nodeHttpAdapter.ts` converts a `(req: Request) => Promise<Response>` handler into Connect-style `(req, res, next)` middleware. One file, one caller (`src/tanstack/daemon/middleware.ts`).
4. **Pin the admin compatibility version explicitly.** The constant currently inline at `src/tanstack/daemon/middleware.ts:62-64` is intentionally decoupled from `package.json` — admin compares against deco-cx/deco's `1.177.x` range, not `@decocms/start`'s `5.x`. The new shared constant lives at `src/core/admin/version.ts` as `ADMIN_COMPAT_VERSION`, with a JSDoc explaining the pinning contract.
5. **Toggle daemon route groups via configuration.** Hosting probes, the admin protocol, and dev tooling each have their own enable flag. Dev tooling defaults to `NODE_ENV !== "production"`; the rest default on. A `enabled: false` master switch short-circuits everything to 404. Disabled routes return 404 (not 403/410) so callers cannot distinguish a disabled deploy from a deploy that never had the route.
6. **Volumes WebSocket stays TanStack-only.** `/volumes/<id>/files` requires `httpServer.on("upgrade")`, which Next App Router does not expose. Next's dispatcher returns 501 with a doc-link body for that path.

## Tier and module layout

```
src/core/admin/
├── version.ts          NEW   ADMIN_COMPAT_VERSION = "1.177.5"
└── readiness.ts        NEW   handleDecoReadiness(): Response

src/node/daemon/        NEW TIER — Web-standard interfaces, Node-only bodies
├── jwt.ts                    verifyAdminJwt, tokenIsValid (moved verbatim from src/tanstack/daemon/auth.ts)
├── auth.ts                   requireAdminJwt(req, site): Promise<Response | null>
├── healthcheck.ts            handleDecoHealthcheck(): Response (consumes ADMIN_COMPAT_VERSION)
├── fs.ts                     handleFsRequest(req, opts): Promise<Response>
├── watch.ts                  handleWatchSse(req, opts): Response
│                             createBroadcastChannel(): { broadcast, subscribe }
├── watcher.ts                createDecoWatcher(cwd): { watcher, close }
├── nodeHttpAdapter.ts        toNodeMiddleware(handler): ConnectStyle
├── route.ts                  createDecoAdminRoute(opts): (req: Request) => Promise<Response>
└── index.ts

src/tanstack/daemon/    SHRUNK — composes node/daemon handlers via toNodeMiddleware
├── middleware.ts             createDaemonMiddleware: extended options object, internally uses createDecoAdminRoute
├── auth.ts                   re-exports from node/daemon/jwt + auth (back-compat)
├── volumes.ts                UNCHANGED (TanStack-only, raw httpServer upgrade)
├── watch.ts                  thin shim re-exporting from node/daemon/watch (back-compat)
├── fs.ts                     thin shim re-exporting from node/daemon/fs (back-compat)
└── index.ts                  same surface as today

src/next/
├── adminRoute.ts             handleDecoAdminRoute = createDecoAdminRoute() (default opts)
│                             createDecoAdminRouteHandlers(opts) → { GET, POST }
│                             decoAdminRouteHandlers = createDecoAdminRouteHandlers()
├── healthcheck.ts            REMOVED from spec — handleDecoHealthcheck re-exported from index instead
└── index.ts                  re-exports handleDecoHealthcheck, handleDecoReadiness, createDecoAdminRoute*
```

## Public API

### `@decocms/start/next`

```ts
export interface DecoAdminRouteOptions {
  enabled?: boolean;                  // default: true
  healthcheck?: boolean;              // default: true
  readiness?: boolean;                // default: true
  adminProtocol?: boolean;            // default: true
  watch?: boolean;                    // default: NODE_ENV !== "production"
  fs?: boolean;                       // default: NODE_ENV !== "production"
  cwd?: string;                       // default: process.cwd()
  site?: string;                      // required when any auth-gated group is enabled
}

// Existing
export { loadCmsPage, buildMatcherContextFromNext, DecoPage } from "./...";

// Updated (signature unchanged, behavior extended)
export const handleDecoAdminRoute: (req: Request) => Promise<Response>;

// New
export function createDecoAdminRoute(opts?: DecoAdminRouteOptions): (req: Request) => Promise<Response>;
export function createDecoAdminRouteHandlers(opts?: DecoAdminRouteOptions): {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
};
export const decoAdminRouteHandlers: { GET; POST };  // = createDecoAdminRouteHandlers()
export { handleDecoHealthcheck } from "../node/daemon/healthcheck";
export { handleDecoReadiness } from "../core/admin/readiness";
```

### `@decocms/start/tanstack/daemon` (unchanged surface, extended options)

```ts
export interface DaemonOptions {
  site: string;
  server: { httpServer: HttpServer | null; watcher: { on(event, cb): void } };
  // NEW — same shape as DecoAdminRouteOptions minus `site` (already required above)
  routes?: Omit<DecoAdminRouteOptions, "site">;
}

export function createDaemonMiddleware(opts: DaemonOptions): (req, res, next) => void;
```

### `@decocms/start/node/daemon` (new export, primarily internal but public for advanced consumers)

```ts
export { handleDecoHealthcheck } from "./healthcheck";
export { handleDecoReadiness } from "../../core/admin/readiness";
export { requireAdminJwt } from "./auth";
export { verifyAdminJwt, tokenIsValid } from "./jwt";
export type { JwtPayload } from "./jwt";
export { handleFsRequest } from "./fs";
export { handleWatchSse, createBroadcastChannel, broadcastFsEvent } from "./watch";
export { createDecoWatcher } from "./watcher";
export { createDecoAdminRoute } from "./route";
export { toNodeMiddleware } from "./nodeHttpAdapter";
```

## Route dispatch

`createDecoAdminRoute(opts)` returns a single `(req: Request) => Promise<Response>` that:

1. Parses `new URL(req.url).pathname`.
2. If `opts.enabled === false` → return 404.
3. Matches path against group entries (in declaration order). For each matched group, if the group's flag is `false` → return 404.
4. Calls the matched handler with the original `Request` plus any captured params.
5. If no group matches → return 404.

**Path table:**

| Path | Group | Method | Handler |
|------|-------|--------|---------|
| `/_healthcheck` | `healthcheck` | GET | `handleDecoHealthcheck()` |
| `/_ready` | `readiness` | GET | `handleDecoReadiness()` |
| `/live/_meta` | `adminProtocol` | GET, POST | `handleMeta` |
| `/.decofile` | `adminProtocol` | GET (read), POST (reload) | `handleDecofileRead` / `handleDecofileReload` |
| `/deco/render`, `/live/previews/<...>` | `adminProtocol` | * | `handleRender` |
| `/deco/invoke`, `/deco/invoke/<...>` | `adminProtocol` | * | `handleInvoke` |
| `/watch` | `watch` | GET | `handleWatchSse` |
| `/fs/<path>` | `fs` | GET, PATCH, DELETE | `handleFsRequest` |
| `/volumes/<id>/files` | `adminProtocol` | * | Next: 501; TanStack: existing `volumes` handler |

## Authentication

The admin protocol core handlers (`handleMeta`, `handleDecofileRead`, `handleDecofileReload`, `handleRender`, `handleInvoke`) authenticate internally today — that behaviour is preserved. The new groups gain explicit auth:

- `/_healthcheck` and `/_ready` — **no auth** (hosting probes).
- `/_watch` and `/fs/*` — **auth gated** via `requireAdminJwt(req, opts.site)` before the handler runs. `DANGEROUSLY_ALLOW_PUBLIC_ACCESS=true` bypasses, matching the existing daemon behaviour.

When a group's auth-required handler is invoked without `opts.site` configured, `createDecoAdminRoute` throws at construction time (not at request time) so misconfiguration is caught at boot.

## Handler contracts (Web-standard)

```ts
// healthcheck.ts
export function handleDecoHealthcheck(): Response;
// 200 text/plain ADMIN_COMPAT_VERSION + CORS

// readiness.ts (core/admin/)
export function handleDecoReadiness(): Response;
// 200 text/plain "ready"        when getRevision() !== null
// 503 text/plain "not ready"    when getRevision() === null
// No CORS (intra-cluster probes don't need it).

// auth.ts (node/daemon/)
export async function requireAdminJwt(req: Request, site: string): Promise<Response | null>;
// returns Response (401/403) to short-circuit; null to continue
// honors DANGEROUSLY_ALLOW_PUBLIC_ACCESS=true bypass

// fs.ts
export interface FsHandlerOpts { cwd: string }
export async function handleFsRequest(req: Request, opts: FsHandlerOpts): Promise<Response>;
// GET /fs/file/<path>      → 200 with file body
// PATCH /fs/file/<path>    → applies JSON-patch ops, returns 200 with updated body
// DELETE /fs/file/<path>   → 204
// Refuses traversal (resolved path outside cwd → 400).

// watch.ts
export interface WatchSseOpts {
  channel: { subscribe(listener): () => void };
}
export function handleWatchSse(req: Request, opts: WatchSseOpts): Response;
// 200 text/event-stream — emits initial fs-sync then forwards channel events
// closes on req.signal abort

// watcher.ts
export function createDecoWatcher(cwd: string): {
  watcher: chokidar.FSWatcher;
  close: () => Promise<void>;
};
```

### Next-side watcher lifecycle

Module-level lazy singleton in `src/node/daemon/route.ts`:

```ts
let watcherSingleton: ReturnType<typeof createDecoWatcher> | null = null;
function getWatcherIfEnabled(opts: DecoAdminRouteOptions): { channel } | null {
  if (!opts.watch && !opts.fs) return null;
  if (process.env.NODE_ENV === "production") return null;
  if (!watcherSingleton) {
    watcherSingleton = createDecoWatcher(opts.cwd ?? process.cwd());
    bindToChannel(watcherSingleton.watcher, sharedChannel);
  }
  return { channel: sharedChannel };
}
```

The watcher is created on first request to `/watch` or `/fs/*` and lives for the process lifetime. In production builds, no watcher is ever created, even if a consumer mounts the route files.

### TanStack-side watcher lifecycle (unchanged)

`createDaemonMiddleware` continues to receive Vite's existing watcher via `opts.server.watcher` and binds it to the shared channel. No new chokidar instance is created on the TanStack path.

## Route layout for Next consumers

The current `docs/using-from-nextjs.md` instructs consumers to mount one catch-all at `app/(deco-admin)/[...path]/route.ts`. This is broken: the catchall intercepts every non-root request in the app, and `handleDecoAdminRoute` returns 404 for non-admin paths instead of falling through to a page renderer. Storefronts with pages at `/products`, `/cart`, etc. lose those routes.

The replacement is dedicated route handlers under escaped folder names:

```
app/
├── %5Fhealthcheck/route.ts
├── %5Fready/route.ts
├── %5Fwatch/route.ts
├── .decofile/route.ts            (literal dot — Turbopack does not decode %2E)
├── live/
│   ├── %5Fmeta/route.ts
│   └── previews/[[...path]]/route.ts
├── deco/
│   ├── render/route.ts
│   └── invoke/[[...path]]/route.ts
└── fs/file/[[...path]]/route.ts
```

Each consumer file is two lines:

```ts
// app/%5Fhealthcheck/route.ts
export const dynamic = "force-dynamic";
export { GET } from "@decocms/start/next/handlers/healthcheck";
```

Or, for consumers wanting a single configuration point:

```ts
// app/lib/deco-admin.ts
import { createDecoAdminRouteHandlers } from "@decocms/start/next";
export const { GET, POST } = createDecoAdminRouteHandlers({
  site: "my-site",
  watch: false,           // never serve SSE from this app
});

// app/%5Fhealthcheck/route.ts (and every other route file)
export const dynamic = "force-dynamic";
export { GET, POST } from "@/lib/deco-admin";
```

The dedicated-route-file pattern is documented in detail in `docs/using-from-nextjs.md` as part of this change. Pre-baked one-line exports for each route are not shipped from the package (consumers vary in how they want to instantiate `createDecoAdminRouteHandlers`); the documented pattern uses a single configuration module.

## Configuration defaults

| Option | Default | Production behaviour |
|--------|---------|----------------------|
| `enabled` | `true` | unchanged |
| `healthcheck` | `true` | on |
| `readiness` | `true` | on |
| `adminProtocol` | `true` | on (admin can preview/save against the live site) |
| `watch` | `NODE_ENV !== "production"` | off |
| `fs` | `NODE_ENV !== "production"` | off |
| `cwd` | `process.cwd()` | unchanged |

`adminProtocol: true` in production is intentional — admin previewing/editing the live site is a legitimate workflow. Consumers wanting a fully sealed production deploy pass `adminProtocol: false`.

## Testing

- `src/node/daemon/*.test.ts` (NEW): each Web-standard handler tested in isolation with `new Request(...)`. Covers healthcheck CORS, readiness 200/503, auth 401/403/bypass, fs read/patch/delete + traversal refusal, watch SSE emits initial sync and reacts to channel events.
- `src/core/admin/readiness.test.ts` (NEW): pre- and post-`setBlocks` states.
- `src/core/admin/version.test.ts` (NEW): sanity-checks `ADMIN_COMPAT_VERSION` is a non-empty semver string.
- `src/tanstack/daemon/middleware.test.ts` (NEW): integration test exercising `createDaemonMiddleware` end-to-end via a real Node httpServer — ensures the existing Connect-style dispatch still routes via the new core handlers.
- `src/next/adminRoute.test.ts` (EXTENDED): `/_healthcheck` returns version, `/_ready` returns 503 then 200 after `setBlocks`, `/_watch` returns 404 when `NODE_ENV === "production"` (disabled-route convention), `/fs/file/...` returns 401 without auth and 200 with `DANGEROUSLY_ALLOW_PUBLIC_ACCESS=true`.
- Tier-boundary check (`scripts/check-tier-boundaries.ts`) continues to pass: `next/` imports from `core/` and `node/` only; `tanstack/` imports from `core/` and `node/` only; neither imports from the other.

## Documentation

- `docs/using-from-nextjs.md` rewrite:
  - Remove the broken root catchall recipe.
  - Add the escaped-folder layout above.
  - Document the `createDecoAdminRouteHandlers` config pattern.
  - Explain the `%5F` and literal-`.` escape rules and link the Next/Turbopack docs.
- `src/next/adminRoute.ts` JSDoc rewrite: replace the wrong `app/live/_meta/route.ts` example with `app/live/%5Fmeta/route.ts`, and add the escape-rule paragraph.
- Changelog entry calling out: (a) the new exports, (b) additive at the source level — no symbols renamed or removed; consumers following the previously documented (broken) catchall recipe must migrate to dedicated route files, (c) the new `node/daemon/` public path for advanced use.

## Acceptance criteria

- [ ] `ADMIN_COMPAT_VERSION` defined in `src/core/admin/version.ts` with pinning JSDoc; consumed by both `src/node/daemon/healthcheck.ts` and the TanStack daemon (replacing the inline constant).
- [ ] `handleDecoHealthcheck` exported from `@decocms/start/next` and `@decocms/start/node/daemon`, returning `ADMIN_COMPAT_VERSION` with CORS headers.
- [ ] `handleDecoReadiness` exported from both adapters; 200 `"ready"` once `getRevision() !== null`, 503 `"not ready"` otherwise.
- [ ] `createDecoAdminRoute` and `createDecoAdminRouteHandlers` exported from `@decocms/start/next` with the full `DecoAdminRouteOptions` shape and documented defaults.
- [ ] `createDaemonMiddleware` accepts the same `DecoAdminRouteOptions` (under `routes`) and internally composes the shared Web-standard handlers via `toNodeMiddleware`. Existing TanStack consumers see no behaviour change without supplying `routes`.
- [ ] `/watch` (SSE) and `/fs/*` work in Next dev (`NODE_ENV !== "production"`), are 404 in Next prod, and continue to work in TanStack dev via the existing Vite middleware path.
- [ ] `/volumes/<id>/files` returns 501 with a documented body when hit through the Next adapter; unchanged on the TanStack side.
- [ ] `src/next/adminRoute.ts` JSDoc updated with the escaped-folder layout and the `%5F` / literal-`.` rules.
- [ ] `docs/using-from-nextjs.md` rewritten with the escaped-folder layout and the `createDecoAdminRouteHandlers` pattern.
- [ ] Tier-boundary check passes; `next/` does not import from `tanstack/`.
- [ ] Integration tests: TanStack daemon end-to-end via Node httpServer; Next adapter `/_healthcheck`, `/_ready`, `/fs/file/...` with and without auth, `/_watch` returns 404 in production.
- [ ] Changelog entry shipped.

## Out of scope

- Porting `/volumes/<id>/files` (WebSocket) to Next. Documented as TanStack-only; Next returns 501.
- A scaffolding CLI that writes the six dedicated route files into `app/`. Documented for now; revisit if a consumer hits the boilerplate.
- A separate sidecar process or `deco-dev-daemon` CLI. Rejected in favour of in-process route handlers.
- Production-time SSE/FS. The daemon is dev-only by design.
- Lifting `ADMIN_COMPAT_VERSION` from `package.json`. Intentionally pinned to the deco-cx/deco range, decoupled from `@decocms/start` versions.
