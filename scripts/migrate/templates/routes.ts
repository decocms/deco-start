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
  return `import { createRootRoute } from "@tanstack/react-router";
import { DecoRootLayout } from "@decocms/start/hooks";
// @ts-ignore Vite ?url import
import appCss from "../styles/app.css?url";

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
  return (
    <DecoRootLayout
      lang="pt-BR"
      siteName="${ctx.siteName}"
    />
  );
}
`;
}

function generateIndex(siteTitle: string): string {
  return `import { createFileRoute } from "@tanstack/react-router";
import { cmsHomeRouteConfig, deferredSectionLoader } from "@decocms/start/routes";
import { DecoPageRenderer } from "@decocms/start/hooks";

export const Route = createFileRoute("/")({
  ...cmsHomeRouteConfig({
    defaultTitle: "${siteTitle}",
    siteName: "${siteTitle}",
  }),
  component: HomePage,
});

function HomePage() {
  const data = Route.useLoaderData() as Record<string, any> | null;

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-bold mb-4">${siteTitle}</h1>
          <p className="text-sm text-base-content/40 mt-2">No CMS page found for /</p>
        </div>
      </div>
    );
  }

  return (
    <DecoPageRenderer
      sections={data.resolvedSections ?? []}
      deferredSections={data.deferredSections ?? []}
      deferredPromises={data.deferredPromises}
      pagePath={data.pagePath}
      pageUrl={data.pageUrl}
      loadDeferredSectionFn={deferredSectionLoader}
    />
  );
}
`;
}

function generateCatchAll(siteTitle: string): string {
  return `import { createFileRoute } from "@tanstack/react-router";
import { cmsRouteConfig, deferredSectionLoader } from "@decocms/start/routes";
import { DecoPageRenderer } from "@decocms/start/hooks";

const routeConfig = cmsRouteConfig({
  siteName: "${siteTitle}",
  defaultTitle: "${siteTitle}",
  ignoreSearchParams: ["skuId"],
});

export const Route = createFileRoute("/$")({
  ...routeConfig,
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
      deferredPromises={data.deferredPromises}
      pagePath={data.pagePath}
      pageUrl={data.pageUrl}
      loadDeferredSectionFn={deferredSectionLoader}
    />
  );
}

function NotFoundPage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-base-content/20 mb-4">404</h1>
        <h2 className="text-2xl font-bold mb-2">Page Not Found</h2>
        <p className="text-base-content/60 mb-6">No CMS page block matches this URL.</p>
        <a href="/" className="btn btn-primary">Go Home</a>
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
