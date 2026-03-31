# Admin / CMS Integration Gotchas

> loadDeferredSection, schema refs, section-type props, device context, hydration.


## 16. Admin Route Cache Bypass

`/live/` and `/.decofile` are in `DEFAULT_BYPASS_PATHS`. Admin routes are intercepted before caching.


## 18. Loader References in JSON Schema

`Resolvable` definition with `additionalProperties: true` needed for props that accept loader refs.

---


## 23. Custom useId with Math.random() Causes Hydration Mismatch

Some storefronts have a custom `useId` hook that appends `Math.random()` to generate "unique" IDs. This guarantees different IDs on server vs client, causing React #419.

**Fix**: Replace with React's native `useId`:

```typescript
import { useId as useReactId } from "react";
export const useId = useReactId;
```


## 29. Device Context Must Be Server-Driven, Not Hardcoded

**Severity**: HIGH — breaks entire page layout (mobile vs desktop)

The original Deco/Fresh framework injected `ctx.device` automatically into section contexts. In the new TanStack Start stack, the `Device` context (used by `useDevice()`) must be explicitly provided with the correct value from server-side User-Agent detection.

**Symptom**: All visitors see the mobile layout regardless of device. The `useDevice()` hook always returns `{ isMobile: true }` because the `Device.Provider` was hardcoded with `value={{ isMobile: true }}` in `__root.tsx`.

**Root cause**: The root route can't use `createServerFn` for device detection (causes Rollup code-split errors with `tss-serverfn-split`). And the Device context default was set to mobile.

**Fix**: Detect device inside each page route's existing `createServerFn` loader (which already has access to `getRequestHeader("user-agent")`), return `isMobile` alongside the page data, and wrap the page component with `<Device.Provider>`:

```typescript
// In routes/index.tsx or routes/$.tsx
const MOBILE_RE = /mobile|android|iphone|ipad|ipod|webos|blackberry|opera mini|iemobile/i;

const loadPage = createServerFn({ method: "GET" }).handler(async () => {
  const ua = getRequestHeader("user-agent") ?? "";
  const matcherCtx = { userAgent: ua, url: getRequestUrl().toString(), path: "/", cookies: getCookies() };
  const page = await resolveDecoPage("/", matcherCtx);
  return { page, isMobile: MOBILE_RE.test(ua) };
});

function HomePage() {
  const { page, isMobile } = Route.useLoaderData();
  return (
    <Device.Provider value={{ isMobile }}>
      <DecoPageRenderer sections={page.resolvedSections} />
    </Device.Provider>
  );
}
```

Remove the hardcoded `<Device.Provider value={{ isMobile: true }}>` from `__root.tsx`.

**Key constraint**: Do NOT put `createServerFn` in `__root.tsx` — TanStack Start's server function splitter cannot handle it there.

---

## Admin Preview HTML Shell

The preview at `/live/previews/*` renders sections into an HTML shell. This shell MUST match the production `<html>` attributes for CSS frameworks to work:

```typescript
// In setup.ts
setRenderShell({
  css: appCss,          // Vite ?url import of app.css
  fonts: ["https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap"],
  theme: "light",       // -> <html data-theme="light"> (required for DaisyUI v4)
  bodyClass: "bg-base-100 text-base-content",
  lang: "pt-BR",
});
```

Without `data-theme="light"`, DaisyUI v4 theme variables (`--color-primary`, etc.) won't activate in the preview iframe, causing color mismatches vs production.

## Client-Safe vs Server-Only Imports

`@decocms/start` has two admin entry points:
- **`@decocms/start/admin`** -- server-only handlers (handleMeta, handleRender, etc.) -- these may transitively import `node:async_hooks`
- **`@decocms/start/admin/setup`** (re-exported from `@decocms/start/admin`) -- client-safe setup functions (setMetaData, setInvokeLoaders, setRenderShell) -- NO node: imports

The site's `setup.ts` can safely import from `@decocms/start/admin` because it only uses the setup functions. But the barrel export must be structured so Vite tree-shaking doesn't pull server modules into client bundles.

## Admin Self-Hosting Architecture

When a site is self-hosted (deployed to its own Cloudflare Worker), the admin communicates with the storefront via the `productionUrl`:

```
admin.deco.cx
  └─> createContentSiteSDK (when env.platform === "content" OR devContentUrl is set)
        ├─> fetch(productionUrl + "/live/_meta")     ← schema + manifest
        ├─> fetch(productionUrl + "/.decofile")      ← content blocks
        └─> iframe src = productionUrl + "/live/previews/*"  ← section preview
```

### Content URL Resolution Priority

1. `devContentUrl` URL param → saved to `localStorage[deco::devContentUrl::${site}]` → used by Content SDK
2. `devContentUrl` from localStorage → used by Content SDK
3. `site.metadata.selfHosting.productionUrl` (Supabase) → used by Content SDK
4. `https://${site}.deco.site` → fallback

### Environment Platform Gate

The admin only uses `createContentSiteSDK` when:
- `devContentUrl` is set (localStorage or URL param), OR
- The current environment has `platform: "content"`

Setting `productionUrl` in Supabase alone is NOT sufficient. The environment must be "content" platform.

For local dev, use the URL param shortcut:
```
https://admin.deco.cx/sites/YOUR_SITE/spaces/...?devContentUrl=http://localhost:5181
```

## Admin / CMS Schema Architecture

The deco admin communicates with the storefront via:
- `GET /live/_meta` -- returns full JSON Schema + manifest of block types
- `GET /.decofile` -- returns the site's content blocks
- `POST /deco/render` -- renders a section/page with given props in an iframe
- `POST /deco/invoke` -- calls a loader/action and returns JSON

### Schema Composition (`composeMeta`)

```
[generate-schema.ts] --> meta.gen.json (sections only, pages: empty)
[setup.ts] --> imports meta.gen.json --> calls setMetaData(metaData)
[setMetaData] --> calls composeMeta() --> injects page schema + merges definitions
[/live/_meta] --> returns composed schema with content-hash ETag
```

Key rules:
- `toBase64()` MUST produce padded Base64 (matching `btoa()`) -- admin uses `btoa()` to construct definition refs
- Page schema uses flat properties (no allOf + @Props indirection) to minimize RJSF resolution steps
- ETag is a content-based DJB2 hash, not string length, for reliable cache invalidation

### Admin Local Development

1. Start admin: `cd admin && deno task play` (port 4200)
2. Start storefront: `bun run dev` (port 5181)
3. Set devContentUrl: `localStorage.setItem('deco::devContentUrl::YOUR_SITE_NAME', 'http://localhost:PORT')`
4. Navigate to `http://localhost:4200/sites/YOUR_SITE_NAME/spaces/pages`
5. After schema changes: clear admin cache and hard-refresh
