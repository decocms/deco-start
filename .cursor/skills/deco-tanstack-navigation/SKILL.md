---
name: deco-tanstack-navigation
description: "Complete guide for migrating Fresh/Deno navigation to TanStack Router in Deco storefronts. Covers: replacing <a href> with <Link>, prefetch strategies for instant navigation, type-safe params, activeProps for menus, search state as URL source of truth, SSR-first SEO architecture, loaderDeps for reactive search params, form submissions via server actions, and programmatic preloading. Use when porting any Deco site from Fresh to TanStack Start."
---

# Deco TanStack Navigation Migration

Complete playbook for replacing Fresh/Deno navigation with TanStack Router in Deco storefronts. Goes beyond simple `<a>` to `<Link>` — covers the full power of the router to build sites that feel like native apps while keeping SSR-first SEO.

## When to Use This Skill

- Migrating a Fresh/Deno storefront to TanStack Start
- Links cause full page reloads instead of SPA transitions
- Filters, sort, or search reload the entire page
- Forms submit via GET and append query params
- Navigation feels slow (no prefetching)
- Menus don't highlight the active page
- Need type-safe route params
- Want URL as the single source of truth for filters/pagination

---

## Architecture: SSR-First, Hydrate Smart

```
Request → Server
  ├─ TanStack Router matches route
  ├─ Route loader runs on server (createServerFn)
  │   ├─ resolveDecoPage(path)
  │   ├─ runSectionLoaders(sections, request)
  │   └─ Return full page data
  ├─ React renders to HTML (SSR)
  └─ Response: full HTML + serialized data

Client receives HTML
  ├─ Instantly visible (SEO, LCP, FCP)
  ├─ React hydrates (attaches event handlers)
  ├─ TanStack Router takes over navigation
  └─ Subsequent navigations:
      ├─ Prefetch on hover/intent (data + component)
      ├─ Client-side render (no full page reload)
      ├─ Only the changed route re-renders
      └─ Shared layout (header/footer) stays mounted
```

This gives you:
- **SEO**: Full HTML on first request, crawlers see everything
- **Speed**: Prefetch makes subsequent pages feel instant
- **State**: Cart, menus, form inputs survive navigation
- **Bandwidth**: Only route data transfers, not the full HTML shell

---

## Pattern 1: `<a href>` to `<Link>` with Prefetch

### The Basic Migration

```typescript
// FRESH — full page reload on every click
<a href={url}>Click me</a>

// TANSTACK — SPA navigation, preserves state
import { Link } from "@tanstack/react-router";
<Link to={url}>Click me</Link>
```

### Prefetch: Make Navigation Instant

The killer feature. The router can **preload the next page before the user clicks**.

```typescript
// Preload when user hovers or focuses the link
<Link to="/produtos" preload="intent">
  Produtos
</Link>

// Preload immediately when the link renders (good for hero CTAs)
<Link to="/ofertas" preload="render">
  Ver Ofertas
</Link>

// Disable prefetch (for low-priority links)
<Link to="/termos" preload={false}>
  Termos de Uso
</Link>
```

**What gets preloaded:**
1. Route component code (the JS chunk)
2. Route loader data (the `createServerFn` call)
3. Any nested route data

When the user clicks, everything is already cached — **navigation is instant**.

### Prefetch Strategy by Component

| Component | Strategy | Why |
|-----------|----------|-----|
| Product card | `preload="intent"` | User will likely click after hover |
| NavItem (menu) | `preload="intent"` | High-intent interaction |
| Category link | `preload="intent"` | Top-of-funnel navigation |
| Hero CTA | `preload="render"` | Guaranteed next action |
| Breadcrumb | `preload="intent"` | Medium priority |
| Footer links | `preload={false}` | Rarely clicked |
| Filter options | N/A (use `useNavigate`) | Same page, different params |

### When NOT to Replace `<a>`

Keep native `<a href>` for:
- External links (`https://...` to other domains)
- Checkout redirects (VTEX checkout is on a different domain)
- Download links (href pointing to files)
- Anchor links (`#section-id`)
- `mailto:` / `tel:` links

### Discovery Command

```bash
rg '<a\s+href=' src/components/ src/sections/ --glob '*.tsx' -l
```

### Gotcha: VTEX URLs Are Absolute

VTEX APIs return absolute URLs. Always convert:

```typescript
import { relative } from "@decocms/apps/commerce/sdk/url";

<Link to={relative(product.url) ?? product.url} preload="intent">
  {product.name}
</Link>
```

---

## Pattern 2: Type-Safe Params

TanStack Router generates types from your route tree. Use them.

### Route Definition

```typescript
// src/routes/produto/$slug.tsx
export const Route = createFileRoute("/produto/$slug")({
  loader: async ({ params }) => {
    // params.slug is typed as string — guaranteed by the router
    const product = await loadProduct({ data: params.slug });
    if (!product) throw notFound();
    return product;
  },
  component: ProductPage,
});
```

### Linking with Type Safety

```typescript
// TypeScript catches wrong params at compile time
<Link to="/produto/$slug" params={{ slug: product.slug }}>
  {product.name}
</Link>

// ERROR: 'id' does not exist in type { slug: string }
<Link to="/produto/$slug" params={{ id: "123" }}>
```

### For Deco CMS Routes (Catch-All)

Deco sites use a catch-all route `/$` that resolves CMS pages. Links to CMS pages use plain paths:

```typescript
<Link to={`/${categorySlug}`} preload="intent">
  {category.name}
</Link>
```

---

## Pattern 3: `activeProps` for Menus

Automatically style the current page link.

### Basic Usage

```typescript
<Link
  to="/dashboard"
  activeProps={{ className: "font-bold text-primary border-b-2 border-primary" }}
  inactiveProps={{ className: "text-base-content/60" }}
>
  Dashboard
</Link>
```

### Navigation Menu (Real Example)

```typescript
function NavItem({ href, label }: { href: string; label: string }) {
  return (
    <Link
      to={href}
      preload="intent"
      activeProps={{ className: "text-primary font-bold" }}
      activeOptions={{ exact: false }}
      className="text-sm hover:text-primary transition-colors"
    >
      {label}
    </Link>
  );
}

function NavBar({ items }: { items: Array<{ href: string; label: string }> }) {
  return (
    <nav className="flex gap-4">
      {items.map((item) => (
        <NavItem key={item.href} {...item} />
      ))}
    </nav>
  );
}
```

### `activeOptions`

```typescript
activeOptions={{
  exact: true,      // Only active on exact path match (not children)
  includeSearch: true, // Include search params in matching
}}
```

---

## Pattern 4: Search State as URL Source of Truth

Instead of managing filter/sort/pagination state in React state or signals, use the **URL as the single source of truth**.

### The Problem with React State for Filters

```typescript
// BAD: State is lost on page refresh, not shareable, no back-button support
const [sort, setSort] = useState("price:asc");
const [filters, setFilters] = useState({});
const [page, setPage] = useState(1);
```

### The TanStack Way: URL = State

```typescript
// Link that preserves existing search params and adds/changes one
<Link
  to="."
  search={(prev) => ({
    ...prev,
    page: 2,
  })}
>
  Próxima página
</Link>

// Link that adds a filter
<Link
  to="."
  search={(prev) => ({
    ...prev,
    "filter.brand": "espacosmart",
  })}
  preload="intent"
>
  Espaço Smart
</Link>

// Link that changes sort while keeping filters
<Link
  to="."
  search={(prev) => ({
    ...prev,
    sort: "price:asc",
  })}
>
  Menor Preço
</Link>
```

### Benefits

1. **Shareable**: Copy URL → paste → same exact view
2. **Back button**: Browser history just works
3. **SEO**: Crawlers see the filter/sort URLs
4. **SSR**: Server renders the correct results on first load
5. **No state management needed**: No Zustand, no signals, no context

### Reading Search Params in Components

```typescript
function SearchResult() {
  const { sort, q, page } = Route.useSearch();
  // sort, q, page are typed based on route validation
}
```

### Validating Search Params (Advanced)

```typescript
import { z } from "zod";

const searchSchema = z.object({
  q: z.string().optional(),
  sort: z.enum(["price:asc", "price:desc", "name:asc", "relevance:desc"]).optional(),
  page: z.number().int().positive().optional().default(1),
  "filter.brand": z.string().optional(),
  "filter.price": z.string().optional(),
});

export const Route = createFileRoute("/s")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    return loadSearchResults({ data: deps });
  },
});
```

Now search params are **type-safe** and **validated**.

---

## Pattern 5: `window.location` Mutations to `useNavigate`

### Problem

```typescript
// FRESH — forces full page reload
window.location.search = params.toString();
window.location.href = newUrl;
globalThis.window.location.search = params.toString();
```

### Solution

```typescript
import { useNavigate } from "@tanstack/react-router";

function Sort() {
  const navigate = useNavigate();

  const applySort = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const params = new URLSearchParams(window.location.search);
    params.set("sort", e.currentTarget.value);
    navigate({ search: Object.fromEntries(params) });
  };
}
```

### With Debounce (Price Range Sliders)

```typescript
const navigate = useNavigate();
const debounceRef = useRef<ReturnType<typeof setTimeout>>();

const applyPrice = (min: number, max: number) => {
  clearTimeout(debounceRef.current);
  debounceRef.current = setTimeout(() => {
    const params = new URLSearchParams(window.location.search);
    params.set("filter.price", `${min}:${max}`);
    navigate({ search: Object.fromEntries(params) });
  }, 500);
};
```

### Discovery

```bash
rg 'window\.location\.(search|href)\s*=' src/ --glob '*.{tsx,ts}'
rg 'globalThis\.window\.location' src/ --glob '*.{tsx,ts}'
```

---

## Pattern 6: Form Submissions

### Search Forms (Navigate with Query Params)

```typescript
import { useNavigate } from "@tanstack/react-router";

function SearchForm({ action = "/s", name = "q" }) {
  const navigate = useNavigate();

  return (
    <form
      action={action}
      onSubmit={(e) => {
        e.preventDefault();
        const q = new FormData(e.currentTarget).get(name)?.toString();
        if (q) navigate({ to: action, search: { q } });
      }}
    >
      <input name={name} />
      <button type="submit">Search</button>
    </form>
  );
}
```

Keep `action` as fallback for no-JS/crawlers.

### Action Forms (Server Mutations)

Forms that POST data (newsletter, contact, shipping calc) use `createServerFn`:

```typescript
import { createDocument } from "~/lib/vtex-actions-server";

function Newsletter() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      const email = new FormData(e.currentTarget).get("email")?.toString();
      if (!email) return;
      try {
        setLoading(true);
        await createDocument({ data: { entity: "NW", dataForm: { email } } });
        setMessage("Cadastrado com sucesso!");
      } catch (err: any) {
        setMessage("Erro: " + err.message);
      } finally {
        setLoading(false);
        setTimeout(() => setMessage(""), 3000);
      }
    }}>
      <input name="email" type="email" required />
      <button type="submit" disabled={loading}>
        {loading ? "Enviando..." : "Inscrever"}
      </button>
      {message && <p>{message}</p>}
    </form>
  );
}
```

---

## Pattern 7: Route `loaderDeps` for Reactive Search Params

### Problem

After converting to `useNavigate`, the URL changes but the page content doesn't update.

### Root Cause

TanStack Router only re-runs a loader when its **dependencies** change. By default: path params only, NOT search params.

### Solution

```typescript
export const Route = createFileRoute("/$")({
  loaderDeps: ({ search }) => ({ search }),

  loader: async ({ params, deps }) => {
    const basePath = "/" + (params._splat || "");
    const searchStr = deps.search
      ? "?" + new URLSearchParams(deps.search as Record<string, string>).toString()
      : "";

    const page = await loadCmsPage({ data: basePath + searchStr });
    if (!page) throw notFound();
    return page;
  },
});
```

### Pass Search Params to Section Loaders

The request passed to section loaders must include search params:

```typescript
const loadCmsPage = createServerFn({ method: "GET" }).handler(async (ctx) => {
  const fullPath = ctx.data as string;
  const [basePath] = fullPath.split("?");
  const serverUrl = getRequestUrl();
  const urlWithSearch = fullPath.includes("?")
    ? new URL(fullPath, serverUrl.origin).toString()
    : serverUrl.toString();

  const request = new Request(urlWithSearch, { headers: getRequest().headers });
  const page = await resolveDecoPage(basePath, matcherCtx);
  const enrichedSections = await runSectionLoaders(page.resolvedSections, request);
  return { ...page, resolvedSections: enrichedSections };
});
```

---

## Pattern 8: Programmatic Preloading

For advanced flows (barcode scanner, autocomplete selection, keyboard navigation):

```typescript
import { useRouter } from "@tanstack/react-router";

function BarcodeScanner() {
  const router = useRouter();

  const onScan = async (code: string) => {
    const slug = await resolveBarcode(code);

    // Preload the product page while showing feedback
    await router.preloadRoute({
      to: "/produto/$slug",
      params: { slug },
    });

    // Navigate — page is already loaded, opens instantly
    router.navigate({
      to: "/produto/$slug",
      params: { slug },
    });
  };
}
```

### Preload on Autocomplete Hover

```typescript
function SearchSuggestion({ product }) {
  const router = useRouter();
  const url = relative(product.url);

  return (
    <Link
      to={url}
      onMouseEnter={() => {
        router.preloadRoute({ to: url });
      }}
    >
      {product.name}
    </Link>
  );
}
```

---

## Pattern 9: `<select>` with `selected` to `defaultValue`

### Problem

```typescript
// FRESH/Preact — works but React warns
<option value={value} selected={value === sort}>{label}</option>
```

### Solution

```typescript
<select defaultValue={sort} onChange={applySort}>
  {options.map(({ value, label }) => (
    <option key={value} value={value}>{label}</option>
  ))}
</select>
```

---

## SSR + SEO Best Practices

### Every Page is SSR by Default

TanStack Start renders on the server first. No extra config needed. But optimize:

1. **Head metadata from loader data**:
```typescript
export const Route = createFileRoute("/$")({
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData?.seo?.title ?? "Espaço Smart" },
      { name: "description", content: loaderData?.seo?.description ?? "" },
    ],
    links: loaderData?.seo?.canonical
      ? [{ rel: "canonical", href: loaderData.seo.canonical }]
      : [],
  }),
});
```

2. **Structured data in sections** (JSON-LD runs server-side, no hydration needed):
```typescript
function ProductSection({ product }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Product",
            name: product.name,
            // ...
          }),
        }}
      />
      <div>{/* product UI */}</div>
    </>
  );
}
```

3. **Internal links as `<Link>`** — crawlers follow them AND users get SPA navigation:
```typescript
<Link to={relative(product.url)} preload="intent">
  <img src={product.image} alt={product.name} />
  <span>{product.name}</span>
</Link>
```

---

## Complete Migration Checklist

### Navigation Links
- [ ] Product card `<a href>` → `<Link to preload="intent">`
- [ ] Category/NavItem `<a href>` → `<Link to preload="intent">`
- [ ] Breadcrumb `<a href>` → `<Link to>`
- [ ] Filter options `<a href>` → `<Link to>` (same-page search param change)
- [ ] Search suggestions `<a href>` → `<Link to preload="intent">`
- [ ] Footer internal links → `<Link to>`

### Mutations
- [ ] Sort `window.location.search =` → `useNavigate`
- [ ] PriceRange `window.location.search =` → `useNavigate` with debounce
- [ ] SearchBar `<form action>` → `onSubmit` + `useNavigate`
- [ ] Newsletter form → `onSubmit` + `createServerFn`

### Route Configuration
- [ ] `$.tsx` has `loaderDeps: ({ search }) => ({ search })`
- [ ] `$.tsx` passes search params to section loaders via Request URL
- [ ] `<select>` uses `defaultValue` instead of `<option selected>`

### Verification

```bash
# Internal links that are still <a> (should be <Link>):
rg '<a\s+href="/' src/components/ src/sections/ --glob '*.tsx' -l

# window.location mutations (should be useNavigate):
rg 'window\.location\.(search|href)\s*=' src/ --glob '*.{tsx,ts}'

# Forms without onSubmit (should have handler):
rg '<form[^>]*action=' src/ --glob '*.tsx' | rg -v 'onSubmit'
```

---

## Quick Reference Card

| Fresh Pattern | TanStack Pattern | Benefit |
|--------------|-----------------|---------|
| `<a href={url}>` | `<Link to={url} preload="intent">` | Instant navigation |
| `window.location.search = x` | `navigate({ search })` | No reload, keeps state |
| `<form action="/s">` | `onSubmit + useNavigate` | SPA navigation |
| `<form action="/" method="POST">` | `onSubmit + createServerFn` | Server mutation |
| `<option selected>` | `<select defaultValue>` | React-compatible |
| CSS active class manually | `activeProps={{ className }}` | Automatic |
| No prefetch | `preload="intent"` | Data ready before click |
| `req.url` in loader | `loaderDeps + deps.search` | Reactive to URL changes |
| `router.push(url)` | `router.preloadRoute + navigate` | Preload then navigate |

---

## Related Skills

| Skill | Purpose |
|-------|---------|
| `deco-to-tanstack-migration` | Full migration playbook (imports, signals, framework) |
| `deco-islands-migration` | Eliminating the islands/ directory |
| `deco-tanstack-storefront-patterns` | Runtime patterns and fixes post-migration |
| `deco-storefront-test-checklist` | Context-aware QA checklist generation |
