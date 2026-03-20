# Hydration & SSR — Migration to TanStack Native Patterns

> Migration guide for `@decocms/start` to adopt TanStack Router/Start native SSR, hydration, and deferred data patterns. Eliminates custom server function workarounds and aligns with the framework's execution model.

---

## Table of Contents

1. [Current Architecture & Problems](#1-current-architecture--problems)
2. [TanStack Native Patterns We Should Adopt](#2-tanstack-native-patterns-we-should-adopt)
3. [Migration Plan](#3-migration-plan)
4. [Issue-by-Issue Fix Guide](#4-issue-by-issue-fix-guide)
5. [Testing Checklist](#5-testing-checklist)

---

## 1. Current Architecture & Problems

### How it works today

```
┌─────────────────────────────────────────────────────────┐
│                   CMS Page Request                       │
│                                                          │
│  1. loadCmsPage (GET server function)                    │
│     ├── resolves eager sections (Header, Footer, Theme)  │
│     └── extracts deferred section metadata               │
│                                                          │
│  2. SSR renders eager sections + skeleton placeholders   │
│                                                          │
│  3. Client hydrates, IntersectionObserver fires           │
│     └── loadDeferredSection (POST server function)       │
│         └── resolves section + runs loader                │
│         └── returns enriched props                        │
│                                                          │
│  4. Client renders the section, fades in                  │
└─────────────────────────────────────────────────────────┘
```

### Problems found in production

#### P1: `loadDeferredSection` fails in Cloudflare Workers dev mode

**Error:**
```
Cannot perform I/O on behalf of a different request.
I/O objects (such as streams, request/response bodies, and others) created
in the context of one request handler cannot be accessed from a different
request's handler. (I/O type: SpanParent)
```

**Root cause:** TanStack Start splits server functions into `?tss-serverfn-split` modules. In Vite dev mode, the Cloudflare worker module runner caches modules per-request. Request A (SSR page load) caches modules with SpanParent I/O objects, Request B (server function POST from client) tries to reuse them — fails because I/O objects are tied to Request A's context.

**Impact:** ALL deferred sections fail to load in dev mode. Sites must force sections eager via `alwaysEager`, defeating the purpose of async rendering.

#### P2: Eager sections without `registerSectionsSync` render blank

When a section is eager (in `resolvedSections`) but NOT registered via `registerSectionsSync()`, `DecoPageRenderer` renders it via `React.lazy` wrapped in `<Suspense fallback={null}>`. During hydration, if the lazy module isn't available synchronously, React unmounts the server HTML and shows the fallback (null) — a blank area.

**Why this wasn't noticed before:** Before hydration fixes, script mismatches caused React to do a full client re-render instead of hydration. `React.lazy` works fine on fresh renders, only fails during hydration.

#### P3: `useScript(fn)` causes hydration mismatch

`useScript(fn)` calls `fn.toString()` + `minifyJs()` to produce inline JavaScript. Vite compiles SSR and client bundles separately — React Compiler transforms may differ, producing different function body strings. Since `dangerouslySetInnerHTML.__html` is checked during hydration, any difference causes:

```
Warning: A tree hydrated but some attributes of the server rendered HTML
didn't match the client properties...
dangerouslySetInnerHTML.__html
```

**Affected:** `useScriptAsDataURI` has the same issue (it wraps `useScript`).

#### P4: Third-party scripts injected into `<head>` break hydration

GTM, Emarsys, and similar scripts inject `<script>` elements into `<head>` before React hydration begins. This shifts the DOM tree — React expects the same child count/order that the server rendered, finds extra nodes, and fails hydration.

#### P5: N+1 VTEX API calls when all sections are eager

When sites force all sections eager (workaround for P1), a typical homepage with 8-12 product shelves fires 16-24+ concurrent VTEX API calls during SSR. This causes:
- VTEX 503 rate limiting
- 10+ second SSR times
- OrderForm/login resolution failures

---

## 2. TanStack Native Patterns We Should Adopt

### 2.1 Deferred Data Loading with `defer()` + `<Await>`

**Source:** https://tanstack.com/router/latest/docs/guide/deferred-data-loading

TanStack Router has native deferred data support. Instead of a custom server function POST, we can return unawaited promises from the route loader:

```tsx
// Route loader
loader: async () => {
  // Fast: resolve immediately (Header, Footer, Theme)
  const eagerSections = await resolveEagerSections(page);

  // Slow: don't await — starts resolving, streams when ready
  const deferredSectionsPromise = resolveDeferredSections(page);

  return {
    eagerSections,
    deferredSections: deferredSectionsPromise, // unawaited!
  };
}
```

```tsx
// Component
function CmsPage() {
  const { eagerSections, deferredSections } = Route.useLoaderData();

  return (
    <>
      {eagerSections.map(s => <SectionRenderer key={s.index} section={s} />)}
      <Await promise={deferredSections} fallback={<SectionSkeletons />}>
        {(sections) => sections.map(s => <SectionRenderer key={s.index} section={s} />)}
      </Await>
    </>
  );
}
```

**Benefits:**
- Works in dev mode (no separate server function request)
- SSR streaming sends skeleton HTML first, then resolved sections
- Native TanStack cache/invalidation
- No IntersectionObserver needed for initial load

**With React 19 `use()` hook:**
```tsx
// React 19 alternative to <Await>
function DeferredSections({ promise }) {
  const sections = use(promise);
  return sections.map(s => <SectionRenderer key={s.index} section={s} />);
}
```

### 2.2 `<ClientOnly>` for Browser-Dependent Components

**Source:** https://tanstack.com/router/latest/docs/api/router/clientOnlyComponent

For components that use browser APIs or produce non-deterministic output (analytics, GTM, geolocation):

```tsx
import { ClientOnly } from '@tanstack/react-router';

// Analytics scripts — no SSR, no hydration mismatch
function GlobalAnalytics() {
  return (
    <ClientOnly fallback={null}>
      <VtexIsEvents />
      <Sourei gtmId="GTM-XXXXX" />
    </ClientOnly>
  );
}
```

**This replaces:** `suppressHydrationWarning`, moving scripts from `<head>` to `<body>`, converting `useScript(fn)` to string constants.

### 2.3 `useHydrated` Hook

**Source:** TanStack Router execution model

For components that need different render output pre/post hydration:

```tsx
import { useHydrated } from '@tanstack/react-router';

function CartButton() {
  const hydrated = useHydrated();

  if (!hydrated) {
    // SSR: render loading skeleton
    return <CartSkeleton />;
  }

  // Client: render interactive cart
  return <InteractiveCart />;
}
```

### 2.4 Selective SSR (`ssr: 'data-only'`)

**Source:** https://tanstack.com/start/latest/docs/framework/react/guide/selective-ssr

For routes where the loader should run on server but the component shouldn't render (shows `pendingComponent` as skeleton):

```tsx
export const Route = createFileRoute('/product/$slug')({
  ssr: 'data-only', // loader runs on server, component renders on client
  pendingComponent: () => <PDPSkeleton />,
  loader: async () => {
    return await loadProductData(); // runs server-side
  },
  component: ProductPage, // renders client-side only
});
```

**Use cases:**
- PDP with complex client-side interactions (image zoom, variant selector)
- Pages with lots of `useEffect` dependencies

### 2.5 `createIsomorphicFn` for Environment-Specific Logic

```tsx
import { createIsomorphicFn } from '@tanstack/react-start';

const getDeviceInfo = createIsomorphicFn()
  .server(() => ({ source: 'cf-headers', device: getDeviceFromHeaders() }))
  .client(() => ({ source: 'window', device: getDeviceFromWindow() }));
```

### 2.6 Loaders Are Isomorphic (Critical Understanding)

**Route loaders run on BOTH server (SSR) and client (SPA navigation).** They are NOT server-only.

```tsx
// ❌ Wrong assumption: loader is server-only
loader: () => {
  const secret = process.env.API_KEY; // EXPOSED to client bundle
  return fetch(`/api?key=${secret}`);
}

// ✅ Correct: use server function for server-only operations
const fetchSecurely = createServerFn().handler(() => {
  const secret = process.env.API_KEY; // server-only
  return fetch(`/api?key=${secret}`);
});

loader: () => fetchSecurely() // isomorphic call
```

**Implication for `@decocms/start`:** The `loadCmsPage` server function is correct — it's called from the loader and executes server-side. But CMS section loaders that access server-only resources (KV, D1) must also be wrapped in server functions.

---

## 3. Migration Plan

### Phase 1: Fix Hydration Mismatches (site-level, no framework changes)

| Task | Pattern | Files |
|------|---------|-------|
| Wrap analytics in `<ClientOnly>` | 2.2 | `GlobalAnalytics.tsx`, `Sourei.tsx` |
| Fix invalid HTML (`<span>` in `<option>`) | Standard React | `Sort.tsx` |
| Fix `selected` on `<option>` → `defaultValue` | Standard React | `Sort.tsx` |
| Move third-party scripts out of `<head>` | 2.2 | `__root.tsx` |

### Phase 2: Replace `useScript(fn)` with safe alternatives (framework)

| Task | Pattern | Files |
|------|---------|-------|
| Deprecate `useScript(fn)` | 2.2 | `sdk/useScript.ts` |
| Add `inlineScript(str)` helper | New utility | `sdk/useScript.ts` |
| Add dev warning when `fn.toString()` differs | DX improvement | `sdk/useScript.ts` |
| Document string constant pattern | Docs | This file |

**New helper:**
```tsx
// sdk/useScript.ts

/** @deprecated Use plain string constants with dangerouslySetInnerHTML instead.
 *  fn.toString() produces different output in SSR vs client Vite builds,
 *  causing hydration mismatches. */
export function useScript(fn: Function, ...args: unknown[]): string { ... }

/** Safe inline script — returns props for <script> element. */
export function inlineScript(js: string) {
  return { dangerouslySetInnerHTML: { __html: js } } as const;
}
```

### Phase 3: Adopt `defer()` + `<Await>` for deferred sections (framework)

This is the biggest change. Replace the custom `loadDeferredSection` POST server function with TanStack Router's native deferred data loading.

#### 3.1 Change `cmsRoute.ts` loader to return deferred promises

```tsx
// BEFORE (current)
loader: async () => {
  const page = await loadCmsPage({ data: { path, searchParams } });
  return {
    resolvedSections: page.resolvedSections,     // eager sections
    deferredSections: page.deferredSections,      // metadata only
    // client must call loadDeferredSection() POST to resolve each one
  };
}

// AFTER (native deferred)
loader: async () => {
  const page = await loadCmsPage({ data: { path, searchParams } });

  // Start resolving deferred sections NOW but don't await
  const deferredPromise = resolveDeferredSectionsInParallel(
    page.deferredSections, page.pagePath, page.pageUrl
  );

  return {
    resolvedSections: page.resolvedSections,       // eager — awaited
    deferredSections: deferredPromise,             // deferred — streaming!
  };
}
```

#### 3.2 Change `DecoPageRenderer` to use `<Await>`

```tsx
// BEFORE (current)
function DecoPageRenderer({ resolvedSections, deferredSections, loadDeferredSectionFn }) {
  const merged = mergeSections(resolvedSections, deferredSections);
  return merged.map(section =>
    section.type === 'deferred'
      ? <DeferredSectionWrapper ... loadFn={loadDeferredSectionFn} />
      : <EagerSectionWrapper ... />
  );
}

// AFTER (native deferred)
function DecoPageRenderer({ resolvedSections, deferredSectionsPromise }) {
  return (
    <>
      {resolvedSections.map(s => <SectionRenderer key={s.index} section={s} />)}
      <Await
        promise={deferredSectionsPromise}
        fallback={<DeferredSkeletons sections={deferredSections} />}
      >
        {(resolved) => resolved.map(s => <SectionRenderer key={s.index} section={s} />)}
      </Await>
    </>
  );
}
```

#### 3.3 Keep IntersectionObserver as optimization (optional)

For below-the-fold deferred sections, we can still use IntersectionObserver to delay client-side rendering until scroll. But the data is already loaded (streamed) — we just defer the React render.

```tsx
function LazyRenderSection({ section }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { rootMargin: '300px' }
    );
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, []);

  if (!visible) return <div ref={ref}><SectionSkeleton section={section} /></div>;
  return <SectionRenderer section={section} />;
}
```

### Phase 4: Add `<ClientOnly>` support for section registration (framework)

Allow sections to declare they're client-only:

```tsx
// setup.ts
registerSectionsSync({
  "site/sections/Sourei/Sourei.tsx": SoureiModule,
}, { clientOnly: true }); // wraps in <ClientOnly> automatically
```

Or per-section:
```tsx
registerSection("site/sections/Sourei/Sourei.tsx", SoureiModule, {
  clientOnly: true,
  loadingFallback: () => null,
});
```

### Phase 5: Add dev warnings for common mistakes (framework)

```tsx
// DecoPageRenderer.tsx — warn if eager section is not sync-registered
if (import.meta.env.DEV && !getSyncComponent(section.component)) {
  console.warn(
    `[DecoPageRenderer] Eager section "${section.component}" is not in registerSectionsSync(). ` +
    `This will cause blank content during hydration. Add it to registerSectionsSync() in setup.ts.`
  );
}

// useScript.ts — warn about fn.toString() risk
if (import.meta.env.DEV) {
  const ssrStr = fn.toString();
  console.warn(
    `[useScript] Using fn.toString() for "${fn.name || 'anonymous'}". ` +
    `This may produce different output in SSR vs client builds. ` +
    `Consider using a plain string constant instead.`
  );
}
```

---

## 4. Issue-by-Issue Fix Guide

### P1 Fix: Server function I/O error → Use `defer()` (Phase 3)

**Before:** Client makes POST to `loadDeferredSection` → separate request → I/O error
**After:** Deferred sections resolve in the SAME request via `defer()` → streamed to client

No separate server function request = no cross-request I/O issue.

### P2 Fix: Blank eager sections → Dev warning + `syncThenable` fallback (Phase 5)

**Quick fix:** Warning in dev mode when an eager section isn't sync-registered.

**Proper fix:** In `DecoPageRenderer`, for eager sections without sync registration, create a `syncThenable` from the server-resolved component module instead of using bare `React.lazy`:

```tsx
// If the component was resolved on the server, pre-populate the lazy cache
// with a syncThenable so hydration doesn't trigger Suspense
const resolvedModule = getResolvedComponent(section.component);
if (resolvedModule) {
  const syncLazy = React.lazy(() => syncThenable({ default: resolvedModule }));
  // This won't trigger Suspense during hydration
}
```

### P3 Fix: `useScript(fn)` mismatch → Deprecate + `inlineScript()` helper (Phase 2)

**Site-level workaround (now):** Convert to plain string constants.
**Framework fix (Phase 2):** Deprecate `useScript(fn)`, add `inlineScript(str)` helper.

### P4 Fix: Third-party scripts in head → `<ClientOnly>` (Phase 1)

**Site-level:** Wrap analytics/GTM in `<ClientOnly fallback={null}>`.
**Framework:** Add `clientOnly` option to section registration (Phase 4).

### P5 Fix: N+1 VTEX calls → Concurrency limiter + keep shelves deferred (Phase 3)

With `defer()`, deferred sections resolve server-side but stream progressively. Add a concurrency limiter:

```tsx
// sdk/concurrency.ts
export function createConcurrencyLimiter(max: number) {
  let inflight = 0;
  const queue: Array<() => void> = [];

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (inflight >= max) {
      await new Promise<void>(resolve => queue.push(resolve));
    }
    inflight++;
    try {
      return await fn();
    } finally {
      inflight--;
      queue.shift()?.();
    }
  };
}

// Usage in VTEX fetch
const vtexLimit = createConcurrencyLimiter(6);
const response = await vtexLimit(() => fetch(vtexUrl));
```

---

## 5. Testing Checklist

### Hydration

- [ ] No `dangerouslySetInnerHTML.__html` mismatch warnings in console
- [ ] No "hydration failed" React warnings
- [ ] Server HTML matches client render (inspect source vs DOM)
- [ ] `suppressHydrationWarning` only on `<html>` and `<body>` (not as a blanket fix)

### Deferred Sections

- [ ] Skeletons show immediately on page load
- [ ] Deferred content appears progressively (not all at once)
- [ ] Back/forward navigation shows cached content instantly
- [ ] SPA navigation to PLP shows skeleton → products
- [ ] SearchResult preserves URL params (filters, sort, pagination) after hydration

### Performance

- [ ] SSR time < 3s for homepage (with shelves deferred)
- [ ] SSR time < 2s for PLP (SearchResult deferred or eager with fast VTEX)
- [ ] No VTEX 503 errors during SSR
- [ ] CLS < 0.1 (skeletons match final content dimensions)
- [ ] FCP < 1.5s (eager sections render immediately)

### Dev Mode

- [ ] Deferred sections load in dev mode (no I/O error)
- [ ] HMR works for section components
- [ ] Console shows helpful warnings for misconfigured sections

### Edge Cases

- [ ] Bot/crawler gets full HTML (no deferred skeletons)
- [ ] JavaScript disabled: eager sections visible, deferred shows skeleton
- [ ] Slow network: skeleton persists, no blank flash
- [ ] Multiple deferred sections on same page all resolve

---

## References

- [TanStack Router — Deferred Data Loading](https://tanstack.com/router/latest/docs/guide/deferred-data-loading)
- [TanStack Start — Hydration Errors](https://tanstack.com/start/latest/docs/framework/react/guide/hydration-errors)
- [TanStack Start — Selective SSR](https://tanstack.com/start/latest/docs/framework/react/guide/selective-ssr)
- [TanStack Start — Execution Model](https://tanstack.com/start/latest/docs/framework/react/guide/execution-model)
- [TanStack Router — ClientOnly Component](https://tanstack.com/router/latest/docs/api/router/clientOnlyComponent)
- [TanStack Router — SSR Guide](https://tanstack.com/router/latest/docs/guide/ssr)
- [Cloudflare Workers — Cross-Request I/O](https://developers.cloudflare.com/workers/runtime-apis/context/)
