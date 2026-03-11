---
name: deco-site-patterns
description: Pattern reference for building Deco storefronts. Covers how a site uses the framework (@deco/deco) and apps (deco-cx/apps) together — CMS wiring via __resolveType, section patterns (loaders, LoadingFallback, JSDoc annotations for admin), client-side patterns (invoke proxy, signals, islands, analytics), and app composition (site.ts factory, AppContext, theme, images). Based on analysis of production sites like osklenbr. Use when building new sections, wiring CMS data, creating islands, setting up analytics, composing apps, or understanding how sites connect to the Deco ecosystem.
globs:
  - "**/apps/site.ts"
  - "**/manifest.gen.ts"
  - "**/runtime.ts"
  - "**/fresh.config.ts"
  - "**/.deco/blocks/*.json"
  - "**/sections/**/*.tsx"
  - "**/islands/**/*.tsx"
  - "**/sdk/**/*.ts"
---

## Sub-documents

| Document | Topic |
|----------|-------|
| [cms-wiring.md](./cms-wiring.md) | CMS block system, __resolveType, decofile, pages, redirects, dependency resolution |
| [section-patterns.md](./section-patterns.md) | Section conventions, loaders, LoadingFallback, JSDoc for admin, widget types |
| [client-patterns.md](./client-patterns.md) | Invoke proxy, islands, signals, analytics, cart/wishlist/user hooks, SDK utilities |
| [app-composition.md](./app-composition.md) | App factory, AppContext, theme, images, routes, matchers, global layout |

# Deco Site Patterns

Pattern reference for building Deco storefronts. Documents how a site uses the Deco framework and apps ecosystem.

## Three-Layer Architecture

```
@deco/deco (framework)
  Resolution engine, block system, plugins, hooks, runtime
        |
deco-cx/apps (integrations)
  Commerce types, VTEX/Shopify loaders, website handlers, matchers, analytics
        |
Site repo (storefront)
  Sections, islands, components, SDK, routes, .deco/blocks
```

The framework resolves blocks. Apps provide commerce and website capabilities. The site wires them together via CMS configuration and custom code.

## Site File Structure

```
my-store/
|-- deno.json               # Imports, tasks, compiler options
|-- fresh.config.ts          # Fresh + Deco plugin registration
|-- manifest.gen.ts          # Auto-generated block registry
|-- fresh.gen.ts             # Auto-generated Fresh manifest (routes + islands)
|-- runtime.ts               # Typed invoke proxy for client-side calls
|-- main.ts                  # Production entry point
|-- dev.ts                   # Dev entry (tailwind + HMR)
|
|-- apps/                    # App registrations
|   |-- site.ts              # Main app: manifest + dependencies (std, commerce)
|   |-- decohub.ts           # Admin hub re-export
|
|-- .deco/blocks/            # CMS content (decofile)
|   |-- site.json            # Root config: global sections, routes, SEO, theme
|   |-- everyone.json        # Flag with route definitions
|   |-- pages-*.json         # Page blocks with sections and variants
|   |-- redirects-*.json     # Individual redirect definitions
|   |-- vtex.json            # VTEX app configuration
|
|-- sections/                # CMS-renderable UI sections
|   |-- ProductRetrofit/     # Product sections (PDP, shelf, search)
|   |-- HeaderRetrofit/      # Header section
|   |-- FooterRetrofit/      # Footer section
|   |-- ImagesRetrofit/      # Banner, carousel, gallery sections
|   |-- Theme/               # Theme section (colors, fonts, CSS vars)
|
|-- islands/                 # Client-side interactive components (hydrated)
|   |-- HeaderRetrofit/      # Header islands (search, drawers)
|   |-- DetailsRetrofit/     # PDP islands (product actions, size selector)
|   |-- CartRetrofit/        # Cart island
|
|-- components/              # Shared Preact components (used by sections + islands)
|   |-- productRetrofit/     # Product card, gallery, details
|   |-- searchRetrofit/      # Search result, filters, sort
|   |-- uiRetrofit/          # Base UI (image, slider, modal, button)
|   |-- minicartRetrofit/    # Cart, cart item, coupon
|
|-- sdk/                     # Client-side utilities
|   |-- useUIRetrofit.ts     # Global UI state (signals)
|   |-- formatRetrofit.ts    # Price formatting
|   |-- analyticsRetrofit.ts # Analytics event dispatch
|   |-- useAddToCart*.ts     # Add to cart logic
|   |-- useLazyLoad.tsx      # IntersectionObserver lazy loading
|
|-- loaders/                 # Site-specific data loaders
|-- actions/                 # Site-specific mutations
|-- matchers/                # Site-specific audience matchers
|-- routes/                  # Fresh routes (_app.tsx, proxy.ts)
|-- static/                  # Static assets
```

## Key Concepts

### 1. Everything is a Block

Sections, loaders, actions, handlers, matchers, and flags are all "blocks" registered in `manifest.gen.ts`. The CMS references them by key (e.g., `site/sections/ProductRetrofit/ProductDetails.tsx`).

### 2. CMS Wires Data to Sections

The CMS admin creates page configurations stored in `.deco/blocks/pages-*.json`. Each section in a page can have props that reference loaders via `__resolveType`. The framework resolves these before rendering.

### 3. Islands Bridge Server and Client

Sections render on the server. Islands are the client-side boundary -- they hydrate and run in the browser. Islands use `invoke` to call server loaders/actions and `@preact/signals` for reactive state.

### 4. Apps Compose Capabilities

The site's `apps/site.ts` composes the `std` (compatibility) and `commerce` (VTEX/Shopify) apps as dependencies. Each app contributes loaders, actions, and handlers to the manifest.

## Related Skills

| Skill | Focus |
|-------|-------|
| `deco-core-architecture` | Framework internals (engine, blocks, runtime) |
| `deco-apps-architecture` | Apps monorepo structure (VTEX, Shopify, website) |
| `deco-start-architecture` | TanStack Start version of the framework |
| `deco-to-tanstack-migration` | Fresh/Preact to TanStack/React migration |
| `deco-apps-vtex-porting` | VTEX-specific porting guide |
