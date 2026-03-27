import type { MigrationContext } from "../types.ts";

export function generateRoutes(
  ctx: MigrationContext,
): Record<string, string> {
  const siteName = ctx.siteName;
  const siteTitle = siteName.charAt(0).toUpperCase() + siteName.slice(1);

  return {
    "src/routes/__root.tsx": generateRoot(ctx, siteTitle),
    "src/routes/index.tsx": generateIndex(siteTitle),
    "src/routes/$.tsx": generateCatchAll(siteTitle),
    "src/routes/deco/meta.ts": generateDecoMeta(),
    "src/routes/deco/invoke.$.ts": generateDecoInvoke(),
    "src/routes/deco/render.ts": generateDecoRender(),
  };
}

function generateRoot(ctx: MigrationContext, siteTitle: string): string {
  const gtmScript = ctx.gtmId
    ? `
  // Google Tag Manager
  useEffect(() => {
    if (typeof window === "undefined") return;
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://www.googletagmanager.com/gtm.js?id=${ctx.gtmId}";
    document.head.appendChild(script);
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
  }, []);`
    : "";

  return `import { useState, useEffect, useRef } from "react";
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

declare global {
  interface Window {
    __deco_ready?: boolean;
    dataLayer: unknown[];
  }
}

const PROGRESS_CSS = \`
@keyframes progressSlide { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
.nav-progress-bar { animation: progressSlide 1s ease-in-out infinite; }
\`;

function NavigationProgress() {
  const isLoading = useRouterState({ select: (s) => s.isLoading });
  if (!isLoading) return null;
  return (
    <div className="fixed top-0 left-0 right-0 z-[9999] h-1 bg-primary/20 overflow-hidden">
      <style dangerouslySetInnerHTML={{ __html: PROGRESS_CSS }} />
      <div className="nav-progress-bar h-full w-1/3 bg-primary rounded-full" />
    </div>
  );
}

function StableOutlet() {
  const isLoading = useRouterState({ select: (s) => s.isLoading });
  const ref = useRef<HTMLDivElement>(null);
  const savedHeight = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (isLoading && ref.current) {
      savedHeight.current = ref.current.offsetHeight;
    }
    if (!isLoading) {
      savedHeight.current = undefined;
    }
  }, [isLoading]);

  return (
    <div ref={ref} style={savedHeight.current ? { minHeight: savedHeight.current } : undefined}>
      <Outlet />
    </div>
  );
}

const DECO_EVENTS_BOOTSTRAP = \`
window.DECO = window.DECO || {};
window.DECO.events = window.DECO.events || {
  _q: [],
  _subs: [],
  dispatch: function(e) {
    this._q.push(e);
    for (var i = 0; i < this._subs.length; i++) {
      try { this._subs[i](e); } catch(err) { console.error('[DECO.events]', err); }
    }
  },
  subscribe: function(fn) {
    this._subs.push(fn);
    for (var i = 0; i < this._q.length; i++) {
      try { fn(this._q[i]); } catch(err) {}
    }
  }
};
window.dataLayer = window.dataLayer || [];
\`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "${siteTitle}" },
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
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000 },
        },
      }),
  );
${gtmScript}

  useEffect(() => {
    const id = setTimeout(() => {
      window.__deco_ready = true;
      document.dispatchEvent(new Event("deco:ready"));
    }, 500);
    return () => clearTimeout(id);
  }, []);

  return (
    <html lang="pt-BR" data-theme="light" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="bg-base-200 text-base-content" suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: DECO_EVENTS_BOOTSTRAP }} />
        <QueryClientProvider client={queryClient}>
          <NavigationProgress />
          <main>
            <StableOutlet />
          </main>
        </QueryClientProvider>
        <LiveControls site="${ctx.siteName}" />
        <script type="module" dangerouslySetInnerHTML={{ __html: ANALYTICS_SCRIPT }} />
        <Scripts />
      </body>
    </html>
  );
}
`;
}

function generateIndex(siteTitle: string): string {
  return `import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { resolveDecoPage } from "@decocms/start/cms";
import { DecoPageRenderer } from "@decocms/start/hooks";

const loadHome = createServerFn({ method: "GET" }).handler(async () => {
  const page = await resolveDecoPage("/");
  if (!page) return null;
  return {
    resolvedSections: page.resolvedSections ?? [],
    deferredSections: page.deferredSections ?? [],
    pagePath: "/",
  };
});

export const Route = createFileRoute("/")({
  loader: () => loadHome(),
  component: HomePage,
});

function HomePage() {
  const data = Route.useLoaderData() as Record<string, any> | null;

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-bold mb-4">${siteTitle}</h1>
          <p className="text-sm text-base-content/40 mt-2">Nenhuma pagina CMS encontrada para /</p>
        </div>
      </div>
    );
  }

  return (
    <DecoPageRenderer
      sections={data.resolvedSections ?? []}
      deferredSections={data.deferredSections ?? []}
      pagePath={data.pagePath}
    />
  );
}
`;
}

function generateCatchAll(siteTitle: string): string {
  return `import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { resolveDecoPage } from "@decocms/start/cms";
import { DecoPageRenderer } from "@decocms/start/hooks";

const loadCmsPage = createServerFn({ method: "GET" }).handler(async ({ data }: { data: string }) => {
  const path = \`/\${data}\`;
  const page = await resolveDecoPage(path);
  if (!page) return null;
  return {
    resolvedSections: page.resolvedSections ?? [],
    deferredSections: page.deferredSections ?? [],
    pagePath: path,
  };
});

export const Route = createFileRoute("/$")({
  loader: ({ params }) => loadCmsPage({ data: params._splat || "" }),
  component: CmsPage,
  notFoundComponent: NotFoundPage,
});

function CmsPage() {
  const data = Route.useLoaderData() as Record<string, any> | null;
  if (!data) return <NotFoundPage />;

  return (
    <DecoPageRenderer
      sections={data.resolvedSections ?? []}
      deferredSections={data.deferredSections ?? []}
      pagePath={data.pagePath}
    />
  );
}

function NotFoundPage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-base-content/20 mb-4">404</h1>
        <h2 className="text-2xl font-bold mb-2">Pagina nao encontrada</h2>
        <a href="/" className="btn btn-primary">Voltar para Home</a>
      </div>
    </div>
  );
}
`;
}

function generateDecoMeta(): string {
  return `import { createFileRoute } from "@tanstack/react-router";
import { decoMetaRoute } from "@decocms/start/routes";

export const Route = createFileRoute("/deco/meta")(decoMetaRoute);
`;
}

function generateDecoInvoke(): string {
  return `import { createFileRoute } from "@tanstack/react-router";
import { decoInvokeRoute } from "@decocms/start/routes";

export const Route = createFileRoute("/deco/invoke/$")(decoInvokeRoute);
`;
}

function generateDecoRender(): string {
  return `import { createFileRoute } from "@tanstack/react-router";
import { decoRenderRoute } from "@decocms/start/routes";

export const Route = createFileRoute("/deco/render")(decoRenderRoute);
`;
}
