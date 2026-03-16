# CMS Block Resolution

The CMS layer handles loading content blocks from the decofile, resolving `__resolveType` references, and rendering pages.

## Block Loading (`cms/loader.ts`)

### Core Functions

```typescript
loadBlocks(): Record<string, any>           // Reads .deco/blocks/*.json
setBlocks(blocks: Record<string, any>): void // Updates in-memory state + revision + notifies listeners
findPageByPath(path: string, blocks): Page   // Matches URL path to CMS page
getAllPages(blocks): Page[]                   // Returns all page blocks
withBlocksOverride(blocks, fn): T            // AsyncLocalStorage override for preview
getRevision(): string                        // Returns content-hash revision of current blocks
onChange(listener: () => void): () => void   // Register callback for block changes (returns unsubscribe)
```

### Revision Tracking

`setBlocks()` now computes a content-based hash (DJB2) of all block keys/types, stored as the current revision. This revision is:
- Returned by `getRevision()` for use as ETags
- Included in `GET /.decofile` responses
- Used by `handleMeta()` to auto-invalidate cached schema when content changes

### onChange Listeners

Register callbacks that fire whenever `setBlocks()` is called:

```typescript
const unsubscribe = onChange(() => {
  console.log("Blocks updated, new revision:", getRevision());
});
```

Used internally by `handleMeta()` to invalidate its cached ETag when blocks change.

## Section Registry (`cms/registry.ts`)

Registers React section components by key:

```typescript
registerSection(key: string, component: React.ComponentType, schema?: any): void
getSection(key: string): SectionEntry | undefined
getSectionOptions(): string[]
getSectionRegistry(): Map<string, SectionEntry>
```

Site's `setup.ts` registers all sections at startup:

```typescript
import Hero from "./sections/Hero.tsx";
registerSection("site/sections/Hero.tsx", Hero);
```

## Resolution (`cms/resolve.ts`)

### resolveDecoPage

Main resolver that walks the page tree, resolving all `__resolveType` references:

```typescript
resolveDecoPage(page: Page, request: Request, options?: { select?: string }): Promise<ResolvedPage>
```

Pipeline:
1. Get page sections from the decofile
2. Evaluate multivariate flags (A/B testing)
3. For each section, walk props recursively via `internalResolve()`
4. When `__resolveType` is found, resolve recursively (generic resolver, not just commerce loaders)
5. Per-request memoization prevents duplicate calls to the same resolver
6. Depth protection (max 10 levels) prevents infinite recursion
7. DanglingReference handler for unresolvable `__resolveType` (configurable fallback)
8. Apply `select` filtering if specified
9. Return resolved sections ready for rendering

### Generic Recursive Resolver (`internalResolve`)

The resolution engine now handles any `__resolveType`, not just registered commerce loaders:

```typescript
// ResolveContext tracks per-request state
interface ResolveContext {
  memo: Map<string, unknown>;  // memoization cache
  depth: number;               // current recursion depth (max: 10)
}
```

Resolution order:
1. Check commerce loaders registry (`commerceLoaders`)
2. Check decofile blocks (for CMS-defined references)
3. If neither matches → call `onDanglingReference` handler (configurable)

### Error & Fallback Handlers

```typescript
setResolveErrorHandler(handler: (error: Error, key: string) => void): void
setDanglingReferenceHandler(handler: (key: string, props: any) => unknown): void
addSkipResolveType(type: string): void  // Dynamically add types to skip during resolution
```

### registerCommerceLoader

```typescript
registerCommerceLoader(key: string, loader: CommerceLoader): void
```

Site's `setup.ts`:

```typescript
import { productList } from "@decocms/apps/vtex/inline-loaders";
registerCommerceLoader("vtex/loaders/productList.ts", productList);
```

### Select / Field Filtering

Resolved values can be filtered using `applySelect`:

```typescript
// Only return specific fields from resolved data
resolveValue(blocks, request, { select: "name,price,images" });
```

### registerMatcher

```typescript
registerMatcher(key: string, matcher: MatcherFn): void
```

### Built-in Matchers

Registered via `registerBuiltinMatchers()` from `matchers/builtins.ts`:

| Matcher | Key | Purpose |
|---------|-----|---------|
| always | website/matchers/always.ts | Always true (also resolves `$live/matchers/MatchAlways.ts`) |
| never | website/matchers/never.ts | Always false |
| device | website/matchers/device.ts | Mobile/desktop/tablet |
| random | website/matchers/random.ts | Traffic percentage |
| utm | website/matchers/utm.ts | UTM parameter matching |
| cookie | website/matchers/cookie.ts | Cookie value matching |
| cron | website/matchers/cron.ts | Time/date range |
| host | website/matchers/host.ts | Hostname matching |
| pathname | website/matchers/pathname.ts | URL pattern matching |
| queryString | website/matchers/queryString.ts | Query param matching |

Matcher context now includes enhanced properties:

```typescript
interface MatcherContext {
  request: Request;
  headers: Headers;
  siteId: number;
  site: string;
}
```

### Multivariate Flags

The resolver handles `website/flags/multivariate.ts` blocks:

```json
{
  "__resolveType": "website/flags/multivariate.ts",
  "variants": [
    {
      "rule": { "__resolveType": "website/matchers/device.ts", "mobile": true },
      "value": { "sections": ["...mobile sections..."] }
    },
    {
      "rule": { "__resolveType": "website/matchers/always.ts" },
      "value": { "sections": ["...default sections..."] }
    }
  ]
}
```

### SKIP_RESOLVE_TYPES

Types intentionally skipped during resolution (handled differently in TanStack).
Default list includes:
- `website/loaders/redirects.ts`
- `commerce/sections/Seo/SeoPDPV2.tsx`
- `commerce/sections/Seo/SeoPLPV2.tsx`

Additional types can be added dynamically at runtime:

```typescript
import { addSkipResolveType } from "@decocms/start/cms";
addSkipResolveType("custom/loaders/myCustomLoader.ts");
```

### Page-Level SEO Resolution (`page.seo`)

CMS page JSONs have a top-level `seo` field separate from `sections`:

```json
{
  "name": "Home",
  "path": "/",
  "sections": [ ... ],
  "seo": {
    "__resolveType": "website/sections/Seo/SeoV2.tsx",
    "title": "My Store",
    "description": "Best prices",
    "canonical": "https://example.com/",
    "jsonLDs": [{ "@type": "Organization", ... }],
    "titleTemplate": "%s",
    "descriptionTemplate": "%s",
    "type": "website"
  }
}
```

For PDP pages, `page.seo` is often wrapped in `Lazy.tsx` with a commerce loader:

```json
{
  "seo": {
    "__resolveType": "website/sections/Rendering/Lazy.tsx",
    "section": {
      "__resolveType": "site/sections/SEOPDP.tsx",
      "jsonLD": { "__resolveType": "Intelligent Search PDP Loader" },
      "titleTemplate": "%s | STORE NAME",
      "descriptionTemplate": "%s | STORE NAME"
    }
  }
}
```

`resolvePageSeoBlock()` handles this by:
1. **Always unwrapping Lazy/Deferred** — SEO must never be deferred for crawlers
2. Following named block references and multivariate flags
3. Resolving all nested `__resolveType` props (commerce loaders for PDP product data)
4. Returning a `ResolvedSection` with the component key and resolved props

The result is stored in `DecoPageResult.seoSection` and processed in `cmsRoute.ts`:
1. Run the registered section loader (e.g., SEOPDP transforms `{jsonLD: ProductDetailsPage}` → `{title, description, canonical, image, jsonLDs}`)
2. Extract `PageSeo` fields via `extractSeoFromProps()`
3. Apply `titleTemplate`/`descriptionTemplate` from the CMS config (e.g., `"%s | STORE NAME"`)
4. Merge with section-contributed SEO (page.seo is primary, sections are secondary)

```typescript
interface PageSeo {
  title?: string;
  description?: string;
  canonical?: string;
  image?: string;
  noIndexing?: boolean;
  jsonLDs?: Record<string, any>[];
  type?: string;  // og:type: "website", "product", etc.
}
```

`buildHead()` in `cmsRouteConfig` generates full `<head>` metadata from `PageSeo`: `<title>`, `<meta name="description">`, `<link rel="canonical">`, Open Graph (including `og:url`, `og:type`), Twitter Card, and robots directives.

### SEO Section Registry (secondary source)

Sections in `page.sections` that also contribute SEO metadata are registered via `registerSeoSections()`:

```typescript
registerSeoSections(["site/sections/SEOPDP.tsx"]);
```

`extractSeoFromSections()` scans registered sections and extracts SEO fields. This is the **secondary** source — `page.seo` always takes precedence when both are present.

Note: PLP and search pages typically lack a `page.seo` field. For these, `cmsRouteConfig` falls back to composing a title from the page name and `siteName` option.

### PostHog Matchers (`matchers/posthog.ts`)

Server-side PostHog feature flag evaluation:

```typescript
createPostHogMatcher(config): MatcherFn
configurePostHogMatcher(apiKey, personalApiKey): void
createServerPostHogAdapter(): PostHogAdapter
```
