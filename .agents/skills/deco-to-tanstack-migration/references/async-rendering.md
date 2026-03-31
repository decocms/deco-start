# Async Rendering: Architecture & Site Implementation

## Part 1: Architecture

Internal documentation for the async section rendering system in `@decocms/start`.

### When to Use This Reference

- Debugging why a section is or isn't being deferred
- Understanding the full request flow from CMS resolution to on-scroll loading
- Extending the async rendering system (new cache tiers, new deferral strategies)
- Fixing issues with deferred section data resolution
- Understanding how bot detection and SEO safety work
- Working on `@decocms/start` framework code

---

### Problem Solved

TanStack Start serializes all `loaderData` as JSON in a `<script>` tag for client-side hydration. When a CMS page has 20+ sections with commerce data, the HTML payload becomes enormous (8+ MB on some pages). The root cause: `resolveDecoPage` fully resolves ALL sections, and TanStack Start embeds everything.

### Architecture Overview

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

### Deferral Strategy: CMS Lazy.tsx as Source of Truth

#### How it works now (respectCmsLazy)

The deferral decision is driven by **CMS editor choices**, not a global index threshold:

1. **`respectCmsLazy: true`** (default) — a section is deferred if and only if it's wrapped in `website/sections/Rendering/Lazy.tsx` in the CMS page JSON
2. **`foldThreshold`** (default `Infinity`) — fallback for sections NOT wrapped in Lazy; with default `Infinity`, non-wrapped sections are always eager
3. **`alwaysEager`** — section keys that override all deferral (Header, Footer, Theme, etc.)

#### Why this approach

The previous `foldThreshold` approach deferred sections by index position, ignoring editor intent. This caused:
- Sections that editors wanted eager getting deferred
- No control per-page (threshold was global)
- Homepage with 12 sections marked Lazy in CMS showing 0 deferred

Now editors control deferral by wrapping sections in `Lazy.tsx` in the CMS admin, and the framework respects that.

#### `isCmsLazyWrapped(section)` in `resolve.ts`

Detects whether a section is wrapped in `website/sections/Rendering/Lazy.tsx`, either:
- Directly: `section.__resolveType === "website/sections/Rendering/Lazy.tsx"`
- Via named block: `section.__resolveType` references a block whose `__resolveType` is `"website/sections/Rendering/Lazy.tsx"`

#### `shouldDeferSection(section, flatIndex, cfg, isBotReq)`

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

### Files and Their Roles

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

### Server-Side: Eager/Deferred Split

#### Entry point: `resolveDecoPage()` in `resolve.ts`

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

#### `resolveSectionsList(value, rctx, depth)`

Resolves **only the outer wrapper** around the sections array. Handles multivariate flags, named block references, and `resolved` type wrappers. Extracts the raw section array WITHOUT resolving individual section commerce loaders.

#### `resolveFinalSectionKey(section)`

Walks block reference chain and unwraps `Lazy` wrappers to find the final registered section component key:

```
"Header - 01" (named block)
  → { __resolveType: "website/sections/Rendering/Lazy.tsx", section: {...} }
    → { __resolveType: "site/sections/Header/Header.tsx", ...props }
```

Returns `"site/sections/Header/Header.tsx"`, checked against `alwaysEager` and `isLayoutSection`.

#### `resolveSectionShallow(section)`

Synchronously follows block refs and unwraps Lazy to extract `component` (final key) and `rawProps` (CMS props as-is). No API calls, no async.

#### `resolveDeferredSection(component, rawProps, pagePath, matcherCtx)`

Called when client requests a deferred section. Runs full resolution:
1. `resolveProps(rawProps, rctx)` — resolves all nested `__resolveType` references
2. `normalizeNestedSections(resolvedProps)` — converts nested sections to `{ Component, props }`
3. Returns `ResolvedSection` ready for `runSingleSectionLoader`

---

### Server-Side: Section Caching

#### Three cache tiers in `sectionLoaders.ts`

**Tier 1: Layout sections** (Header, Footer, Theme)
- 5-minute TTL, in-flight dedup, registered via `registerLayoutSections`

**Tier 2: Cacheable sections** (ProductShelf, FAQ)
- Configurable TTL via `registerCacheableSections`, SWR semantics, LRU eviction at 200 entries
- Cache key: `component::djb2Hash(JSON.stringify(props))`

**Tier 3: Regular sections** — No caching, always fresh.

---

### Client-Side: DeferredSectionWrapper

#### Lifecycle

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

#### Key: stableKey for SPA navigation

`DeferredSectionWrapper` uses `pagePath + component + index` as a stable key. When the route changes, this key changes, forcing React to remount the wrapper and reset all internal state. This prevents deferred sections from a previous page being "stuck" in a triggered state.

---

### Bot Detection (SEO Safety)

`isBot(userAgent)` regex detects search engine crawlers. When detected, ALL sections are resolved eagerly — `deferredSections` is empty.

---

### Types

#### `AsyncRenderingConfig`

```ts
interface AsyncRenderingConfig {
  respectCmsLazy: boolean;     // Default true — use Lazy.tsx wrappers as deferral source
  foldThreshold: number;       // Default Infinity — fallback for non-wrapped sections
  alwaysEager: Set<string>;    // Section keys that must always be eager
}
```

#### `DeferredSection`

```ts
interface DeferredSection {
  component: string;
  key: string;
  index: number;
  rawProps: Record<string, unknown>;
}
```

---

### Edge Cases and Gotchas

#### 1. CMS Lazy.tsx is the source of truth
Editors wrap sections in `website/sections/Rendering/Lazy.tsx` in the CMS admin. The framework detects this via `isCmsLazyWrapped()` and defers those sections. Sections NOT wrapped are eager (with `foldThreshold: Infinity`).

#### 2. Block references to Lazy
A section may reference a named block (e.g., `"Footer - 01"`) whose underlying definition is `Lazy.tsx`. `isCmsLazyWrapped` resolves one level of block reference to detect this.

#### 3. alwaysEager overrides Lazy wrapping
If `Footer.tsx` is in `alwaysEager` but wrapped in Lazy in the CMS, it stays eager. This is intentional — layout sections must always be in the initial HTML.

#### 4. Multivariate flags are always eager
Individual sections wrapped in `website/flags/multivariate.ts` require runtime matcher evaluation and can't be safely deferred.

#### 5. InvalidCharacterError with section rendering
In TanStack Start, resolved sections have `Component` as a string key (not a React component). Use `SectionRenderer` or `SectionList` from `@decocms/start/hooks` to render sections — never destructure `{ Component, props }` and use as JSX directly.

#### 6. Navigation flash prevention
Don't use `pendingComponent` on CMS routes — it replaces the entire page content (including Header/Footer) during transitions. Instead, use a root-level `NavigationProgress` bar that keeps previous page visible while loading.

---

### Public API Summary

#### From `@decocms/start/cms`

| Export | Type | Description |
|--------|------|-------------|
| `setAsyncRenderingConfig` | Function | Enable/configure async rendering |
| `getAsyncRenderingConfig` | Function | Read current config |
| `registerCacheableSections` | Function | Register sections for SWR loader caching |
| `runSingleSectionLoader` | Function | Run a single section's loader |
| `resolveDeferredSection` | Function | Fully resolve a deferred section's raw props |
| `preloadSectionModule` | Function | Eagerly import a section to extract LoadingFallback |

#### From `@decocms/start/routes`

| Export | Type | Description |
|--------|------|-------------|
| `loadDeferredSection` | ServerFn | Server function to resolve + enrich deferred section on demand |

#### From `@decocms/start/hooks`

| Export | Type | Description |
|--------|------|-------------|
| `DecoPageRenderer` | Component | Renders page with eager + deferred section support |
| `SectionRenderer` | Component | Renders a single section by registry key |
| `SectionList` | Component | Renders an array of sections |

---

## Part 2: Site Implementation

How to configure and use Async Section Rendering in your Deco storefront.

### When to Use This Reference

- Setting up async section rendering on a new or existing Deco site
- Creating `LoadingFallback` components for sections
- Adding `Lazy.tsx` wrappers to CMS page JSONs
- Debugging the red dashed "Missing LoadingFallback" dev warning
- Optimizing page payload size
- Preventing flash-white during SPA navigation

---

### Quick Start (3 steps)

#### 1. `src/setup.ts` — Enable async rendering

```ts
import {
  setAsyncRenderingConfig,
  registerCacheableSections,
} from "@decocms/start/cms";

// Uses CMS Lazy.tsx wrappers as the source of truth for deferral.
// No foldThreshold needed — editors control what's lazy via CMS admin.
setAsyncRenderingConfig({
  alwaysEager: [
    "site/sections/Header/Header.tsx",
    "site/sections/Footer/Footer.tsx",
    "site/sections/Theme/Theme.tsx",
    "site/sections/Miscellaneous/CookieConsent.tsx",
    "site/sections/Social/WhatsApp.tsx",
    "site/sections/Social/UserInteractions.tsx",
  ],
});

// Optional: SWR cache for heavy section loaders
registerCacheableSections({
  "site/sections/Product/ProductShelf.tsx": { maxAge: 180_000 },
  "site/sections/Product/ProductTabbedShelf.tsx": { maxAge: 180_000 },
  "site/sections/Content/Faq.tsx": { maxAge: 1_800_000 },
});
```

#### 2. Wrap sections in Lazy in CMS JSONs

In `.deco/blocks/pages-*.json`, wrap below-the-fold sections:

**Before:**
```json
{ "__resolveType": "site/sections/Product/ProductShelf.tsx", "products": {...} }
```

**After:**
```json
{
  "__resolveType": "website/sections/Rendering/Lazy.tsx",
  "section": {
    "__resolveType": "site/sections/Product/ProductShelf.tsx",
    "products": {...}
  }
}
```

**Rules for which sections to wrap:**
- First 3 visible content sections → **keep eager** (above the fold)
- Header, Footer, Theme, CookieConsent → **always eager** (in `alwaysEager`)
- SEO sections → **skip** (they're metadata, not visual)
- Everything else below the fold → **wrap in Lazy**

#### 3. Add LoadingFallback to every lazy section

Export `LoadingFallback` from the section file. See detailed patterns below.

---

### CMS Lazy Wrapper Strategy

#### Page audit checklist

For each CMS page (`pages-*.json`):

1. Count sections. Skip pages with ≤ 3 sections.
2. Identify above-the-fold content (typically SEO + Header + first 2 content sections).
3. Wrap everything else in `website/sections/Rendering/Lazy.tsx`.
4. Keep `alwaysEager` sections (Header, Footer, etc.) unwrapped even if they appear at the end.

#### Real-world example: Homepage

| Index | Section | Status |
|-------|---------|--------|
| 0 | Seo | Skip (metadata) |
| 1 | UserInteractions | Eager (alwaysEager) |
| 2 | Header | Eager (alwaysEager) |
| 3 | Carousel | Eager (above fold) |
| 4 | Slide | **Lazy** |
| 5 | Categorias | **Lazy** |
| 6 | ProductTabbedShelf | **Lazy** |
| 7 | ProductShelf | **Lazy** |
| ... | ... | **Lazy** |
| 21 | Footer | Eager (alwaysEager, even if wrapped in Lazy) |

Result: 4 eager + 17 lazy → **52% payload reduction**.

---

### Creating LoadingFallback Components

#### Key rules

1. **Match dimensions**: Same container classes, padding, and aspect ratio as the real section
2. **CSS-only**: Use `skeleton animate-pulse` classes. No JS, no hooks, no data.
3. **No props**: `LoadingFallback()` takes zero arguments
4. **One per section file**: Export from `src/sections/Foo.tsx`, not from the component file
5. **Represent the content**: Skeletons should visually match the final layout

#### Product Card Skeleton (reusable pattern)

Most shelf/grid sections contain product cards. Define a shared skeleton:

```tsx
function CardSkeleton() {
  return (
    <div className="card card-compact w-full lg:p-2.5 bg-white rounded-md">
      <div className="skeleton animate-pulse aspect-square w-full rounded" />
      <div className="flex flex-col gap-2 p-2 pt-3">
        <div className="skeleton animate-pulse h-3 w-16 rounded" />
        <div className="skeleton animate-pulse h-4 w-full rounded" />
        <div className="skeleton animate-pulse h-4 w-3/4 rounded" />
        <div className="flex flex-col gap-1 mt-1">
          <div className="skeleton animate-pulse h-3 w-20 rounded" />
          <div className="skeleton animate-pulse h-5 w-28 rounded" />
          <div className="skeleton animate-pulse h-3 w-24 rounded" />
        </div>
        <div className="skeleton animate-pulse h-9 w-full rounded mt-2" />
      </div>
    </div>
  );
}
```

This matches the real `ProductCard` layout: image → flag → name (2 lines) → price block (from/to/installment) → buy button.

#### Pattern: Product Shelf

```tsx
export function LoadingFallback() {
  return (
    <div className="w-full flex flex-col spacingComponents">
      <div className="customContainer mx-auto px-4">
        <div className="skeleton animate-pulse h-6 w-48 rounded mb-6" />
        <div className="flex gap-[1%] overflow-hidden">
          <div className="w-full lg:w-[24%] md:w-[32%] shrink-0"><CardSkeleton /></div>
          <div className="hidden md:block lg:w-[24%] md:w-[32%] shrink-0"><CardSkeleton /></div>
          <div className="hidden md:block lg:w-[24%] md:w-[32%] shrink-0"><CardSkeleton /></div>
          <div className="hidden lg:block lg:w-[24%] shrink-0"><CardSkeleton /></div>
        </div>
      </div>
    </div>
  );
}
```

#### Pattern: Tabbed Shelf

```tsx
export function LoadingFallback() {
  return (
    <div className="w-full flex flex-col spacingComponents overflow-hidden">
      <div className="flex flex-col mx-4 lg:max-w-[84vw] w-full lg:mx-auto">
        <div className="skeleton animate-pulse h-4 w-32 rounded mb-4" />
        <div className="flex gap-4 lg:gap-7 mb-4">
          <div className="skeleton animate-pulse h-9 w-28 rounded-[10px]" />
          <div className="skeleton animate-pulse h-9 w-28 rounded-[10px]" />
          <div className="skeleton animate-pulse h-9 w-28 rounded-[10px] hidden md:block" />
        </div>
        <div className="flex gap-[1%] overflow-hidden mt-4">
          {/* Cards: 2 mobile, 3 tablet, 4 desktop */}
          <div className="w-[44%] lg:w-[24%] md:w-[32%] shrink-0"><CardSkeleton /></div>
          <div className="w-[44%] lg:w-[24%] md:w-[32%] shrink-0"><CardSkeleton /></div>
          <div className="hidden md:block lg:w-[24%] md:w-[32%] shrink-0"><CardSkeleton /></div>
          <div className="hidden lg:block lg:w-[24%] shrink-0"><CardSkeleton /></div>
        </div>
      </div>
    </div>
  );
}
```

#### Pattern: Search Result (PLP)

```tsx
export function LoadingFallback() {
  return (
    <div className="w-full customContainer px-4 py-8 flex gap-6" style={{ minHeight: 600 }}>
      {/* Sidebar filters */}
      <div className="hidden lg:flex flex-col gap-6 w-64 shrink-0">
        <div className="skeleton animate-pulse h-7 w-32 rounded" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-3 pb-4 border-b border-gray-200">
            <div className="skeleton animate-pulse h-5 w-24 rounded" />
            {Array.from({ length: 4 }).map((_, j) => (
              <div key={j} className="flex items-center gap-2">
                <div className="skeleton animate-pulse h-4 w-4 rounded" />
                <div className="skeleton animate-pulse h-3 w-20 rounded" />
              </div>
            ))}
          </div>
        ))}
      </div>
      {/* Product grid */}
      <div className="flex-1">
        <div className="flex items-center justify-between mb-4">
          <div className="skeleton animate-pulse h-7 w-48 rounded" />
          <div className="skeleton animate-pulse h-8 w-32 rounded" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}
```

#### Pattern: Full-width Banner/Carousel

```tsx
export function LoadingFallback() {
  return (
    <div className="w-full">
      <div className="skeleton animate-pulse w-full h-[300px] lg:h-[420px]" />
    </div>
  );
}
```

#### Pattern: FAQ Accordion

```tsx
export function LoadingFallback() {
  return (
    <div className="w-full customContainer px-4 py-8 flex flex-col gap-4 lg:py-10 lg:px-40"
         style={{ minHeight: 400 }}>
      <div className="skeleton animate-pulse h-6 w-48 mx-auto rounded" />
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="skeleton animate-pulse h-12 w-full rounded" />
      ))}
    </div>
  );
}
```

#### Pattern: Testimonials/Cards Grid

```tsx
export function LoadingFallback() {
  return (
    <div className="w-full customContainer px-4 py-8 flex flex-col gap-8">
      <div className="skeleton animate-pulse h-6 w-48 rounded mx-auto" />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-3 p-6 bg-white rounded-lg">
            <div className="skeleton animate-pulse w-16 h-16 rounded-full" />
            <div className="skeleton animate-pulse h-4 w-32 rounded" />
            <div className="skeleton animate-pulse h-4 w-full rounded" />
            <div className="skeleton animate-pulse h-4 w-3/4 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
```

#### Pattern: Footer

```tsx
export function LoadingFallback() {
  return (
    <div className="bg-[#f3f3f3] w-full" style={{ minHeight: 600 }}>
      <div className="customContainer px-4 py-10">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-8 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-3">
              <div className="skeleton animate-pulse h-5 w-32 rounded" />
              {Array.from({ length: 5 }).map((_, j) => (
                <div key={j} className="skeleton animate-pulse h-3 w-24 rounded" />
              ))}
            </div>
          ))}
        </div>
        <div className="skeleton animate-pulse h-16 w-32 rounded mx-auto" />
      </div>
    </div>
  );
}
```

---

### SPA Navigation: NavigationProgress

**Do NOT use `pendingComponent`** on CMS routes — it replaces the entire page content (Header/Footer disappear, causing a "flash white").

Instead, add a root-level progress bar in `__root.tsx`:

```tsx
import { useRouterState } from "@tanstack/react-router";

const PROGRESS_CSS = `
@keyframes progressSlide { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
.nav-progress-bar { animation: progressSlide 1s ease-in-out infinite; }
`;

function NavigationProgress() {
  const isLoading = useRouterState({ select: (s) => s.isLoading });
  if (!isLoading) return null;
  return (
    <div className="fixed top-0 left-0 right-0 z-[9999] h-1 bg-primary/20 overflow-hidden">
      <style dangerouslySetInnerHTML={{ __html: PROGRESS_CSS }} />
      <div className="nav-progress-bar h-full w-1/3 bg-primary rounded-full" />
    </div>
  );
}
```

Add `<NavigationProgress />` before your main layout in `RootLayout`.

---

### Configuration Reference

#### `setAsyncRenderingConfig(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `respectCmsLazy` | `boolean` | `true` | Use CMS Lazy.tsx wrappers as deferral source |
| `foldThreshold` | `number` | `Infinity` | Fallback for non-wrapped sections (Infinity = only Lazy-wrapped defer) |
| `alwaysEager` | `string[]` | `[]` | Section keys that are ALWAYS eager regardless |

#### `registerCacheableSections(configs)`

```ts
registerCacheableSections({
  "site/sections/Product/ProductShelf.tsx": { maxAge: 180_000 },  // 3 min SWR
});
```

Good candidates: Product shelves (2-3 min), FAQ/content (15-30 min). NOT for PDP ProductInfo (must be per-product fresh).

---

### Debugging

#### Section not being deferred

1. Is `setAsyncRenderingConfig()` called in `setup.ts`?
2. Is the section wrapped in `website/sections/Rendering/Lazy.tsx` in the CMS JSON?
3. Is the section key in `alwaysEager`?
4. Is it a layout section (`registerLayoutSections`)?
5. Is it wrapped in a multivariate flag? (always eager)
6. Is the user-agent a bot? (bots always get full eager)

#### Verifying with curl

```bash
# Normal user — count deferred sections
curl -s http://localhost:5173/ | grep -c 'data-deferred'

# Bot — should have 0 deferred
curl -s -A "Googlebot/2.1" http://localhost:5173/ | grep -c 'data-deferred'

# Compare payload size
curl -s -o /dev/null -w "Normal: %{size_download}\n" http://localhost:5173/
curl -s -o /dev/null -w "Bot:    %{size_download}\n" -A "Googlebot/2.1" http://localhost:5173/
```

#### InvalidCharacterError with sections

If you see `Failed to execute 'createElement'` with a section path as tag name, the component is using `{ Component, props }` destructuring directly as JSX. Use `SectionRenderer` or `SectionList` from `@decocms/start/hooks` instead.

---

### Performance Impact

Measured on `espacosmart-storefront`:

| Page | Before | After | Reduction |
|------|--------|-------|-----------|
| Homepage (22 sections) | 8.7 MB | 4.2 MB | **52%** |
| PDP (8 sections) | 8.3 MB | 3.6 MB | **56%** |
| PLP (6 sections) | 646 KB | ~400 KB | **38%** |

---

### Checklist for New Sites

- [ ] Call `setAsyncRenderingConfig()` in `setup.ts` with `alwaysEager` sections
- [ ] Audit all CMS page JSONs — wrap below-fold sections in `Lazy.tsx`
- [ ] Add `LoadingFallback` export to every section used in Lazy wrappers
- [ ] Use detailed skeletons (product card structure, not just gray boxes)
- [ ] Add `NavigationProgress` to `__root.tsx` (NOT `pendingComponent` on routes)
- [ ] Pass `deferredSections` and `loadDeferredSectionFn` in `$.tsx` and `index.tsx`
- [ ] Optionally call `registerCacheableSections()` for heavy section loaders
- [ ] Verify with `curl` that bots get full eager pages
- [ ] Measure payload reduction with `curl -o /dev/null -w "%{size_download}"`
- [ ] Run dev mode and fix all red "Missing LoadingFallback" warnings
