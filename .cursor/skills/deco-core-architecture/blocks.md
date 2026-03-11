# Block System (`blocks/`)

Blocks are the type system of Deco. Each block type defines how a module is adapted into a resolver, previewed, and invoked.

## Block Interface

```typescript
interface Block<TBlockModule> {
  type: string;                    // manifest key: "sections", "loaders", etc.
  introspect?: {
    funcNames?: string[];
    includeReturn?: boolean;
  };
  adapt?: (mod: TBlockModule, key: string) => Resolver | Resolver[];
  decorate?: (mod: TBlockModule, key: string) => TBlockModule;
  defaultDanglingRecover?: Resolver;
  defaultPreview?: Resolver;
  defaultInvoke?: Resolver;
}
```

## BlockModule Convention

Every block module can export:

| Export | Purpose |
|--------|---------|
| `default` | Main function (loader, action, component, handler factory) |
| `invoke` | Custom invocation handler (for `/live/invoke`) |
| `preview` / `Preview` | Admin preview component |
| `onBeforeResolveProps` | Transform props before resolution |

## Block Types

### Section (`section.ts`)

UI components that render on the page. The most common block type.

```typescript
// type: "sections"
export default function MySection(props: Props) {
  return <div>{props.title}</div>;
}

// With server-side data loading:
export const loader = async (props: Props, req: Request, ctx: AppContext) => {
  const data = await fetchData(props);
  return { ...props, data };
};

export default function MySection({ data, title }: LoaderReturn) {
  return <div>{title}: {data}</div>;
}
```

Features: wraps Preact component as resolver returning `PreactComponent`, supports `loader` for SSR, `action` for forms, ErrorBoundary + SectionContext wrapper.

### Loader (`loader.ts`)

Data fetching functions with caching and single-flight dedup.

```typescript
// type: "loaders"
export default async function myLoader(
  props: Props,
  req: Request,
  ctx: AppContext
): Promise<Product[]> {
  return await ctx.invoke("vtex/loaders/productList.ts", props);
}
```

Features: cached (single-flight), OpenTelemetry tracing, invocable via `/live/invoke`.

### Action (`action.ts`)

Mutation functions (not cached).

```typescript
// type: "actions"
export default async function addToCart(
  props: { sku: string; quantity: number },
  req: Request,
  ctx: AppContext
): Promise<Cart> {
  return await ctx.invoke("vtex/actions/cart/addItems.ts", {
    orderItems: [{ id: props.sku, quantity: props.quantity, seller: "1" }]
  });
}
```

### Handler (`handler.ts`)

HTTP request handlers using a factory pattern.

```typescript
// type: "handlers"
export default function proxy(config: { url: string }) {
  return async (req: Request, ctx: ConnInfo): Promise<Response> => {
    return await fetch(new URL(req.url).pathname, { ...config });
  };
}
```

Used for proxies, redirects, sitemaps, and custom routes.

### Flag (`flag.ts`)

Feature flags with variant selection.

```typescript
// type: "flags"
// Simple boolean flag:
export default function myFlag(config: { percentage: number }) {
  return { name: "my-experiment", value: Math.random() < config.percentage };
}

// Multivariate:
export default function mvFlag(config: Config) {
  return {
    name: "checkout-v2",
    variants: [
      { value: "control", rule: { traffic: 0.5 } },
      { value: "experiment", rule: { traffic: 0.5 } },
    ],
  };
}
```

### Matcher (`matcher.ts`)

Predicates for audience segmentation.

```typescript
// type: "matchers"
export default function device(config: { mobile: boolean }) {
  return (ctx: MatchContext): boolean => {
    return ctx.device === "mobile" === config.mobile;
  };
}
```

Built-in matchers: MatchDevice, MatchCookie, MatchDate, MatchLocation, MatchHost, MatchRandom, MatchUserAgent, MatchSite, MatchMulti.

### App (`app.ts`)

Container that bundles manifest + state + dependencies.

```typescript
// type: "apps"
export default function MyApp(props: Props): App<Manifest, State> {
  return {
    manifest,
    state: { /* clients, config */ },
    dependencies: [otherApp(props)],
  };
}
```

`buildRuntime` processes the manifest, creating resolvers for each block module.

### Page (`page.tsx`)

Like section but page-level. Same mechanism.

### Workflow (`workflow.ts`)

Durable workflows using `@deco/durable`. Type: "workflows".

### Function (`function.ts`)

Legacy loader format. Deprecated in favor of `loader.ts`.

### Account (`account.ts`)

Platform configuration blocks. Returns account/config object.

## Block Registration Flow

1. `decoManifestBuilder()` scans directories matching block types
2. `manifest.gen.ts` is generated with imports and block keys
3. At startup, `buildRuntime()` processes each block:
   - `block.adapt(mod, key)` for each module
   - `block.decorate(mod, key)` applied before adapt
   - Resolvers registered: `key`, `Preview@key`, `Invoke@key`
   - `defaultDanglingRecover` registered per block type
4. All resolvers passed to `ReleaseResolver`

## Block Resolution Priority

When resolving `__resolveType`:
1. Check `resolvables[type]` (decofile state) then recurse
2. Check `resolvers[type]` (block resolvers) then invoke
3. Check `overrides[type]` then redirect
4. Fall back to `DanglingRecover@{blockType}` (StubSection)
5. Throw `DanglingReference` error
