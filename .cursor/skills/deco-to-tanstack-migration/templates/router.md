# router.tsx Template

```typescript
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function createRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
  });

  // Scroll to top on forward navigation (PUSH/REPLACE), skip on back/forward (GO)
  router.subscribe("onResolved", (evt) => {
    if (evt.type === "GO") return;
    window.scrollTo({ top: 0 });
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}
```

## Route Files

### src/routes/index.tsx (Homepage)

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { cmsHomeRouteConfig } from "@decocms/start/routes";
import { DecoPageRenderer } from "@decocms/start/hooks";
import { loadDeferredSection } from "@decocms/start/routes/cmsRoute";

const { loader, head } = cmsHomeRouteConfig({
  defaultTitle: "My Store",
});

export const Route = createFileRoute("/")({
  loader,
  head,
  component: HomePage,
});

function HomePage() {
  const { resolvedSections, deferredSections, pagePath } = Route.useLoaderData();
  return (
    <DecoPageRenderer
      sections={resolvedSections}
      deferredSections={deferredSections}
      pagePath={pagePath}
      loadDeferredSectionFn={loadDeferredSection}
    />
  );
}
```

### src/routes/$.tsx (Catch-All CMS Route)

```typescript
import { createFileRoute, notFound } from "@tanstack/react-router";
import { cmsRouteConfig } from "@decocms/start/routes";
import { DecoPageRenderer } from "@decocms/start/hooks";
import { loadDeferredSection } from "@decocms/start/routes/cmsRoute";

const { loader, head } = cmsRouteConfig({
  siteName: "My Store",
  ignoreSearchParams: ["skuId"],
});

export const Route = createFileRoute("/$")({
  loader: async (ctx) => {
    const data = await loader(ctx);
    if (!data) throw notFound();
    return data;
  },
  head,
  component: CmsPage,
});

function CmsPage() {
  const { resolvedSections, deferredSections, pagePath } = Route.useLoaderData();
  return (
    <DecoPageRenderer
      sections={resolvedSections}
      deferredSections={deferredSections}
      pagePath={pagePath}
      loadDeferredSectionFn={loadDeferredSection}
    />
  );
}
```
