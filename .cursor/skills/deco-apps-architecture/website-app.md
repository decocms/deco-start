# Website App — Reference

The `website/` app is the base layer that all Deco storefronts use. It handles routing, SEO, analytics, image optimization, themes, and A/B testing.

## Structure

```
website/
├── mod.ts                   # App factory (Props: routes, global sections, caching, abTesting, SEO, theme)
├── manifest.gen.ts
├── types.ts                 # Script type
├── Preview.tsx              # Admin preview
├── pages/Page.tsx           # Base page component
├── actions/
│   └── secrets/encrypt.ts   # Secret encryption
├── components/
│   ├── Analytics.tsx         # Analytics container
│   ├── Clickhouse.tsx        # ClickHouse event collector
│   ├── Events.tsx            # Event dispatching
│   ├── Image.tsx             # Optimized image component
│   ├── Video.tsx             # Video component
│   ├── Theme.tsx             # Theme provider
│   ├── _Controls.tsx         # Live controls
│   └── _seo/                 # SEO meta tag components
│       ├── Facebook.tsx
│       ├── Google.tsx
│       ├── LinkedIn.tsx
│       └── Twitter.tsx
├── flags/
│   ├── audience.ts           # Audience-based routing
│   ├── everyone.ts           # Match all visitors
│   ├── flag.ts               # Feature flag
│   └── multivariate.ts       # Multivariate testing
├── functions/
│   └── requestToParam.ts     # Extract request params
├── handlers/
│   ├── fresh.ts              # Fresh framework handler
│   ├── proxy.ts              # Reverse proxy (VTEX checkout, etc.)
│   ├── redirect.ts           # URL redirects
│   ├── router.ts             # Main router (matches pages to URLs)
│   └── sitemap.ts            # Sitemap generation
├── loaders/
│   ├── asset.ts              # Asset URL resolution
│   ├── environment.ts        # Environment variables
│   ├── fonts/                # Font loading (GoogleFonts, etc.)
│   ├── image/                # Image optimization
│   ├── pages.ts              # Page resolution
│   ├── redirects.ts          # Redirect rules
│   ├── redirectsFromCsv.ts   # Bulk redirects from CSV
│   └── secret.ts             # Secret values (API keys, tokens)
├── matchers/
│   ├── always.ts             # Always match
│   ├── cookie.ts             # Match by cookie value
│   ├── cron.ts               # Match by cron schedule
│   ├── date.ts               # Match by date range
│   ├── device.ts             # Match by device type
│   ├── host.ts               # Match by hostname
│   ├── location.ts           # Match by geo-location
│   ├── multi.ts              # Combine matchers
│   ├── nthRequest.ts         # Match every Nth request
│   ├── queryString.ts        # Match by query params
│   ├── random.ts             # Random percentage
│   ├── site.ts               # Match by site ID
│   └── userAgent.ts          # Match by user agent
├── sections/
│   ├── Analytics/            # GA, GTM, Pixel sections
│   ├── Rendering/            # Lazy, Deferred rendering sections
│   └── Seo/                  # SEO meta sections
└── utils/
    ├── crypto.ts             # Encryption helpers
    ├── html.ts               # HTML manipulation
    ├── image/                # Image engine implementations
    ├── location.ts           # IP-to-location
    ├── multivariate.ts       # A/B test utilities
    └── unhandledRejection.ts # Global error handler
```

## `mod.ts` Props

```typescript
interface Props {
  routes?: Routes[];         // URL → page/handler mapping
  global?: Section[];        // Sections included on every page (header, footer)
  errorPage?: Page;          // Custom error page
  caching?: Caching;         // Cache-Control directives
  abTesting?: AbTesting;     // A/B test against another URL
  flavor?: Fresh | HTMX;     // Framework selection
  seo?: Seo;                 // Default SEO meta
  theme?: Section;           // Theme section (CSS variables)
  disableProxy?: boolean;    // Disable image/asset proxy
  whilelistURLs?: string[];  // Allowed proxy URL patterns
}
```

## Routing

The `handlers/router.ts` matches incoming URLs against registered `routes` and `audiences`:

```
Request URL → matchers (device, cookie, location, etc.)
            → matching audience → handler (page, proxy, redirect)
            → global sections prepended
            → render page
```

## A/B Testing

Built into the website app:

```typescript
interface AbTesting {
  enabled?: boolean;
  name?: string;               // Cookie name for variant tracking
  matcher?: Matcher;           // Who sees the variant
  urlToRunAgainst?: string;    // Proxy target URL
  replaces?: TextReplace[];    // String replacements in proxied HTML
  includeScriptsToHead?: Script[];
  includeScriptsToBody?: Script[];
}
```

## Matchers

Used for audience targeting and A/B testing:

| Matcher | Criteria |
|---------|----------|
| `always` | Always matches |
| `cookie` | Cookie name/value |
| `cron` | Cron expression |
| `date` | Date range |
| `device` | Desktop/mobile/tablet |
| `host` | Request hostname |
| `location` | Country/city/region |
| `queryString` | URL query params |
| `random` | Random percentage |
| `userAgent` | Browser/OS detection |
| `multi` | AND/OR combination of matchers |

## Handlers

| Handler | Purpose |
|---------|---------|
| `router.ts` | Main router — resolves URL to page + sections |
| `proxy.ts` | Reverse proxy with HTML rewriting, script injection |
| `redirect.ts` | URL redirects (301/302) |
| `fresh.ts` | Fresh framework page handler |
| `sitemap.ts` | Dynamic sitemap.xml generation |

## SEO Components

Located in `components/_seo/`:
- `Google.tsx` — Title, description, canonical, JSON-LD
- `Facebook.tsx` — Open Graph meta tags
- `Twitter.tsx` — Twitter card meta tags
- `LinkedIn.tsx` — LinkedIn meta tags

## Caching

```typescript
interface Caching {
  enabled?: boolean;
  directives?: CacheDirective[];
}

type CacheDirective = 
  | { name: "stale-while-revalidate"; value: number }
  | { name: "max-age"; value: number };
```
