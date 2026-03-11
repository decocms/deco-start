# transform.ts — VTEX → schema.org Mapping Reference

Complete field-by-field mapping from VTEX API types to schema.org commerce types.

## toProduct() — VTEX → schema.org Product

| VTEX Field | schema.org Field | Notes |
|-----------|-----------------|-------|
| `sku.itemId` | `productID`, `sku` | SKU identifier |
| `sku.name` | `name` | SKU name |
| `sku.complementName` | `alternateName` | |
| `product.description` | `description` | |
| `product.brand` | `brand.name` | Wrapped in Brand object |
| `product.brandId` | `brand.@id` | |
| `product.brandImageUrl` | `brand.logo` | |
| `sku.ean` | `gtin` | |
| `product.releaseDate` | `releaseDate` | |
| `product.categories[0]` | `category` | Split by `/`, joined with `>` |
| `product.productId` | `inProductGroupWithID` | |
| `product.productReference` | `isVariantOf.model` | |

## buildOffer() — VTEX Seller → schema.org Offer

| VTEX Field | schema.org Field | Notes |
|-----------|-----------------|-------|
| `sellerId` | `seller` | **MUST be ID, not name** |
| `sellerName` | `sellerName` | Display name |
| `sellerDefault` | `identifier: "default"` | Only when true |
| `commertialOffer.spotPrice ?? Price` | `price` | Spot price preferred |
| `commertialOffer.PriceValidUntil` | `priceValidUntil` | |
| `commertialOffer.AvailableQuantity` | `inventoryLevel.value` | |
| `commertialOffer.AvailableQuantity > 0` | `availability` | InStock / OutOfStock |
| `commertialOffer.GiftSkuIds` | `giftSkuIds` | |
| `commertialOffer.teasers` | `teasers` | |

## priceSpecification — Prices and Installments

| VTEX Field | priceType | Notes |
|-----------|-----------|-------|
| `ListPrice` | `https://schema.org/ListPrice` | Original price |
| `Price` | `https://schema.org/SalePrice` | Sale price |
| `PriceWithoutDiscount` | `https://schema.org/SRP` | Suggested retail |
| `Installments[]` | `https://schema.org/Installment` | Each installment option |

### Installment Mapping

| VTEX Installment | UnitPriceSpecification |
|-----------------|----------------------|
| `PaymentSystemName` | `name` |
| `Name` | `description` |
| `NumberOfInstallments` | `billingDuration` |
| `Value` | `billingIncrement` |
| `TotalValuePlusInterestRate` | `price` |

## Images

| VTEX Field | schema.org ImageObject |
|-----------|----------------------|
| `imageUrl` | `url` |
| `imageText` or `imageLabel` | `alternateName` |
| `imageLabel` | `name` |
| (fixed) | `encodingFormat: "image"` |

## isVariantOf — ProductGroup

| VTEX Field | schema.org ProductGroup |
|-----------|----------------------|
| `product.productId` | `productGroupID` |
| `product.items` → each via `toProduct(level=1)` | `hasVariant` |
| `/{linkText}/p` | `url` |
| `product.productName` | `name` |
| `product.productReference` | `model` |

`level` prevents infinite recursion: `level=0` includes `isVariantOf`, `level=1` sets it to `undefined`.

## Breadcrumbs

| Source | ListItem |
|--------|----------|
| `categories[0]` split by `/` | Each segment → `name`, `position`, `item` (URL) |
| `productName` | Last item → URL = `/{linkText}/p` |

## isLegacyProduct Detection

```typescript
product.origin !== "intelligent-search" → Legacy (uses toOfferLegacy)
product.origin === "intelligent-search" → IS (uses toOffer)
```

Both `toOffer` and `toOfferLegacy` call `buildOffer()` internally, ensuring `seller: sellerId`.

## additionalProperty Sources

- SKU variations (SPECIFICATION)
- Product categories (CATEGORY)
- Product clusters (CLUSTER)
- Reference IDs (ReferenceID)
- Estimated date arrival
- Modal type
