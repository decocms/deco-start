# __root.tsx Template

Two options — pick the one that matches the site's needs.

## Option A — Minimal (recommended default)

`DecoRootLayout` from `@decocms/start/hooks` wraps the `<html>` shell with all the pieces the framework expects (DaisyUI theme, LiveControls, HeadContent, Scripts, analytics bootstrap). Use this for every new site unless you need custom providers at the root.

```typescript
import { createRootRoute } from "@tanstack/react-router";
import { DecoRootLayout } from "@decocms/start/hooks";
// @ts-ignore Vite ?url import
import appCss from "../styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "My Store" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico" },
    ],
  }),
  component: RootLayout,
});

function RootLayout() {
  return <DecoRootLayout lang="pt-BR" siteName="my-store" />;
}
```

## Option B — Custom providers (cart/React Query at root)

Only reach for this when you need providers wrapping the CMS outlet — a root-mounted cart store that must hydrate before any section, global React Query client, etc. Everything else stays in sections.

```typescript
import { useState } from "react";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveControls } from "@decocms/start/hooks";
import { ANALYTICS_SCRIPT } from "@decocms/start/sdk/analytics";
// @ts-ignore Vite ?url import
import appCss from "../styles/app.css?url";

const PROGRESS_CSS = `
@keyframes decoProgress{0%{width:0}30%{width:50%}60%{width:80%}100%{width:98%}}
.deco-nav-progress{position:fixed;top:0;left:0;height:3px;background:var(--color-primary,#e53e3e);z-index:9999;animation:decoProgress 4s cubic-bezier(.4,0,.2,1) forwards;pointer-events:none;box-shadow:0 0 8px var(--color-primary,#e53e3e)}
`;

function NavigationProgress() {
  const isLoading = useRouterState({ select: (s) => s.isLoading });
  if (!isLoading) return null;
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: PROGRESS_CSS }} />
      <div className="deco-nav-progress" />
    </>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "My Store" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico" },
    ],
  }),
  component: RootLayout,
});

function RootLayout() {
  const [queryClient] = useState(
    () => new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: import.meta.env.DEV ? 0 : 30_000,
          gcTime: import.meta.env.DEV ? 0 : 5 * 60_000,
          refetchOnWindowFocus: import.meta.env.DEV,
        },
      },
    }),
  );

  return (
    <html lang="pt-BR" data-theme="light" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="bg-base-100 text-base-content" suppressHydrationWarning>
        <NavigationProgress />
        <QueryClientProvider client={queryClient}>
          <Outlet />
        </QueryClientProvider>
        <LiveControls site="my-store" />
        <script type="module" dangerouslySetInnerHTML={{ __html: ANALYTICS_SCRIPT }} />
        <Scripts />
      </body>
    </html>
  );
}
```

## Key points (applies to both)

1. **`data-theme="light"`** on `<html>` — required for DaisyUI v4/v5 CSS variables to activate in production AND in the admin preview shell. Option A sets this for you.
2. **`suppressHydrationWarning`** on `<html>` and `<body>` — browser extensions mutate these elements; React would warn on mismatch.
3. **`LiveControls site={...}`** — admin iframe bridge. `site` MUST match the CMS site name used in `@decocms/apps/registry` entries and `.deco/blocks/`.
4. **No `Device.Provider`** — do NOT hardcode `<Device.Provider value={{ isMobile: true }}>` in the root. Device detection belongs in each page route's `createServerFn` loader (see gotcha #29).
5. **Keep the root thin** — sections own their own data. Avoid cross-section state at the root unless it's truly global (cart, theme). Every provider at the root ships to every page, even ones that don't need it.

## Cart/platform state

If you add a cart store at the root (Option B), wire it AFTER `QueryClientProvider` so section-local hooks can use both. The cart store itself should be a module-level `@tanstack/store` `Store`, and a `useCart()` hook reads via `useStore(cartStore)`. SSR hydration: the page loader fetches the initial cart (via the minicart loader or Shopify `getCart`) and the root passes the initial state to `cartStore.setState()` before hydration.
