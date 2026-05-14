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

export const { GET, POST, PATCH, DELETE } = createDecoAdminRouteHandlers({
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
export { GET, POST, PATCH, DELETE } from "@/lib/deco-admin";
```

`PATCH` and `DELETE` are required by `/fs/file/*` (admin's edit-and-save flow). They're harmless to re-export from read-only routes — the dispatcher branches on method internally — so a single set works everywhere.

### Disabling specific routes

Each group has its own flag:

```ts
export const { GET, POST, PATCH, DELETE } = createDecoAdminRouteHandlers({
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
