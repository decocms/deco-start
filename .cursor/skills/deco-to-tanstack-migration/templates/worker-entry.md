# Worker Entry Templates

## src/server.ts

```typescript
// CRITICAL: import "./setup" MUST be the first import.
// Without it, server functions in Vite split modules have empty state
// (blocks, registry, commerce loaders) causing 404 on client-side navigation.
import "./setup";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

export default createStartHandler(defaultStreamHandler);
```

## src/worker-entry.ts

```typescript
// CRITICAL: import "./setup" MUST be the first import.
import "./setup";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
import {
  handleMeta,
  handleDecofileRead,
  handleDecofileReload,
  handleRender,
  corsHeaders,
} from "@decocms/start/admin";
// Only if using VTEX:
import { shouldProxyToVtex, proxyToVtex } from "@decocms/apps/vtex/utils/proxy";

const serverEntry = createServerEntry({
  async fetch(request) {
    return await handler.fetch(request);
  },
});

export default createDecoWorkerEntry(serverEntry, {
  admin: {
    handleMeta,
    handleDecofileRead,
    handleDecofileReload,
    handleRender,
    corsHeaders,
  },
  // VTEX proxy — routes like /api/*, /checkout/*, /arquivos/* go to VTEX
  proxyHandler: (request, url) => {
    if (shouldProxyToVtex(url.pathname)) {
      return proxyToVtex(request);
    }
    return null;
  },
});
```

## Key Rules

1. **`import "./setup"` is ALWAYS the first line** — both files. This registers sections, loaders, blocks, and commerce config before any server function executes.
2. **Admin handlers go in `createDecoWorkerEntry`** — NOT inside `createServerEntry`. TanStack Start's build strips custom fetch logic from `createServerEntry` in production.
3. **Proxy handler** — Optional. Only needed for platforms (VTEX, Shopify) that require server-side proxying.
4. **Request flow**: `createDecoWorkerEntry` → admin routes (first) → cache check → proxy check → `serverEntry.fetch()` (TanStack Start).

## Why `import "./setup"` Must Be First

TanStack Start compiles `createServerFn()` calls into "split modules" — separate Vite module instances. Module-level state (blockData, commerceLoaders, sectionRegistry) initialized in `setup.ts` only exists in the original module instance. Without importing setup first, these split modules execute with empty state.

The fix in `@decocms/start` uses `globalThis.__deco` to share state across all module instances. But `setup.ts` must run BEFORE any server function is called — which means it must be imported before `createStartHandler` or `createServerEntry`.
