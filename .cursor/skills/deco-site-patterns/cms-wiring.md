# CMS Wiring

How the Deco CMS connects to the storefront via the decofile and `__resolveType` references.

## The Decofile (`.deco/blocks/`)

The CMS state lives in `.deco/blocks/` as JSON files. Each file is a "block" -- a configuration object that the resolution engine processes at runtime.

### File Types

| Pattern | Purpose | Example |
|---------|---------|---------|
| `site.json` | Root configuration (global sections, routes, SEO, theme) | Always one per site |
| `everyone.json` | Route definitions via flag (matches all requests) | URL-to-page mapping |
| `pages-*.json` | Page blocks with sections, variants, matchers | `pages-homeretrofit-ecosystem-2794ebefc7d8.json` |
| `redirects-*.json` | Individual redirect definitions | `redirects-masculino-33185.json` |
| `redirects-from-csv.json` | Bulk redirects from CSV file | One per import |
| `vtex.json` | VTEX app configuration (account, secrets) | One per VTEX site |
| `vtex_proxy.json` | VTEX proxy route configuration | Checkout/API proxy |
| `*.json` (other) | Reusable blocks (shelves, videos, banners) | `shelf-suggestions.json` |

## `__resolveType` -- The Wiring Mechanism

Every block has a `__resolveType` field that tells the engine which resolver (loader, section, handler, matcher) to use:

```json
{
  "__resolveType": "vtex/loaders/intelligentSearch/productListingPage.ts",
  "query": "shoes",
  "count": 12,
  "sort": "OrderByScoreDESC"
}
```

The engine:
1. Finds the resolver registered for that key in the manifest
2. Resolves all nested `__resolveType` references in props (recursive)
3. Calls the resolver function with the resolved props
4. Returns the result

### Nesting Example

A section's props in the CMS can reference a loader:

```json
{
  "__resolveType": "site/sections/ProductRetrofit/ProductShelf.tsx",
  "products": {
    "__resolveType": "vtex/loaders/intelligentSearch/productListingPage.ts",
    "query": "new arrivals",
    "count": 8
  },
  "title": "New Arrivals"
}
```

The engine resolves `products` first (calls the VTEX loader), then passes the result to the section component as the `products` prop.

## `site.json` -- Root Configuration

The root block defines the site's global configuration:

```json
{
  "global": [
    { "__resolveType": "site/sections/Theme/Theme.tsx", "mainColors": { "base-100": "#FFFFFF" } },
    { "__resolveType": "site/sections/Analytics/Analytics.tsx", "trackingIds": ["GTM-XXXX"] },
    { "__resolveType": "site/sections/PromoBar/PromoBar.tsx", "text": "Free shipping" }
  ],
  "routes": [
    { "__resolveType": "website/loaders/pages.ts" },
    { "__resolveType": "vtex/loaders/proxy.ts" },
    { "__resolveType": "website/loaders/redirectsFromCsv.ts", "from": "utils/redirects.csv" },
    { "__resolveType": "website/loaders/redirects.ts" }
  ],
  "seo": {
    "title": "My Store",
    "description": "...",
    "titleTemplate": "%s | My Store",
    "image": "https://..."
  },
  "theme": { "__resolveType": "site/sections/Theme/Theme.tsx" },
  "commerce": { "platform": "vtex" },
  "__resolveType": "site/apps/site.ts"
}
```

### Global Sections

`global` contains sections rendered on every page (analytics, promo bars, chat widgets). They're resolved once and injected into every response.

### Routes

`routes` defines the URL resolution order:
1. `website/loaders/pages.ts` -- CMS page matching
2. `vtex/loaders/proxy.ts` -- VTEX checkout/API proxy
3. `website/loaders/redirectsFromCsv.ts` -- bulk redirects from CSV
4. `website/loaders/redirects.ts` -- individual CMS redirect blocks

Order matters -- first match wins.

## `everyone.json` -- Route Definitions

The flag `$live/flags/everyone.ts` wraps route definitions that apply to all requests:

```json
{
  "__resolveType": "$live/flags/everyone.ts",
  "true": {
    "routes": [
      {
        "pathTemplate": "/",
        "handler": {
          "__resolveType": "$live/handlers/fresh.ts",
          "page": { "__resolveType": "pages-homeretrofit-ecosystem-2794ebefc7d8" }
        }
      },
      {
        "pathTemplate": "/*",
        "handler": {
          "__resolveType": "$live/handlers/fresh.ts",
          "page": { "__resolveType": "pages-category-42a3f" }
        }
      }
    ]
  }
}
```

Each route maps a `pathTemplate` to a handler that references a page block.

## Page Blocks (`pages-*.json`)

Page blocks define which sections render on a page, with optional A/B testing via variants:

```json
{
  "name": "Home",
  "path": "/",
  "sections": {
    "__resolveType": "website/flags/multivariate.ts",
    "variants": [
      {
        "rule": { "__resolveType": "website/matchers/device.ts", "mobile": true },
        "value": [
          { "__resolveType": "site/sections/HeroBannerRetrofit/HeroBanner.tsx", "image": "..." },
          { "__resolveType": "site/sections/ProductRetrofit/ProductShelf.tsx", "products": { "__resolveType": "vtex/loaders/..." } }
        ]
      },
      {
        "rule": { "__resolveType": "$live/matchers/MatchAlways.ts" },
        "value": [
          { "__resolveType": "site/sections/HeroBannerRetrofit/HeroBanner.tsx", "image": "..." }
        ]
      }
    ]
  }
}
```

The resolver evaluates matchers in order. First matching variant wins. `MatchAlways` is the default fallback.

## Redirect System

### Individual Redirects

Each redirect is a separate block in `.deco/blocks/`:

```json
{
  "redirect": {
    "from": "/masculino",
    "to": "/masculino-ver-todos",
    "type": "temporary"
  },
  "__resolveType": "website/loaders/redirect.ts"
}
```

### Bulk Redirects from CSV

The `redirects-from-csv.json` block references a CSV file:

```json
{
  "from": "utils/redirects.csv",
  "forcePermanentRedirects": true,
  "__resolveType": "website/loaders/redirectsFromCsv.ts"
}
```

CSV format: `from,to,type` (one redirect per line).

### Redirect Aggregation

`website/loaders/redirects.ts` in the routes array aggregates all individual `website/loaders/redirect.ts` blocks into a single redirect handler.

## Dependency Resolution via `ctx.get()`

Loaders and actions can resolve other blocks at runtime using `ctx.get()`:

```typescript
export const loader = async (props: Props, req: Request, ctx: AppContext) => {
  const { credentials } = await ctx.get({
    "__resolveType": "Tokens",
  });
  const { appKey, appToken } = credentials;
  // Use VTEX API with credentials
};
```

This pattern is used for:
- **Secrets** (API keys, tokens) -- resolved from CMS-managed Secret blocks
- **Configuration** -- any shared config block referenced by multiple loaders
- **Nested block resolution** -- composing data from multiple sources

## Admin Selector

When a section prop's TypeScript type matches a loader's return type, the admin shows a dropdown to select which loader provides the data. For example:

```typescript
interface Props {
  page: ProductDetailsPage | null;
  products: Product[] | null;
}
```

The admin knows that `ProductDetailsPage` can be produced by `vtex/loaders/intelligentSearch/productDetailsPage.ts` or `vtex/loaders/legacy/productDetailsPage.ts`, and shows both options.

This is powered by the schema system -- `generate-schema.ts` extracts prop types and the admin matches them against loader return types.
