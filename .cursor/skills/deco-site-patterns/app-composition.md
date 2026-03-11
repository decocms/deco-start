# App Composition

How a Deco site registers apps, configures global layout, handles routes, themes, images, and matchers.

## App Factory (`apps/site.ts`)

The main app combines the site's manifest with commerce dependencies:

```typescript
import manifest, { Manifest } from "../manifest.gen.ts";
import { type App, type AppContext as AC } from "@deco/deco";
import commerce from "apps/commerce/mod.ts";
import std from "apps/compat/std/mod.ts";

export type AppContext = AC<ReturnType<typeof Site>>;

interface Props {
  trafficToDeco: number;
  decoHostToRedirect: string;
}

export default function Site(
  state: Props,
): App<Manifest, Props, [typeof std, ReturnType<typeof commerce>]> {
  return {
    state,
    manifest,
    dependencies: [std(state), commerce(state)],
  };
}

export { onBeforeResolveProps, Preview } from "apps/website/mod.ts";
```

Key elements:
- **`manifest`** -- auto-generated from `manifest.gen.ts`, registers all site blocks
- **`state`** -- props configurable in the admin (traffic percentage, redirect host)
- **`dependencies`** -- `std` (compatibility layer) and `commerce` (VTEX/Shopify depending on config)
- **`AppContext`** -- typed context for loaders/actions: `AC<ReturnType<typeof Site>>`

### Decohub (`apps/decohub.ts`)

One-line re-export that enables the admin panel:

```typescript
export { default, Preview } from "apps/decohub/mod.ts";
```

### How Commerce Composes

`apps/commerce/mod.ts` reads the `platform` field from `site.json` and selects the right integration:

```json
{ "commerce": { "platform": "vtex" } }
```

This loads `apps/vtex/mod.ts` which contributes all VTEX loaders, actions, and handlers to the manifest. The admin then shows VTEX-specific loader options in section prop selectors.

## AppContext

`AppContext` gives loaders and actions typed access to the entire app ecosystem:

```typescript
import { AppContext } from "site/apps/site.ts";

export const loader = async (props: Props, req: Request, ctx: AppContext) => {
  // Invoke another loader
  const user = await ctx.invoke("site/actions/checkUser.ts");

  // Resolve a block by __resolveType
  const { credentials } = await ctx.get({ "__resolveType": "Tokens" });

  // Access request
  const cookies = req.headers.get("cookie");

  return { ...props, user };
};
```

| Method | Purpose |
|--------|---------|
| `ctx.invoke(key, props?)` | Call another loader/action by manifest key |
| `ctx.get(resolvable)` | Resolve a block (Secrets, config, etc.) |
| `ctx.state` | Access app state (props from `site.ts`) |

## Loader and Action Signatures

### Loader

```typescript
export default async function loader(
  props: Props,          // CMS-configured props (with resolved __resolveType)
  req: Request,          // HTTP request (headers, cookies, URL)
  ctx: AppContext,        // App context (invoke, get, state)
): Promise<ReturnType> {
  // ...
}
```

### Action

```typescript
export default async function action(
  props: Props,
  req: Request,
  ctx: AppContext,
): Promise<ReturnType> {
  // Mutations (create/update/delete)
}
```

Actions are called via `ctx.invoke()` or the client-side `invoke` proxy. They're not cached (unlike loaders).

## Global Layout (`routes/_app.tsx`)

The global layout wraps every page:

```tsx
import { AppProps } from "$fresh/server.ts";
import Theme from "site/sections/Theme/Theme.tsx";
import GlobalTags from "site/components/GlobalTags.tsx";
import ThirdPartyScripts from "site/components/ThirdPartyScripts.tsx";
import Promotion from "site/components/scriptRetrofit/promotion/promotion.tsx";

function App(props: AppProps) {
  return (
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <Theme />
      <GlobalTags />
      <ThirdPartyScripts />
      <props.Component />
      <Promotion rootId="promotion-monitor" />
    </html>
  );
}

export default App;
```

| Component | Purpose |
|-----------|---------|
| `Theme` | CSS variables for colors, fonts, button styles |
| `GlobalTags` | Meta tags, CSS, manifest.json, tracking pixels (Meta, Hotjar, RetailRocket) |
| `ThirdPartyScripts` | External scripts (chat, accessibility) |
| `<props.Component />` | Page content (sections from CMS) |
| `Promotion` | Promotion flow monitoring script |

## Proxy Routes

Sites proxy external scripts through their own domain to avoid CSP issues:

```typescript
// routes/proxy.ts
const ALLOWLIST_URLS = [
  "https://mcdn.retailrocket.net/content/javascript/trackingm.js",
  "https://ajax.googleapis.com/ajax/libs/jquery/3.2.0/jquery.min.js?v=1",
  "https://static.hotjar.com/c/hotjar-2214037.js?sv=6",
];

export const handler: Handlers = {
  GET: async (req) => {
    const url = new URL(req.url).searchParams.get("url");
    if (!url || !ALLOWLIST_URLS.includes(url)) {
      return new Response(url, { status: 404 });
    }
    const response = await fetch(url);
    return new Response(response.body, {
      headers: {
        ...Object.fromEntries(response.headers),
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
      },
    });
  },
};
```

URL is passed via `?url=...` query parameter. Only allowlisted URLs are proxied. CORS headers are added.

## Theme Section

The Theme section defines the site's design tokens as CSS variables:

```typescript
// sections/Theme/Theme.tsx
export interface MainColors {
  /** @format color @title Base @default #FFFFFF */
  "base-100": string;
  /** @format color @title Primary @default #003232 */
  primary: string;
  /** @format color @title Secondary @default #000000 */
  secondary: string;
  /** @format color @title Tertiary @default #8C8C8C */
  tertiary: string;
}

export interface Props {
  mainColors: MainColors;
  fontFamily?: GoogleFont;
  customFont?: string;
  buttonStyle?: { borderRadius?: string };
}
```

Renders as:

```tsx
<style>
  :root {
    --p: 165 100% 10%;  /* primary HSL */
    --pf: 165 100% 8%;  /* primary focus */
    --b1: 0 0% 100%;    /* base-100 */
    --b2: 0 0% 95%;     /* base-200 */
    --rounded-btn: 0;
  }
</style>
```

Uses DaisyUI variable convention (`--p`, `--s`, `--b1`, etc.).

## Image Patterns

Sites use components from `apps/website/components/` for optimized images:

```tsx
import { Picture, Source } from "apps/website/components/Picture.tsx";
import Image from "apps/website/components/Image.tsx";

function Banner({ srcMobile, srcDesktop, alt }: Props) {
  return (
    <Picture class="w-full h-full">
      <Source
        media="(max-width: 768px)"
        src={srcMobile}
        width={375}
        height={500}
      />
      <Source
        media="(min-width: 769px)"
        src={srcDesktop}
        width={1440}
        height={600}
      />
      <Image
        class="w-full h-full object-cover"
        src={srcDesktop}
        alt={alt}
        width={1440}
        height={600}
        loading="lazy"
        decoding="async"
      />
    </Picture>
  );
}
```

Key practices:
- Always set `width` and `height` to prevent CLS
- Use `loading="lazy"` for below-fold images, `loading="eager"` for above-fold
- Use `decoding="async"` for non-blocking decode
- Use `Picture + Source` for responsive images (mobile/desktop)
- `ImageWidget` type in props enables the admin CDN uploader

## Site-Level Matchers

Sites can define custom matchers beyond the built-in ones:

```typescript
// matchers/MatchBirthdayMonth.ts
import { AppContext } from "site/apps/site.ts";

export interface Props {
  birthdate: { month: number; day: number } | null;
}

export default function MatchBirthdayMonth(
  props: Props,
  _req: Request,
  _ctx: AppContext,
): boolean {
  if (!props.birthdate) return false;
  return props.birthdate.month === new Date().getMonth() + 1;
}
```

Custom matchers are registered in `manifest.gen.ts` and can be used in CMS multivariate flags:

```json
{
  "rule": { "__resolveType": "site/matchers/MatchBirthdayMonth.ts", "birthdate": { "__resolveType": "site/loaders/birthdate.ts" } },
  "value": [/* birthday-themed sections */]
}
```

## Configuration Files

### `deno.json`

```json
{
  "imports": {
    "$fresh/": "https://fresh.deno.dev@1.7.3/",
    "@deco/deco": "jsr:@deco/deco@1.174.2",
    "apps/": "https://cdn.jsdelivr.net/gh/deco-cx/apps@0.139.0/",
    "$store/": "./",
    "site/": "./",
    "preact": "npm:preact@10.23.1"
  },
  "tasks": {
    "start": "deno eval 'import \"https://deco.cx/run\"'",
    "dev": "deno task gen && deno eval 'import \"$fresh/src/dev/mod.ts\"'",
    "gen": "deno run -A dev.ts --gen-only",
    "build": "DECO_SITE_NAME=mystore deno run -A dev.ts build"
  },
  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "preact" }
}
```

Key aliases: `$store/` and `site/` both point to the project root, enabling both `$store/components/...` and `site/sections/...` import styles.

### `fresh.config.ts`

```typescript
import { defineConfig } from "$fresh/server.ts";
import { plugins } from "deco/plugins/deco.ts";
import manifest from "./manifest.gen.ts";

export default defineConfig({
  plugins: plugins({ manifest, htmx: false }),
});
```

The Deco plugin takes over Fresh's routing, injecting the CMS page handler as the catch-all route.
