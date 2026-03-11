# Admin Protocol

The admin panel (`admin.deco.cx`) communicates with self-hosted storefronts via HTTP endpoints handled in the Cloudflare Worker entry, NOT inside TanStack Start's server.

Important: Admin routes MUST be handled in `workerEntry.ts`, NOT inside `createServerEntry` - Vite strips custom fetch logic from server entries in production builds.

## Endpoints

### GET /live/_meta (`admin/meta.ts`)

Returns JSON Schema + manifest for the admin form builder.

```typescript
handleMeta(request: Request): Response
```

- Schema is composed at runtime via `composeMeta()`
- Content-hash ETag (DJB2) for caching
- ETag included in JSON body for admin cache busting
- Returns sections, pages, loaders, matchers, flags definitions
- Auto-invalidates cached ETag when decofile changes (via `onChange` listener)

### GET /.decofile (`admin/decofile.ts`)

Returns the current CMS content blocks.

```typescript
handleDecofileRead(request: Request): Response
```

- Includes content-hash `revision` in JSON body
- Sets `ETag` header from current revision for HTTP caching

### POST /.decofile (`admin/decofile.ts`)

Hot-reloads CMS blocks without redeployment.

```typescript
handleDecofileReload(request: Request): Response
```

- Calls `setBlocks(newBlocks)` which updates in-memory state, recomputes revision, and notifies `onChange` listeners
- Explicitly calls `clearLoaderCache()` to ensure data consistency after reload

### POST /deco/invoke (`admin/invoke.ts`)

Executes loaders/actions by key.

```typescript
handleInvoke(request: Request): Response
```

- Loaders registered via `setInvokeLoaders(map)`
- Actions registered via `setInvokeActions(map)`
- Supports multiple body formats: `application/json`, `multipart/form-data`, `application/x-www-form-urlencoded`, URL search params (`?props=...`)
- `?select=field1,field2` query parameter for partial response filtering
- Batch invoke: send array of `{ key, props }` to execute multiple in parallel
- Nested `__resolveType` within payload props are recursively resolved
- Development mode includes stack traces in error responses

### POST /live/previews/* (`admin/render.ts`)

Renders a section for preview in the admin iframe.

```typescript
handleRender(request: Request): Response
```

- Uses `setRenderShell(config)` to wrap preview in HTML shell
- Shell must include `data-theme="light"` for DaisyUI v4 color variables
- Renders section component with provided props

## Setup (`admin/setup.ts`)

Client-safe configuration (no `node:` imports or AsyncLocalStorage):

```typescript
// Called in site's setup.ts
setMetaData(metaJson);                    // Set schema data from meta.gen.json
setInvokeLoaders(loaderMap);              // Register loaders for /deco/invoke
setInvokeActions(actionMap);              // Register actions for /deco/invoke
setRenderShell(shellConfig);              // Configure preview HTML wrapper
registerLoaderSchema(key, schema);        // Register a single loader schema dynamically
registerLoaderSchemas(schemas);           // Register multiple loader schemas at once
registerMatcherSchema(key, schema);       // Register a single matcher schema dynamically
registerMatcherSchemas(schemas);          // Register multiple matcher schemas at once
```

## Schema Composition (`admin/schema.ts`)

`composeMeta()` injects framework-level schemas at runtime:

```
[generate-schema.ts]          [setup.ts]                [composeMeta()]
Scans src/sections/    -->    Imports meta.gen.json  --> Injects page schema,
Produces section-only         Calls setMetaData()       merges definitions,
meta.gen.json                                           populates pages root
```

Key: `toBase64()` must produce padded output matching `btoa()` - admin uses `btoa()` for definition refs.

### Dynamic Schema Registries

Loader and matcher schemas are now managed via runtime registries instead of hardcoded lists:

```typescript
// Loaders — runtime registry replaces old KNOWN_LOADERS array
registerLoaderSchema("vtex/loaders/productList.ts", {
  inputSchema: { ... },
  outputSchema: { ... },
  tags: ["product-list"],  // used by wrapResolvableProperties to filter product-list loaders
});

// Matchers — same pattern
registerMatcherSchema("website/matchers/device.ts", {
  inputSchema: { ... },
});
```

`buildLoaderDefinitions()` and `buildMatcherDefinitions()` now read from these registries at composition time. The `getProductListLoaderKeys()` function dynamically filters loaders tagged with `product-list`.

## CORS (`admin/cors.ts`)

```typescript
isAdminOrLocalhost(origin: string): boolean  // Check if origin is admin
corsHeaders(origin: string): Headers         // CORS headers for admin
```

Allows: `admin.deco.cx`, `localhost:*`.

## LiveControls (`admin/liveControls.ts`)

Inline script injected into every page when in admin context:

```typescript
LIVE_CONTROLS_SCRIPT: string  // postMessage bridge script
```

Provides:
- `__DECO_STATE` global with decofile state
- `postMessage` bridge to admin iframe
- Section selection/highlighting
- Environment info (site, deploymentId)

## LiveControls Component (`hooks/LiveControls.tsx`)

React component that renders the bridge script:

```tsx
<LiveControls
  site={site}
  siteId={siteId}
/>
```

Injected in the site's `__root.tsx`.
