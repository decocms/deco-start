# Using @decocms/start from Next.js (App Router)

`@decocms/start` ships a first-party Next.js adapter at `@decocms/start/next`. App Router only.

## Install

```bash
bun add @decocms/start
# Required peer dependencies (you almost certainly already have these in a Next 15 app)
bun add next@^15 react@^19 react-dom@^19
```

`tsconfig.json` must use `moduleResolution: "bundler"` (the Next 15 default).

## Configure

No `transpilePackages` in `next.config.js` is needed — the package ships compiled JavaScript.

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

  // Render result.resolvedSections via your component map.
  return <YourSectionsRenderer result={result} />;
}
```

To populate `x-url` / `x-pathname`, install a Next.js middleware:

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

The Deco admin UI talks to your storefront via `/live/_meta`, `/.decofile`, `/live/previews/*`, and `/deco/invoke/*`. Expose them with a single catch-all:

```ts
// app/(deco-admin)/[...path]/route.ts
import { handleDecoAdminRoute } from "@decocms/start/next";
export const GET = handleDecoAdminRoute;
export const POST = handleDecoAdminRoute;
```

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

`registerSectionsSync` populates both the sync component cache AND the lazy-loader registry (so `getSection()` finds sync-registered sections — see issue #163 gotcha #1).

## Limitations

- App Router only. Pages Router is not supported.
- The minimal `DecoPage` server component is a starting point; production renderers should provide their own.
- `@decocms/start/next/client` exports only `useDevice` and `signal`. The TanStack-specific hooks (`LiveControls`, `LazySection`) are not yet ported.
