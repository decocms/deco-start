# Creating a New Deco App

## Quick Start

```bash
deno task new
# Select: APP or MCP
# Enter name: my-integration (kebab-case)
# Template is cloned, deco.ts updated, manifests generated
```

## Manual Setup

1. Create the directory: `mkdir my-integration`
2. Add to `deco.ts`:
   ```typescript
   app("my-integration"),
   ```
3. Create the minimum files:

### `client.ts` — API Interface

```typescript
export interface MyClient {
  "GET /users/:id": {
    response: User;
    searchParams: { fields?: string };
  };
  "POST /users": {
    response: User;
    body: CreateUserInput;
  };
  "GET /products": {
    response: { items: Product[]; total: number };
    searchParams: {
      page?: number;
      limit?: number;
      q?: string;
    };
  };
  "DELETE /users/:id": {
    response: void;
  };
}
```

**Key rules:**
- Key format: `"VERB /path/:param/:optional?"` 
- `:param` = required URL param
- `:param?` = optional URL param
- `*` or `*name` = wildcard
- `response` = return type of `.json()`
- `body` = POST/PUT/PATCH body (auto-JSON-serialized)
- `searchParams` = query string parameters

### `mod.ts` — App Factory

```typescript
import { createHttpClient } from "../utils/http.ts";
import manifest, { Manifest } from "./manifest.gen.ts";
import type { Secret } from "../website/loaders/secret.ts";
import type { App, AppContext as AC } from "@deco/deco";
import { fetchSafe } from "../utils/fetch.ts";
import { MyClient } from "./client.ts";

export type AppContext = AC<ReturnType<typeof MyApp>>;

export interface Props {
  /**
   * @description API account identifier
   */
  account: string;
  /**
   * @title API Key
   * @format password
   */
  apiKey?: Secret;
  /**
   * @hide true
   */
  platform: "my-integration";
}

export default function MyApp({ account, apiKey, ...props }: Props) {
  const headers = new Headers();
  if (apiKey) {
    const key = typeof apiKey === "string" ? apiKey : apiKey?.get?.() ?? "";
    headers.set("Authorization", `Bearer ${key}`);
  }

  const api = createHttpClient<MyClient>({
    base: `https://api.example.com/v1/${account}`,
    headers,
    fetcher: fetchSafe,
  });

  const state = { ...props, account, api };

  const app: App<Manifest, typeof state> = {
    state,
    manifest,
  };

  return app;
}
```

### Loaders

```typescript
// loaders/products.ts
import { AppContext } from "../mod.ts";

export interface Props {
  /** @description Search query */
  query?: string;
  /** @description Items per page */
  count?: number;
}

const loader = async (props: Props, _req: Request, ctx: AppContext) => {
  const { api } = ctx;
  const response = await api["GET /products"]({
    q: props.query,
    limit: props.count ?? 12,
  });
  return response.json();
};

export default loader;
```

### Actions

```typescript
// actions/createUser.ts
import { AppContext } from "../mod.ts";

export interface Props {
  name: string;
  email: string;
}

const action = async (props: Props, _req: Request, ctx: AppContext) => {
  const { api } = ctx;
  const response = await api["POST /users"]({}, { body: props });
  return response.json();
};

export default action;
```

4. Run `deno task start` to generate `manifest.gen.ts`

## Commerce App Template

For e-commerce integrations, additional files are needed:

### `utils/transform.ts`

Maps platform-specific API responses to schema.org types:

```typescript
import { Product, Offer } from "../../commerce/types.ts";

export const toProduct = (raw: PlatformProduct): Product => ({
  "@type": "Product",
  productID: String(raw.skuId),
  sku: String(raw.skuId),
  name: raw.name,
  url: `/${raw.slug}/p`,
  image: raw.images.map(img => ({
    "@type": "ImageObject" as const,
    url: img.url,
    alternateName: img.alt,
  })),
  offers: {
    "@type": "AggregateOffer",
    priceCurrency: "BRL",
    highPrice: raw.listPrice,
    lowPrice: raw.price,
    offerCount: 1,
    offers: [{
      "@type": "Offer",
      seller: String(raw.sellerId),   // MUST be ID, not name!
      price: raw.price,
      availability: raw.available
        ? "https://schema.org/InStock"
        : "https://schema.org/OutOfStock",
      priceSpecification: [
        {
          "@type": "UnitPriceSpecification",
          priceType: "https://schema.org/ListPrice",
          price: raw.listPrice,
        },
        {
          "@type": "UnitPriceSpecification",
          priceType: "https://schema.org/SalePrice",
          price: raw.price,
        },
      ],
    }],
  },
  isVariantOf: {
    "@type": "ProductGroup",
    productGroupID: String(raw.productId),
    hasVariant: [],
    name: raw.productName,
    url: `/${raw.slug}/p`,
  },
});
```

### Required Commerce Loaders

| Loader | Return Type | Purpose |
|--------|-------------|---------|
| `productDetailsPage.ts` | `ProductDetailsPage` | PDP |
| `productListingPage.ts` | `ProductListingPage` | PLP/Category |
| `productList.ts` | `Product[]` | Product shelf/carousel |
| `suggestions.ts` | `Suggestion` | Search autocomplete |
| `cart.ts` | `OrderForm` (platform-specific) | Shopping cart |
| `user.ts` | `Person` | Current user |

### Required Commerce Actions

| Action | Purpose |
|--------|---------|
| `cart/addItems.ts` | Add to cart |
| `cart/updateItems.ts` | Update quantities |
| `cart/removeItems.ts` | Remove/clear cart |
| `cart/updateCoupons.ts` | Apply coupon |
| `authentication/signIn.ts` | User login |
| `authentication/logout.ts` | User logout |

### Required Hooks

| Hook | State | Purpose |
|------|-------|---------|
| `context.ts` | `{ cart, user, wishlist }` | Central reactive state |
| `useCart.ts` | Cart mutations | Cart operations |
| `useUser.ts` | User state | User info |
| `useWishlist.ts` | Wishlist CRUD | Wishlist operations |

## MCP App Template

For AI/MCP integrations:

```bash
deno task new
# Select: MCP
# Template: Oauth
```

MCP apps expose tools for AI assistants via the Deco MCP protocol. They use `mcp/` utilities for OAuth, bindings, and context.

## Checklist

- [ ] `client.ts` with typed API interface
- [ ] `mod.ts` with Props and app factory
- [ ] `manifest.gen.ts` generated via `deno task start`
- [ ] Loaders for read operations
- [ ] Actions for write operations
- [ ] `deco.ts` updated with `app("my-app")`
- [ ] README.md with usage instructions
- [ ] (Commerce) `transform.ts` for schema.org mapping
- [ ] (Commerce) All required loaders and actions
- [ ] (Commerce) Client-side hooks
