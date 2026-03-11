# Commerce Types — Schema.org Reference

The `commerce/types.ts` file (786 lines) defines the canonical data model for all Deco commerce apps. Every platform (VTEX, Shopify, Wake, Nuvemshop) transforms its native API responses into these types.

## Core Hierarchy

```
Thing
├── Product (extends ProductLeaf)
│   └── ProductGroup (has hasVariant: ProductLeaf[])
├── Offer
│   └── AggregateOffer (has offers: Offer[])
├── BreadcrumbList (has itemListElement: ListItem<string>[])
├── ImageObject
├── VideoObject
├── Brand
├── Review
├── Person
├── Organization
├── Place
└── ItemList
```

## Product Types

### ProductLeaf
```typescript
interface ProductLeaf extends Omit<Thing, "@type"> {
  "@type": "Product";
  category?: string;          // "category > subcategory > ..."
  productID: string;          // Platform SKU ID
  sku: string;                // SKU code (same as productID in most cases)
  gtin?: string;              // EAN/GTIN barcode
  releaseDate?: string;       // ISO 8601
  brand?: Brand;
  offers?: AggregateOffer;
  isVariantOf?: ProductGroup;
  isSimilarTo?: Product[];
  isAccessoryOrSparePartFor?: Product[];
  isRelatedTo?: Product[];
  additionalProperty?: PropertyValue[];
  review?: Review[];
  aggregateRating?: AggregateRating;
  questions?: Question[];
}
```

### ProductGroup
```typescript
interface ProductGroup extends Omit<Thing, "@type"> {
  "@type": "ProductGroup";
  productGroupID: string;     // Platform product ID
  hasVariant: ProductLeaf[];
  model?: string;
  additionalProperty?: PropertyValue[];
}
```

### Product = ProductLeaf & { isVariantOf?: ProductGroup }

## Offer / AggregateOffer

### Offer
```typescript
interface Offer {
  "@type": "Offer";
  seller: string;             // Seller ID (NOT name!)
  sellerName?: string;
  price: number;
  priceCurrency?: string;
  priceSpecification: UnitPriceSpecification[];
  priceValidUntil?: string;
  availability: ItemAvailability;
  inventoryLevel?: QuantitativeValue;
  itemCondition?: OfferItemCondition;
  teasers?: Teasers[];
  giftSkuIds?: string[];
  hasMerchantReturnPolicy?: MerchantReturnPolicy;
}
```

### AggregateOffer
```typescript
interface AggregateOffer {
  "@type": "AggregateOffer";
  priceCurrency: string;
  highPrice: number;
  lowPrice: number;
  offerCount: number;
  offers: Offer[];
}
```

### UnitPriceSpecification
```typescript
interface UnitPriceSpecification {
  "@type": "UnitPriceSpecification";
  priceType: PriceTypeEnumeration;       // "https://schema.org/ListPrice" | "https://schema.org/SalePrice" | etc.
  priceComponentType?: PriceComponentTypeEnumeration;
  price: number;
  billingDuration?: number;
  billingIncrement?: number;
  name?: string;
}
```

## Page Types

### ProductDetailsPage
```typescript
interface ProductDetailsPage {
  "@type": "ProductDetailsPage";
  breadcrumbList: BreadcrumbList;
  product: Product;
  seo?: Seo;
}
```

### ProductListingPage
```typescript
interface ProductListingPage {
  "@type": "ProductListingPage";
  breadcrumb: BreadcrumbList;
  filters: Filter[];
  products: Product[];
  pageInfo: PageInfo;
  sortOptions: SortOption[];
  seo?: Seo;
  pageTypes?: PageType[];
}
```

### PageInfo
```typescript
interface PageInfo {
  currentPage: number;
  nextPage?: string;
  previousPage?: string;
  records?: number;
  recordPerPage?: number;
  pageTypes?: PageType[];
}
```

## Filter Types

### FilterToggle
```typescript
interface FilterToggle extends FilterBase {
  "@type": "FilterToggle";
  values: FilterToggleValue[];
  quantity: number;
}
```

### FilterRange
```typescript
interface FilterRange extends FilterBase {
  "@type": "FilterRange";
  values: FilterRangeValue;   // { min: number, max: number }
}
```

## Navigation

### SiteNavigationElement
```typescript
interface SiteNavigationElement {
  "@type": "SiteNavigationElement";
  name?: string;
  url?: string;
  image?: ImageObject[];
  children?: SiteNavigationElement[];
  additionalType?: string;
}
```

## Analytics (GA4)

### AnalyticsItem
```typescript
interface AnalyticsItem {
  item_id: string;
  item_group_id?: string;
  quantity: number;
  coupon?: string;
  price: number;
  discount?: number;
  index?: number;
  item_name?: string;
  item_variant?: string;
  item_brand?: string;
  item_url?: string;
  affiliation?: string;
  item_list_id?: string;
  item_list_name?: string;
  [key: `item_category${number | ""}`]: string;
}
```

### Event Types
- `AddToCartEvent` — items + value + currency
- `RemoveFromCartEvent` — items + value + currency
- `ViewItemEvent` — items + value + currency
- `ViewItemListEvent` — items + item_list_name
- `SelectItemEvent` — items + item_list_name
- `BeginCheckoutEvent` — items + value + coupon
- `AddShippingInfoEvent` — items + shipping_tier
- `ViewCartEvent` — items + value + currency
- `ViewPromotionEvent` — items + promotion_name
- `SelectPromotionEvent` — items + promotion_name
- `LoginEvent` — method
- `SearchEvent` — search_term

## Availability Enum
```typescript
type ItemAvailability =
  | "https://schema.org/BackOrder"
  | "https://schema.org/Discontinued"
  | "https://schema.org/InStock"
  | "https://schema.org/InStoreOnly"
  | "https://schema.org/LimitedAvailability"
  | "https://schema.org/OnlineOnly"
  | "https://schema.org/OutOfStock"
  | "https://schema.org/PreOrder"
  | "https://schema.org/PreSale"
  | "https://schema.org/SoldOut";
```

## Key Rules for Platform Implementors

1. **`Offer.seller` MUST be the seller ID** (e.g., "1"), never the seller name
2. **`Offer.sellerName`** is optional and holds the display name
3. **Prices are in decimal** (not cents) — e.g., `199.90` not `19990`
4. **`productID`** = platform SKU ID; **`ProductGroup.productGroupID`** = platform product ID
5. **`Product.sku`** should equal `productID` — used for cart operations
6. **Images** must be `ImageObject[]` with `url`, `alternateName`, `encodingFormat`
7. **Breadcrumbs** use `ListItem<string>` with `position` (1-indexed) and `item` (URL)
8. **Category strings** use ` > ` separator (e.g., `"Furniture > Chairs > Office"`)
