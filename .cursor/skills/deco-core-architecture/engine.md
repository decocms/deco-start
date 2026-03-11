# Resolution Engine (`engine/`)

The heart of Deco — resolves configuration objects (Resolvables) into runtime values using a pipeline of resolvers.

## Core Concepts

### Resolvable

An object with `__resolveType` that tells the engine which resolver to use:

```typescript
interface Resolvable<T = unknown> {
  __resolveType: string;  // resolver key (e.g. "site/loaders/productList.ts")
  [key: string]: unknown; // props passed to the resolver
}
```

### Resolver

A function that processes a Resolvable:

```typescript
type Resolver<T = unknown> = (
  parent: T,           // resolved props from the Resolvable
  context: ResolverContext
) => T | Resolvable<T> | Promise<T | Resolvable<T>>;
```

### ResolverContext

```typescript
interface ResolverContext {
  resolvables: Record<string, Resolvable>;  // decofile state
  resolvers: Record<string, Resolver>;      // all registered resolvers
  resolve: (resolvable: Resolvable | string) => Promise<unknown>;
  resolveChain: FieldResolver[];            // debug: resolution path
  memo: Map<string, Promise<unknown>>;      // memoization cache
  runOnce: (key: string, fn: () => Promise<T>) => Promise<T>;
  revision: string;
}
```

## Resolution Pipeline

```
resolve(input)
  │
  ├─ string → resolveWithType(resolveType, {}, context)
  │
  └─ Resolvable → resolveAny()
       │
       └─ resolvePropsWithHints()
            │
            ├─ Extract __resolveType
            ├─ Call onBeforeResolveProps (if defined)
            ├─ Resolve each prop recursively (parallel)
            └─ resolveWithType(__resolveType)
                 │
                 ├─ In resolvables? → resolveResolvable() [with memo]
                 ├─ In resolvers?   → invokeResolverWithProps()
                 └─ Else            → danglingRecover or DanglingReference error
```

### Key Functions (`engine/core/resolver.ts`)

| Function | Purpose |
|----------|---------|
| `resolve(input, ctx)` | Main entry — handles string refs and Resolvable objects |
| `resolveAny(obj, ctx)` | Resolves an arbitrary object, recursing into props |
| `resolvePropsWithHints(obj, ctx)` | Uses hint nodes to efficiently resolve only resolvable props |
| `resolveWithType(type, props, ctx)` | Resolves by looking up type in resolvables or resolvers |
| `resolveResolvable(id, ctx)` | Resolves a named resolvable with memoization |
| `invokeResolverWithProps(type, props, ctx)` | Calls the resolver function with resolved props |

### Resolution Hints (`engine/core/hints.ts`)

Optimization to avoid scanning all props. `HintNode` trees mark which properties contain resolvables:

```typescript
interface HintNode {
  __resolveType?: boolean;  // this object is a Resolvable
  [prop: string]: HintNode; // nested hints
}
```

`traverseAny()` builds hints from the decofile. The resolver only recurses into hinted paths.

### Memoization

`resolveResolvable` memos results by `resolverIdFromResolveChain`. Same resolvable in the same resolution tree returns the cached promise.

## Resolve Chain

A debug/tracing mechanism. Each resolution step appends a `FieldResolver`:

```typescript
type FieldResolver =
  | { type: "prop"; value: string }       // accessing a property
  | { type: "resolvable"; value: string } // resolving a named resolvable
  | { type: "resolver"; value: string }   // invoking a resolver
  | { type: "dangling"; value: string }   // unresolved reference
```

Used for cache keys, tracing, and error reporting.

## ReleaseResolver (`engine/core/mod.ts`)

Top-level coordinator:

```typescript
function ReleaseResolver(
  decofileProvider: DecofileProvider,
  resolvers: Record<string, Resolver>,
  options?: { danglingRecover?, overrides?, forceFresh? }
): {
  resolve: (resolvable | string) => Promise<unknown>;
  state: () => ResolvableMap;
  revision: () => string;
}
```

- Gets `resolvables` and `revision` from the DecofileProvider
- Combines default resolvers + block resolvers + app resolvers
- Provides the top-level `resolve()` function used by the runtime

## DecofileProvider (`engine/decofile/`)

Interface for state management (the decofile is the CMS state):

```typescript
interface DecofileProvider {
  state(): Record<string, Resolvable>;    // current state
  revision(): string;                      // version/etag
  onChange(cb: () => void): void;          // subscribe to changes
  dispose?(): void;
}
```

### Implementations

| Provider | Source | Usage |
|----------|--------|-------|
| `newFsProvider` | Local filesystem (`.json`, `.jsonl`) | Dev mode |
| `jsonProvider` | In-memory JSON object | Testing, static |
| `realtimeProvider` | CMS websocket connection | Production |
| `fsFolderProvider` | `folder://` directory with individual files | Legacy |

### State Lifecycle

1. `DecofileProvider.state()` returns current `ResolvableMap`
2. Engine creates `ReleaseResolver` with this state
3. Provider emits `onChange()` when CMS publishes
4. Engine reinstalls apps and rebuilds resolvers

## Manifest System (`engine/manifest/`)

### ManifestBuilder

Programmatically builds a manifest file:

```typescript
interface ManifestData {
  namespace: string;
  imports: Record<string, string>;     // import name → module path
  manifest: Record<string, string[]>;  // block type → keys
  exports: Record<string, string>;
  statements: string[];
}
```

Key methods:
- `mergeWith(other)` — merge manifests from multiple apps
- `addValuesOnManifestKey(key, values)` — add blocks by type
- `build()` — generate the `.ts` file content

### manifestGen

`decoManifestBuilder()` walks directories by block type, calling `withDefinition()` for each discovered module.

### Default Resolvers (`engine/manifest/defaults.ts`)

Built-in resolvers available in every Deco instance:

| Resolver | Purpose |
|----------|---------|
| `state` | Returns raw resolvable value |
| `resolvables` | Access resolvables map |
| `resolvers` | Access resolvers map |
| `once` | Run-once resolver (memoized) |
| `resolveTypeSelector` | Dynamic __resolveType selection |
| `blockSelector` | Select block by type |
| `selectKeys` | Pick specific keys from resolved object |
| `mergeProps` | Deep-merge multiple resolved objects |
| `resolved` | Mark value as already resolved |
| `preview` | `Preview@{block}` namespace |
| `invoke` | `Invoke@{block}` namespace |

## Schema System (`engine/schema/`)

Generates JSON Schema from TypeScript types at runtime:

| File | Purpose |
|------|---------|
| `schemeable.ts` | Core schema types (`Schemeable`) |
| `builder.ts` | Builds JSON Schema from scheemables |
| `parser.ts` | Parses TypeScript AST into scheemables |
| `merge.ts` | Merges schemas from multiple sources |
| `reader.ts` | Reads and caches module schemas |
| `transform.ts` | Schema transformations (refs, ids) |
| `lazy.ts` | Lazy schema loading for performance |

Used by the admin to generate forms for block props.

## Import Map (`engine/importmap/`)

Builds Deno import maps for blocks:

- `buildImportMap(manifest)` — generates imports for each block
- `FuncAddr.build()` — creates `resolve://path?export=funcName` addresses
- Supports JSR (`jsr:`) and URL imports
