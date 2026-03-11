# Section Patterns

Sections are the primary building blocks of a Deco storefront. They are Preact components registered in the manifest and configurable via the CMS admin.

## Section File Conventions

### Pattern 1: Re-export

The section file re-exports a component from `components/`. Keeps the section thin and the component reusable.

```typescript
// sections/HeaderRetrofit/Header.tsx
export { default } from "$store/components/headerRetrofit/Header.tsx";

export const LoadingFallback = () => <div class="absolute" />;
```

### Pattern 2: Wrapper with Loader

The section wraps a component and adds a loader for server-side data:

```typescript
// sections/HeroBannerRetrofit/HeroBanner.tsx
import HeroBanner from "$store/components/uiRetrofit/HeroBanner/HeroBanner.tsx";
import { MatchDevice } from "apps/website/matchers/device.ts";

export interface Props {
  /** @title Banner desktop */
  desktop: BannerProps;
  /** @title Banner mobile */
  mobile: BannerProps;
}

export default function HeroBannerWrapper(props: Props & { isMobile: boolean }) {
  return <HeroBanner {...props} />;
}

export function loader(props: Props, req: Request, ctx: AppContext) {
  return { ...props, isMobile: MatchDevice(req.headers, "mobile") };
}
```

### Pattern 3: Full Implementation

The section contains both component and loader logic in one file (or re-exports both from a component file):

```typescript
// sections/ProductRetrofit/ProductDetails.tsx
export { default, loader } from "../../components/productRetrofit/Details/index.tsx";
```

Where the component file has:

```typescript
// components/productRetrofit/Details/index.tsx
export interface Props {
  page: ProductDetailsPage | null;
  /** @title Enable 3D View */
  enableThreeDView?: boolean;
}

export default function ProductDetails({ page, enableThreeDView }: Props) {
  if (!page) return <NotFound />;
  return <div>...</div>;
}

export const loader = async (props: Props, req: Request, ctx: AppContext) => {
  const { credentials } = await ctx.get({ "__resolveType": "Tokens" });
  const isMobile = MatchDevice(req.headers, "mobile");
  // Fetch additional data, check user, etc.
  return { ...props, isMobile, credentials };
};
```

## JSDoc Annotations for Admin

JSDoc tags on props control how the admin renders form fields.

### @title -- Field Label

```typescript
interface Props {
  /** @title Titulo principal */
  heading: string;
}
```

### @description -- Help Text

```typescript
interface Props {
  /**
   * @title Cor de fundo
   * @description Define a cor de fundo da pagina
   */
  backgroundColor?: string;
}
```

### @format -- Input Type

| Format | Admin Input | Example |
|--------|-------------|---------|
| `color` | Color picker | `@format color` on `string` |
| `html` | Rich text editor | `@format html` on `string` |
| `textarea` | Multiline text | `@format textarea` on `string` |

```typescript
interface Props {
  /**
   * @title Cor primaria
   * @format color
   * @default #003232
   */
  primary: string;

  /** @format html */
  richContent: string;

  /** @format textarea */
  description: string;
}
```

### @default -- Default Value

```typescript
interface Props {
  /**
   * @title Cor base
   * @format color
   * @default #FFFFFF
   */
  "base-100": string;
}
```

### @ignore -- Hide from Admin

```typescript
interface Props {
  /** @ignore */
  isMobile?: boolean;
}
```

Used for loader-injected props that shouldn't appear in the admin form.

## Widget Types

Import from `apps/admin/widgets.ts` to get special admin input types:

```typescript
import { ImageWidget } from "apps/admin/widgets.ts";
import { HTMLWidget } from "apps/admin/widgets.ts";
import { VideoWidget } from "apps/admin/widgets.ts";
import { Secret } from "apps/website/loaders/secret.ts";
```

| Type | Admin Input | Usage |
|------|-------------|-------|
| `ImageWidget` | Image uploader (Deco CDN) | Banners, logos, product images |
| `HTMLWidget` | Rich text editor | Descriptions, content blocks |
| `VideoWidget` | Video URL input | Video sections |
| `Secret` | Encrypted value (not shown) | API keys, tokens |

Legacy alias: `ImageWidget as LiveImage` is common in older sites.

```typescript
interface Props {
  /** @description Mobile optimized image */
  srcMobile: ImageWidget;
  /** @description Desktop optimized image */
  srcDesktop?: ImageWidget;
  alt: string;
  href: string;
}
```

## Loader Patterns

### Sync Loader (MatchDevice)

The most common pattern. Adds `isMobile` for responsive rendering:

```typescript
import { MatchDevice } from "apps/website/matchers/device.ts";
import { AppContext } from "site/apps/site.ts";

export function loader(props: Props, req: Request, _ctx: AppContext) {
  return {
    ...props,
    isMobile: MatchDevice(req.headers, "mobile"),
  };
}
```

Used in ~18 sections (HeroBanner, PromoBar, ContentSection, CollectionBlock, etc.).

### Async Loader (Data Fetching)

For sections that need server-side data:

```typescript
export const loader = async (props: Props, req: Request, ctx: AppContext) => {
  // Resolve secrets via __resolveType
  const { credentials } = await ctx.get({ "__resolveType": "Tokens" });

  // Call VTEX API
  const response = await fetch(`https://${account}.vtexcommercestable.com.br/api/...`, {
    headers: { "X-VTEX-API-AppKey": credentials.appKey },
  });

  // Check user status
  const user = await ctx.invoke("site/actions/checkUser.ts");

  return { ...props, data: await response.json(), user, isMobile: MatchDevice(req.headers, "mobile") };
};
```

Used in ProductDetails, SearchResult, OurStores, InstagramPosts.

### CMS-Wired Data (No Loader Needed)

When data comes from the CMS via `__resolveType`, the section receives it as a resolved prop -- no loader needed:

```typescript
interface Props {
  products: Product[] | null;  // Admin shows loader selector
  title: string;               // Admin shows text input
}

export default function ProductShelf({ products, title }: Props) {
  if (!products) return null;
  return <div>{title}{products.map(p => <Card product={p} />)}</div>;
}
```

The admin lets the editor choose which loader provides `products` (e.g., `vtex/loaders/intelligentSearch/productListingPage.ts`).

## LoadingFallback Pattern

Sections can export a `LoadingFallback` component that renders while the section's loader is pending (async rendering):

### Simple Placeholder

```typescript
export const LoadingFallback = () => <div class="absolute" />;
```

Prevents layout shift with a minimal placeholder.

### Spinner

```typescript
export function LoadingFallback() {
  return (
    <div style={{ height: "600px" }} class="flex justify-center items-center">
      <span class="loading loading-spinner" />
    </div>
  );
}
```

Fixed-height container with a loading spinner.

### Skeleton with Props

Uses `Partial<Props>` to render a structural skeleton that matches the final layout:

```typescript
export function LoadingFallback(props: Partial<Props>) {
  return (
    <div class="container">
      {props.title && <h2>{props.title}</h2>}
      {props.breadcrumb && <Breadcrumb items={props.breadcrumb} />}
      <div class="flex justify-center items-center h-[400px]">
        <span class="loading loading-spinner" />
      </div>
    </div>
  );
}
```

The CMS static props (title, breadcrumb) render immediately while loader data is pending.

### Animated Skeleton

Full skeleton with pulse animation placeholders:

```typescript
function CollectionContentSkeleton() {
  return (
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} class="animate-pulse">
          <div class="bg-gray-200 aspect-square rounded" />
          <div class="bg-gray-200 h-4 mt-2 rounded w-3/4" />
          <div class="bg-gray-200 h-4 mt-1 rounded w-1/2" />
        </div>
      ))}
    </div>
  );
}

export function LoadingFallback(props: Partial<Props>) {
  return (
    <div class="container">
      <CollectionContentSkeleton />
    </div>
  );
}
```

## Section Organization

### Naming Convention

- `{Domain}Retrofit/` prefix groups related sections (e.g., `ProductRetrofit/`, `HeaderRetrofit/`)
- "Retrofit" indicates a redesigned version; new sites may drop this suffix
- One file per section, named after the component

### Grouping

| Group | Sections |
|-------|----------|
| Product | ProductDetails, ProductShelf, SearchResult, WishlistRetrofit |
| Navigation | Header, Footer, PromoBar |
| Content | HeroBanner, Banner, Carousel, ImageGallery, Video, Text |
| Institutional | FAQ, About, ContactUs, OurStores |
| Marketing | Newsletter, PopupFirstTime, CampaignTimer |
| Infrastructure | Theme, Seo, Analytics, CookieConsent |

### Section vs Component vs Island

| Layer | Location | Renders | Purpose |
|-------|----------|---------|---------|
| Section | `sections/` | Server (SSR) | CMS block, registered in manifest |
| Component | `components/` | Server (SSR) | Reusable, not in manifest |
| Island | `islands/` | Client (hydrated) | Interactive, has client-side JS |
