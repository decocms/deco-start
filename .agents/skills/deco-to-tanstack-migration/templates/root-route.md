# __root.tsx Template

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
import appCss from "../styles/app.css?url";

// Deco analytics event dispatcher — must be in <head> before any section renders
const DECO_EVENTS_BOOTSTRAP = `
window.DECO = window.DECO || {};
window.DECO.events = window.DECO.events || {
  _q: [],
  dispatch: function(e) {
    if (window.dataLayer) { window.dataLayer.push({ event: e.name, ecommerce: e.params }); }
    this._q.push(e);
  }
};
window.dataLayer = window.dataLayer || [];
`;

// Navigation progress bar CSS
const PROGRESS_CSS = `
@keyframes decoProgress{0%{width:0}30%{width:50%}60%{width:80%}100%{width:98%}}
.deco-nav-progress{position:fixed;top:0;left:0;height:3px;background:var(--color-primary,#e53e3e);z-index:9999;animation:decoProgress 4s cubic-bezier(.4,0,.2,1) forwards;pointer-events:none;box-shadow:0 0 8px var(--color-primary,#e53e3e)}
@keyframes decoFadeIn{from{opacity:0}to{opacity:1}}
.deco-nav-overlay{position:fixed;inset:0;z-index:9998;pointer-events:none;background:rgba(255,255,255,0.15);animation:decoFadeIn .2s ease-out}
`;

function NavigationProgress() {
  const isLoading = useRouterState({ select: (s) => s.isLoading });
  if (!isLoading) return null;
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: PROGRESS_CSS }} />
      <div className="deco-nav-progress" />
      <div className="deco-nav-overlay" />
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
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      // Add your font stylesheet here:
      // { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=..." },
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico" },
    ],
  }),
  component: RootLayout,
});

function RootLayout() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: import.meta.env.DEV ? 0 : 30_000,
            gcTime: import.meta.env.DEV ? 0 : 5 * 60_000,
            refetchOnWindowFocus: import.meta.env.DEV,
          },
        },
      })
  );

  return (
    <html lang="pt-BR" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: DECO_EVENTS_BOOTSTRAP }} />
        <HeadContent />
      </head>
      <body className="bg-base-100 text-base-content" suppressHydrationWarning>
        <NavigationProgress />
        <QueryClientProvider client={queryClient}>
          <Outlet />
        </QueryClientProvider>
        <LiveControls site={process.env.DECO_SITE_NAME} />
        <script type="module" dangerouslySetInnerHTML={{ __html: ANALYTICS_SCRIPT }} />
        <Scripts />
      </body>
    </html>
  );
}
```

## Key Points

1. **QueryClientProvider** — Required even if not using React Query directly. @decocms/apps hooks may use it.
2. **LiveControls** — Admin iframe bridge. `site` prop must match CMS site name.
3. **DECO_EVENTS_BOOTSTRAP** — Must be in `<head>` before sections. Sections dispatch analytics events on render.
4. **NavigationProgress** — Visual feedback during client-side navigation.
5. **suppressHydrationWarning** — On `<html>` and `<body>` to avoid mismatches from browser extensions.
6. **data-theme="light"** — Required for DaisyUI v4/v5 CSS variables to activate.
