# Plugins and Clients

## Plugins (`plugins/`)

### Deco Plugin (`plugins/deco.ts`)

The main Fresh plugin that integrates Deco into a Fresh app.

```typescript
import { plugins } from "deco/plugins/deco.ts";

export default defineConfig({
  plugins: plugins({
    manifest,
    htmx: false,
    site: "mysite",
    ErrorFallback,
    useServer: true,
    middlewares: [],
  }),
});
```

Internally wraps `runtime/fresh/plugin.tsx`. Registers routes (`/[...catchall]`, `/index`), island (`DispatchAsyncRender.tsx`), selects framework (Fresh or HTMX), injects middleware chain.

### Fresh + Tailwind Plugin (`plugins/fresh.ts`)

Convenience that combines Tailwind CSS and Deco:

```typescript
import { plugins } from "deco/plugins/fresh.ts";

export default defineConfig({
  plugins: plugins({
    manifest,
    tailwind: { /* config */ },
  }),
});
```

Returns `[tailwindPlugin(config), decoPlugin(options)]`.

### Styles Plugin (`plugins/styles.ts`)

Injects global CSS into `<head>` via `id="__DECO_GLOBAL_STYLES__"`.

## Client-side Invoke (`clients/`)

### withManifest (`clients/withManifest.ts`)

Creates a typed invoke client for calling server loaders/actions from the browser.

```typescript
import { proxy } from "@deco/deco/web";
import type { Manifest } from "./manifest.gen.ts";

const invoke = proxy<Manifest>();

// Single invoke
const products = await invoke["site/loaders/productList.ts"]({ query: "shoes" });

// Batch invoke
const [products, categories] = await invoke({
  "site/loaders/productList.ts": { query: "shoes" },
  "site/loaders/categories.ts": {},
});
```

Internals: `fetchWithProps(key, props)` POSTs to `/live/invoke/${key}`. Supports `text/event-stream` for streaming.

### InvokeAwaiter (`clients/proxy.ts`)

Chainable proxy that builds invoke keys from property access:

```typescript
const invoke = proxy<Manifest>();

// Equivalent calls:
invoke["site/loaders/productList.ts"](props);
invoke.site.loaders["productList.ts"](props);
```

Uses JavaScript `Proxy` to build the key string from nested property access.

### Stream Reading

```typescript
import { readFromStream } from "@deco/deco/web";

const response = await invoke.streaming["site/loaders/feed.ts"]({});
for await (const chunk of readFromStream(response)) {
  console.log(chunk);
}
```

### FormData Utils (`clients/formdata.ts`)

Converts between objects and FormData:

```typescript
const formData = propsToFormData({ name: "John", address: { city: "SP" } });
// name=John, address.city=SP

const props = formDataToProps(formData);
// { name: "John", address: { city: "SP" } }
```

## Usage in Sites

### runtime.ts Pattern

Every Deco site has a `runtime.ts`:

```typescript
import { proxy } from "@deco/deco/web";
import type { Manifest } from "./manifest.gen.ts";
import type { Manifest as VTEXManifest } from "apps/vtex/manifest.gen.ts";

export const invoke = proxy<Manifest & VTEXManifest>();
```

Merges site + VTEX manifests for typed invocation.

### Client Usage

```typescript
import { invoke } from "../runtime.ts";

const products = await invoke.vtex.loaders.intelligentSearch.productListingPage({
  query: "shoes",
  page: 0,
  count: 12,
});
```

The invoke proxy builds the key from the property chain, POSTs to `/live/invoke/{key}`, and returns parsed JSON.
