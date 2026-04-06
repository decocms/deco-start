import * as fs from "node:fs";
import * as path from "node:path";
import type { MigrationContext } from "../types.ts";

function discoverFonts(ctx: MigrationContext): string[] {
  const fontsDir = path.join(ctx.sourceDir, "public", "fonts");
  if (!fs.existsSync(fontsDir)) {
    const staticFonts = path.join(ctx.sourceDir, "static", "fonts");
    if (!fs.existsSync(staticFonts)) return [];
    return scanFontDir(staticFonts);
  }
  return scanFontDir(fontsDir);
}

function scanFontDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.(woff2)$/i.test(f))
      .map((f) => `/fonts/${f}`);
  } catch {
    return [];
  }
}

export function generateRoutes(
  ctx: MigrationContext,
): Record<string, string> {
  const siteName = ctx.siteName;
  const siteTitle = siteName.charAt(0).toUpperCase() + siteName.slice(1);
  const vtexAccount = ctx.vtexAccount || siteName;

  return {
    "src/routes/__root.tsx": generateRoot(ctx, siteTitle, vtexAccount),
    "src/routes/index.tsx": generateIndex(ctx, siteTitle),
    "src/routes/$.tsx": generateCatchAll(ctx, siteTitle),
    "src/routes/deco/meta.ts": generateDecoMeta(),
    "src/routes/deco/invoke.$.ts": generateDecoInvoke(),
    "src/routes/deco/render.ts": generateDecoRender(),
  };
}

function generateRoot(ctx: MigrationContext, siteTitle: string, vtexAccount: string): string {
  const fonts = discoverFonts(ctx);
  const isVtex = ctx.platform === "vtex";
  const deployedSiteName = `${ctx.siteName}-tanstack`;

  // Build preconnect list based on platform
  const preconnects: string[] = [];
  preconnects.push(`      { rel: "preconnect", href: "https://decoims.com", crossOrigin: "anonymous" as const },`);
  if (isVtex) {
    preconnects.push(`      { rel: "preconnect", href: "https://${vtexAccount}.vtexassets.com", crossOrigin: "anonymous" as const },`);
  }

  // Font preloads
  const fontPreloads = fonts.map((f) =>
    `      { rel: "preload", href: "${f}", as: "font", type: "font/woff2", crossOrigin: "anonymous" as const },`
  );

  // DNS prefetch for common third-party services
  const dnsPrefetch: string[] = [];
  if (isVtex) {
    dnsPrefetch.push(`      { rel: "dns-prefetch", href: "https://sp.vtex.com" },`);
  }

  return `import { createRootRoute } from "@tanstack/react-router";
import { DecoRootLayout } from "@decocms/start/hooks";
// @ts-ignore Vite ?url import
import appCss from "../styles/app.css?url";

const DEFAULT_DESCRIPTION =
  "${siteTitle} - Tudo para sua casa com os melhores preços.";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "${siteTitle}" },
      { name: "description", content: DEFAULT_DESCRIPTION },
      { property: "og:site_name", content: "${siteTitle}" },
      { property: "og:locale", content: "pt_BR" },
    ],
    links: [
${preconnects.join("\n")}
${fontPreloads.join("\n")}
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico" },
${dnsPrefetch.join("\n")}
    ],
  }),
  component: RootLayout,
});

function RootLayout() {
  return (
    <DecoRootLayout
      lang="pt-BR"
      siteName="${deployedSiteName}"${isVtex ? `
      account="${vtexAccount}"` : ""}
    />
  );
}
`;
}

function generateIndex(ctx: MigrationContext, siteTitle: string): string {
  return `import { createFileRoute } from "@tanstack/react-router";
import { cmsHomeRouteConfig, deferredSectionLoader } from "@decocms/start/routes";
import { DecoPageRenderer } from "@decocms/start/hooks";

export const Route = createFileRoute("/")({
  ...cmsHomeRouteConfig({
    defaultTitle: "${siteTitle} - Tudo para sua casa",
    defaultDescription:
      "${siteTitle} - Tudo para sua casa com os melhores preços.",
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
          <p className="text-lg text-base-content/60">Tudo para sua casa</p>
          <p className="text-sm text-base-content/40 mt-2">Nenhuma página CMS encontrada para /</p>
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

function generateCatchAll(ctx: MigrationContext, siteTitle: string): string {
  return `import { createFileRoute } from "@tanstack/react-router";
import { cmsRouteConfig, deferredSectionLoader } from "@decocms/start/routes";
import { DecoPageRenderer } from "@decocms/start/hooks";

const routeConfig = cmsRouteConfig({
  siteName: "${siteTitle}",
  defaultTitle: "${siteTitle} - Tudo para sua casa",
  defaultDescription:
    "${siteTitle} - Tudo para sua casa com os melhores preços.",
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

function PendingPage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <span className="loading loading-ring loading-xl" />
    </div>
  );
}

function NotFoundPage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-base-content/20 mb-4">404</h1>
        <h2 className="text-2xl font-bold mb-2">Page Not Found</h2>
        <p className="text-base-content/60 mb-6">No CMS page block matches this URL.</p>
        <a href="/" className="btn btn-primary">
          Go Home
        </a>
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
