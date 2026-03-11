# SDK Utilities

All utilities exported from `@decocms/start/sdk/*`.

## useScript (`sdk/useScript.ts`)

Serialize functions as inline scripts for SSR with lightweight minification:

```typescript
function useScript<T extends (...args: any[]) => void>(fn: T, ...args: Parameters<T>): string
function useScriptAsDataURI<T extends (...args: any[]) => void>(fn: T, ...args: Parameters<T>): string
```

Features:
- **Minification**: `minifyJs()` removes comments (single-line + multi-line), collapses whitespace, trims lines
- **LRU Cache**: Minified function bodies are cached (128 entries) to avoid redundant work across renders
- Properly typed with generic constraints on function parameters

Also exports stubs for partial section support:

```typescript
function usePartialSection<T>(options: { props?: Partial<T> }): Record<string, string>
function useSection<T>(options: { props?: Partial<T> }): string
```

Note: These are stubs. Use TanStack Query + Router navigation instead.

## useDevice (`sdk/useDevice.ts`)

Server-side device detection based on User-Agent via RequestContext:

```typescript
type Device = "mobile" | "tablet" | "desktop";

function detectDevice(userAgent: string | null): Device     // Pure function, no context needed
function useDevice(): Device                                  // Hook using RequestContext
function checkMobile(): boolean                               // Direct context access
function checkTablet(): boolean                               // Direct context access
function checkDesktop(): boolean                              // Direct context access
```

- `detectDevice` is a standalone pure function (usable in middleware, workers, etc.)
- `useDevice` reads from `RequestContext.current` (server-side via AsyncLocalStorage)
- `checkMobile`/`checkTablet`/`checkDesktop` access `RequestContext` directly (not hooks)

Export path: `@decocms/start/sdk/useDevice`

## Signal (`sdk/signal.ts`)

Reactive signal replacing `@preact/signals`, backed by `@tanstack/store`:

```typescript
function signal<T>(initialValue: T): ReactiveSignal<T>
```

## Analytics (`sdk/analytics.ts`)

Client-side event tracking via `data-event` attributes:

```typescript
function useSendEvent(events: AnalyticsEvent[]): string
const ANALYTICS_SCRIPT: string
function gtmScript(containerId: string): string
```

## Cookie (`sdk/cookie.ts`)

Universal cookie utilities:

```typescript
function getCookie(name: string): string | undefined        // client
function setCookie(name: string, value: string, opts?): void // client
function deleteCookie(name: string): void                    // client
function getServerSideCookie(header: string, name: string): string | undefined
function decodeCookie(value: string): string
```

## Invoke (`sdk/invoke.ts`)

Client-side RPC proxy for calling server loaders:

```typescript
function createInvokeProxy<T>(baseUrl?: string): InvokeProxy<T>
function batchInvoke(calls: InvokeCall[]): Promise<any[]>
function invokeQueryOptions(key: string, props?: any): UseQueryOptions
```

Integrates with TanStack Query: `useQuery(invokeQueryOptions("vtex/loaders/productList.ts", { query }))`.

## Redirects (`sdk/redirects.ts`)

CMS-managed redirect system supporting CMS blocks and CSV import:

```typescript
function loadRedirects(blocks: Record<string, any>): Map<string, Redirect>
function matchRedirect(path: string, redirects: Map): Redirect | null
function parseRedirectsCsv(csv: string): Redirect[]
function addRedirects(redirects: Redirect[]): void
```

## Sitemap (`sdk/sitemap.ts`)

XML sitemap generation:

```typescript
function getCMSSitemapEntries(blocks: Record<string, any>): SitemapEntry[]
function generateSitemapXml(entries: SitemapEntry[]): string
function generateSitemapIndexXml(sitemaps: string[]): string
```

## RequestContext (`sdk/requestContext.ts`)

AsyncLocalStorage-based per-request context:

```typescript
const RequestContext: {
  bind<T>(data: RequestContextData, fn: () => T): T;
  get(): RequestContextData | undefined;
}
```

## Server Timings (`sdk/serverTimings.ts`)

HTTP Server-Timing header utility.

## Instrumented Fetch (`sdk/instrumentedFetch.ts`)

Fetch wrapper with logging and tracing:

```typescript
function createInstrumentedFetch(options?: { tracer?: Tracer }): typeof fetch
function instrumentFetch(tracer?: Tracer): void
```

## Observability (`middleware/observability.ts`)

Pluggable tracing and metrics infrastructure:

```typescript
// Tracer (existing)
interface TracerAdapter { startSpan(name, fn): T; activeSpan(): Span | undefined }
function configureTracer(tracer: TracerAdapter): void
function withTracing<T>(name: string, fn: () => T): T

// Meter (new)
interface MeterAdapter {
  counterInc(name: string, value?: number, labels?: Record<string, string>): void
  gaugeSet(name: string, value: number, labels?: Record<string, string>): void
  histogramRecord(name: string, value: number, labels?: Record<string, string>): void
}
function configureMeter(meter: MeterAdapter): void
function getMeter(): MeterAdapter | undefined

// Standardized metric names
const MetricNames = {
  HTTP_REQUESTS_TOTAL, HTTP_REQUEST_DURATION, HTTP_INFLIGHT,
  CACHE_HITS_TOTAL, CACHE_MISSES_TOTAL,
  RESOLVE_DURATION, RESOLVE_ERRORS, INVOKE_DURATION
}

// Convenience recorders
function recordRequestMetric(method, path, status, duration): void
function recordCacheMetric(hit: boolean, source: string): void

// Enhanced logging
function logRequest(method, url, status, duration): void  // Includes trace ID if available
```

## Health Metrics (`middleware/healthMetrics.ts`)

Request tracking and health probe endpoint:

```typescript
function trackRequest(): { start(): void; end(status: number): void }
function getHealthMetrics(): HealthMetrics
function handleHealthCheck(request: Request): Response
```

`/deco/_health` returns JSON with:
- `uptime`: seconds since process start
- `requests`: total, inflight, errors, statusCodes breakdown
- `cache`: stats from `getLoaderCacheStats()` (hits, misses, size, hitRate)
- `memory`: RSS, heap total/used (if `process.memoryUsage` available)

Export path: `@decocms/start/middleware/healthMetrics`

## Other Utilities

| Utility | File | Purpose |
|---------|------|---------|
| `clx` | `sdk/clx.ts` | CSS class combiner (like `clsx`) |
| `useId` | `sdk/useId.ts` | React `useId` wrapper |
| `wrapCaughtErrors` | `sdk/wrapCaughtErrors.ts` | Deferred error proxy for resilient rendering |
| `setCSPHeaders` | `sdk/csp.ts` | CSP frame-ancestors for admin iframe |
| `stripTrackingParams` | `sdk/urlUtils.ts` | Remove UTM/tracking params from URLs |
| `mergeCacheControl` | `sdk/mergeCacheControl.ts` | Merge Cache-Control headers (most restrictive wins) |
| `createCachedLoader` | `sdk/cachedLoader.ts` | In-memory SWR cache for loaders (with `getLoaderCacheStats()` and `clearLoaderCache()`) |
