---
name: deco-async-rendering-architecture
description: Architecture and internals of Async Section Rendering in @decocms/start. Documents the server-side eager/deferred split (resolve.ts) using CMS Lazy.tsx wrappers as source of truth, client-side IntersectionObserver loading (DecoPageRenderer.tsx), per-section SWR caching (sectionLoaders.ts), bot detection for SEO, the loadDeferredSection server function, and the full request flow from CMS page resolution to on-scroll hydration. Use when debugging async rendering, extending the framework, understanding how deferred sections are resolved, or troubleshooting why a section is/isn't being deferred.
---

# Deco Async Section Rendering — Framework Architecture

Internal documentation for the async section rendering system in `@decocms/start`.

## When to Use This Skill

- Debugging why a section is or isn't being deferred
- Understanding the full request flow from CMS resolution to on-scroll loading
- Extending the async rendering system (new cache tiers, new deferral strategies)
- Fixing issues with deferred section data resolution
- Understanding how bot detection and SEO safety work
- Working on `@decocms/start` framework code

---

## Problem Solved

TanStack Start serializes all `loaderData` as JSON in a `<script>` tag for client-side hydration. When a CMS page has 20+ sections with commerce data, the HTML payload becomes enormous (8+ MB on some pages). The root cause: `resolveDecoPage` fully resolves ALL sections, and TanStack Start embeds everything.

## Architecture Overview

```
Request → resolveDecoPage()
  ├─ resolveSectionsList()     → unwrap flags/blocks to get raw section array
  ├─ shouldDeferSection()      → classify each section as eager or deferred
  │   ├─ Eager: resolveRawSection() → full CMS + commerce resolution
  │   └─ Deferred: resolveSectionShallow() → component key + raw CMS props only
  ├─ runSectionLoaders()       → enrich eager sections (server loaders)
  └─ Return { resolvedSections, deferredSections }

Client render → DecoPageRenderer
  ├─ mergeSections()           → interleave eager + deferred by original index
  ├─ Eager: <Suspense><LazyComponent .../></Suspense>
  └─ Deferred: <DeferredSectionWrapper>
       ├─ preloadSectionModule() → get LoadingFallback early
       ├─ Render skeleton (custom LoadingFallback or generic)
       ├─ IntersectionObserver(rootMargin: 300px)
       └─ On intersect: loadDeferredSection serverFn
            ├─ resolveDeferredSection() → resolve __resolveType refs in rawProps
            ├─ runSingleSectionLoader() → enrich with server loader
            └─ Return ResolvedSection → render real component with fade-in
```

---

## Deferral Strategy: CMS Lazy.tsx as Source of Truth

### How it works now (respectCmsLazy)

The deferral decision is driven by **CMS editor choices**, not a global index threshold:

1. **`respectCmsLazy: true`** (default) — a section is deferred if and only if it's wrapped in `website/sections/Rendering/Lazy.tsx` in the CMS page JSON
2. **`foldThreshold`** (default `Infinity`) — fallback for sections NOT wrapped in Lazy; with default `Infinity`, non-wrapped sections are always eager
3. **`alwaysEager`** — section keys that override all deferral (Header, Footer, Theme, etc.)

### Why this approach

The previous `foldThreshold` approach deferred sections by index position, ignoring editor intent. This caused:
- Sections that editors wanted eager getting deferred
- No control per-page (threshold was global)
- Homepage with 12 sections marked Lazy in CMS showing 0 deferred

Now editors control deferral by wrapping sections in `Lazy.tsx` in the CMS admin, and the framework respects that.

### `isCmsLazyWrapped(section)` in `resolve.ts`

Detects whether a section is wrapped in `website/sections/Rendering/Lazy.tsx`, either:
- Directly: `section.__resolveType === "website/sections/Rendering/Lazy.tsx"`
- Via named block: `section.__resolveType` references a block whose `__resolveType` is `"website/sections/Rendering/Lazy.tsx"`

### `shouldDeferSection(section, flatIndex, cfg, isBotReq)`

Updated decision logic:

```
1. Bot request? → EAGER (SEO safety)
2. No __resolveType? → EAGER (can't classify)
3. Is multivariate flag? → EAGER (requires runtime evaluation)
4. resolveFinalSectionKey() → walk block refs + Lazy wrappers to find final component
5. In alwaysEager set? → EAGER
6. isLayoutSection()? → EAGER
7. respectCmsLazy && isCmsLazyWrapped(section)? → DEFER
8. flatIndex >= foldThreshold? → DEFER (fallback, only if not wrapped)
9. Otherwise → EAGER
```

---

## Files and Their Roles

| File | Layer | Role |
|------|-------|------|
| `src/cms/resolve.ts` | Server | Types, config, eager/deferred split, CMS Lazy detection, shallow resolution, full deferred resolution |
| `src/cms/sectionLoaders.ts` | Server | Section loader registry, layout cache, SWR cacheable sections, `runSingleSectionLoader` |
| `src/cms/registry.ts` | Shared | Section component registry, `preloadSectionModule` for early LoadingFallback |
| `src/routes/cmsRoute.ts` | Server | `loadCmsPage`, `loadCmsHomePage`, `loadDeferredSection` server functions |
| `src/hooks/DecoPageRenderer.tsx` | Client | Merge, render eager/deferred, `DeferredSectionWrapper`, dev warnings |
| `src/cms/index.ts` | Barrel | Re-exports all public types and functions |
| `src/routes/index.ts` | Barrel | Re-exports route helpers including `loadDeferredSection` |

---

## Server-Side: Eager/Deferred Split

### Entry point: `resolveDecoPage()` in `resolve.ts`

```
resolveDecoPage(targetPath, matcherCtx)
  1. findPageByPath(targetPath) → { page, params }
  2. Get raw sections array:
     - If page.sections is Array → use directly
     - If page.sections is wrapped (multivariate flag, block ref) → resolveSectionsList()
  3. For each raw section:
     - If shouldDeferSection() → resolveSectionShallow() → DeferredSection
     - Else → resolveRawSection() (full resolution) → ResolvedSection[]
  4. Return { resolvedSections, deferredSections }
```

### `resolveSectionsList(value, rctx, depth)`

Resolves **only the outer wrapper** around the sections array. Handles multivariate flags, named block references, and `resolved` type wrappers. Extracts the raw section array WITHOUT resolving individual section commerce loaders.

### `resolveFinalSectionKey(section)`

Walks block reference chain and unwraps `Lazy` wrappers to find the final registered section component key:

```
"Header - 01" (named block)
  → { __resolveType: "website/sections/Rendering/Lazy.tsx", section: {...} }
    → { __resolveType: "site/sections/Header/Header.tsx", ...props }
```

Returns `"site/sections/Header/Header.tsx"`, checked against `alwaysEager` and `isLayoutSection`.

### `resolveSectionShallow(section)`

Synchronously follows block refs and unwraps Lazy to extract `component` (final key) and `rawProps` (CMS props as-is). No API calls, no async.

### `resolveDeferredSection(component, rawProps, pagePath, matcherCtx)`

Called when client requests a deferred section. Runs full resolution:
1. `resolveProps(rawProps, rctx)` — resolves all nested `__resolveType` references
2. `normalizeNestedSections(resolvedProps)` — converts nested sections to `{ Component, props }`
3. Returns `ResolvedSection` ready for `runSingleSectionLoader`

---

## Server-Side: Section Caching

### Three cache tiers in `sectionLoaders.ts`

**Tier 1: Layout sections** (Header, Footer, Theme)
- 5-minute TTL, in-flight dedup, registered via `registerLayoutSections`

**Tier 2: Cacheable sections** (ProductShelf, FAQ)
- Configurable TTL via `registerCacheableSections`, SWR semantics, LRU eviction at 200 entries
- Cache key: `component::djb2Hash(JSON.stringify(props))`

**Tier 3: Regular sections** — No caching, always fresh.

---

## Client-Side: DeferredSectionWrapper

### Lifecycle

```
1. Mount (stableKey = pagePath + component + index)
   ├─ preloadSectionModule(component) → extract LoadingFallback
   └─ Render skeleton (custom or generic DefaultSectionFallback)

2. IntersectionObserver (rootMargin: "300px")
   └─ On intersect (once):
       ├─ loadDeferredSection serverFn
       ├─ On success: render <LazyComponent .../> with fade-in
       └─ On error: render ErrorFallback or null

3. SPA navigation: stableKey changes → reset state (triggered, section, error)
```

### Key: stableKey for SPA navigation

`DeferredSectionWrapper` uses `pagePath + component + index` as a stable key. When the route changes, this key changes, forcing React to remount the wrapper and reset all internal state. This prevents deferred sections from a previous page being "stuck" in a triggered state.

---

## Bot Detection (SEO Safety)

`isBot(userAgent)` regex detects search engine crawlers. When detected, ALL sections are resolved eagerly — `deferredSections` is empty.

---

## Types

### `AsyncRenderingConfig`

```ts
interface AsyncRenderingConfig {
  respectCmsLazy: boolean;     // Default true — use Lazy.tsx wrappers as deferral source
  foldThreshold: number;       // Default Infinity — fallback for non-wrapped sections
  alwaysEager: Set<string>;    // Section keys that must always be eager
}
```

### `DeferredSection`

```ts
interface DeferredSection {
  component: string;
  key: string;
  index: number;
  rawProps: Record<string, unknown>;
}
```

---

## Edge Cases and Gotchas

### 1. CMS Lazy.tsx is the source of truth
Editors wrap sections in `website/sections/Rendering/Lazy.tsx` in the CMS admin. The framework detects this via `isCmsLazyWrapped()` and defers those sections. Sections NOT wrapped are eager (with `foldThreshold: Infinity`).

### 2. Block references to Lazy
A section may reference a named block (e.g., `"Footer - 01"`) whose underlying definition is `Lazy.tsx`. `isCmsLazyWrapped` resolves one level of block reference to detect this.

### 3. alwaysEager overrides Lazy wrapping
If `Footer.tsx` is in `alwaysEager` but wrapped in Lazy in the CMS, it stays eager. This is intentional — layout sections must always be in the initial HTML.

### 4. Multivariate flags are always eager
Individual sections wrapped in `website/flags/multivariate.ts` require runtime matcher evaluation and can't be safely deferred.

### 5. InvalidCharacterError with section rendering
In TanStack Start, resolved sections have `Component` as a string key (not a React component). Use `SectionRenderer` or `SectionList` from `@decocms/start/hooks` to render sections — never destructure `{ Component, props }` and use as JSX directly.

### 6. Navigation flash prevention
Don't use `pendingComponent` on CMS routes — it replaces the entire page content (including Header/Footer) during transitions. Instead, use a root-level `NavigationProgress` bar that keeps previous page visible while loading.

---

## Public API Summary

### From `@decocms/start/cms`

| Export | Type | Description |
|--------|------|-------------|
| `setAsyncRenderingConfig` | Function | Enable/configure async rendering |
| `getAsyncRenderingConfig` | Function | Read current config |
| `registerCacheableSections` | Function | Register sections for SWR loader caching |
| `runSingleSectionLoader` | Function | Run a single section's loader |
| `resolveDeferredSection` | Function | Fully resolve a deferred section's raw props |
| `preloadSectionModule` | Function | Eagerly import a section to extract LoadingFallback |

### From `@decocms/start/routes`

| Export | Type | Description |
|--------|------|-------------|
| `loadDeferredSection` | ServerFn | Server function to resolve + enrich deferred section on demand |

### From `@decocms/start/hooks`

| Export | Type | Description |
|--------|------|-------------|
| `DecoPageRenderer` | Component | Renders page with eager + deferred section support |
| `SectionRenderer` | Component | Renders a single section by registry key |
| `SectionList` | Component | Renders an array of sections |
