# Runtime (`runtime/`)

The runtime handles HTTP requests, routing, rendering, and the invoke API. Built on Hono with Fresh or HTMX rendering.

## Entry Point: Deco class (`runtime/mod.ts`)

```typescript
class Deco {
  constructor(options: DecoOptions);
  handler(): Deno.ServeHandler;
  render(params): Promise<string>;
  meta(): { schema, manifest };
  styles(): string;
  dispose(): void;
}
```

## Request Flow (`runtime/handler.tsx`)

```
Hono App
  |-- Middleware: bindings     (sets RENDER_FN, GLOBALS)
  |-- Middleware: liveness     (/deco/_liveness probes)
  |-- Middleware: statebuilder (prepareState, debug, echo)
  |-- Middleware: observability (OpenTelemetry trace/span)
  |-- Middleware: main         (CORS, Cache-Control, segment)
  |
  |-- GET /styles.css           -> tailwind CSS
  |-- GET /live/_meta            -> schema + manifest
  |-- GET /deco/meta             -> alias for _meta
  |-- ALL /live/release          -> release info
  |-- ALL /.decofile/reload      -> trigger state reload
  |-- GET /live/inspect/:block   -> block inspector
  |-- POST /live/invoke          -> batch invoke
  |-- ALL /live/invoke/*         -> single invoke by key
  |-- ALL /live/previews         -> preview index
  |-- ALL /live/previews/*       -> block preview
  |-- POST /deco/render          -> partial section render
  |-- ALL /live/workflows/run    -> trigger workflow
  |-- ALL * (catch-all)          -> page handler (entrypoint)
```

## Middleware Chain

### 1. Bindings
Sets `RENDER_FN` (framework render function) and `GLOBALS` (error handler, dev flag).

### 2. Liveness (`runtime/middlewares/liveness.ts`)
Health probe at `/deco/_liveness` returning memory, uptime, requestCount, requestInflight.

### 3. State Builder
Creates resolve/invoke functions scoped to the request. Sets `state.deco` with DecoRuntimeState.

### 4. Observability
OpenTelemetry spans per request with `http.method`, `http.url`, `http.status_code`, `deco.site` attributes.

### 5. Main
CORS headers, Cache-Control, segment cookie handling, custom response headers from flags.

## Key Routes

### Invoke (`/live/invoke/*`)
Single-key invocation: `POST /live/invoke/site/loaders/productList.ts` with JSON body.

### Batch Invoke (`/live/invoke`)
Multiple invocations in one request with a multi-key JSON body.

### Render (`/deco/render`)
Partial section rendering used by `useSection` hook. Receives `props`, `href`, `pathTemplate`, `resolveChain`.

### Entrypoint (`*` catch-all)
1. Resolves `./routes/[...catchall].tsx` via `state.resolve`
2. Handler processes request
3. Calls `ctx.render(PageData)` for HTML output

## Rendering

### PageData
Contains `page` (resolved sections), `routerInfo` (URL, params), `loadingMode`.

### Section Rendering
Each section gets: SectionContext, ErrorBoundary, `withSection` HOC, framework-specific partial support.

## Frameworks

| Framework | Islands | Partials | Usage |
|-----------|---------|----------|-------|
| Fresh | Preact islands | `<Partial>` + `f-partial` | Standard Deco sites |
| HTMX | None (no JS) | `hx-get/hx-swap` | Lightweight alternative |

### Fresh (`runtime/fresh/`)
- `plugin.ts` / `plugin.tsx` for Fresh plugin registration
- `Bindings.tsx` provides `<Partial>`, `<Head>`
- `islands/DispatchAsyncRender.tsx` for lazy section loading via IntersectionObserver

### HTMX (`runtime/htmx/`)
- `Renderer.tsx` uses `renderToString(Preact)` for full server rendering
- No islands, no client-side hydration
- Uses `hx-get`, `hx-trigger`, `hx-target`, `hx-swap`

## Caching (`runtime/caches/`)

| Cache | Purpose |
|-------|---------|
| `lru.ts` | In-memory LRU (weak references) |
| `redis.ts` | Redis-backed cache |
| `tiered.ts` | LRU then Redis then origin |
| `fileSystem.ts` | Disk-based cache |

## Fetch Instrumentation (`runtime/fetch/`)

| File | Purpose |
|------|---------|
| `mod.ts` | Main fetch wrapper with logging + caching |
| `fetchLog.ts` | Logs fetch calls to OpenTelemetry |
| `fetchCache.ts` | HTTP cache (respects Cache-Control) |
