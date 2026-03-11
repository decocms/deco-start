# Common TypeScript Fixes - Detailed Patterns

## 1. Props Exports for Deco Sections

Deco's admin UI needs to read the Props type to generate the form. Without an export, blocks may fail to render or configure.

### Detection

```bash
# Find sections/components without exported Props
grep -r "interface Props" sections/ components/ | grep -v "export"
```

### Fix Pattern

```typescript
// sections/MySection.tsx

// WRONG - interface not exported
interface Props {
  title: string;
  description?: string;
}

// CORRECT - export the interface
export interface Props {
  title: string;
  description?: string;
}

// Also valid - type alias
export type Props = {
  title: string;
  description?: string;
};
```

### Deco-Specific Requirements

For sections that are used in blocks:
- Props MUST be exported
- Props must use serializable types (no functions, classes)
- Use JSDoc comments for field descriptions in the admin

```typescript
export interface Props {
  /** @title Page Title */
  /** @description The main heading shown to users */
  title: string;

  /** @format rich-text */
  content?: string;
}
```

---

## 2. Global Type Declarations

Third-party scripts inject globals into the window. TypeScript doesn't know about them.

### Common Globals in E-commerce

```typescript
// types/global.d.ts

// Marketing/Recommendation platform queue pattern
export type AnalyticsCommand =
  | ["cart", CartItem[]]
  | ["setEmail", string]
  | ["searchTerm", string]
  | ["go"]
  | ["view", string]
  | ["category", string]
  | ["recommend", RecommendOptions];

// Tag manager
// deno-lint-ignore no-var
declare global {
  var dataLayer: unknown[];
}

// Third-party tracker pattern
export type TrackerFn = {
  (args: unknown): void;
  q?: unknown[];  // Queue for calls before script loads
  aid?: string;   // Account/API identifier
};

declare global {
  // deno-lint-ignore no-var
  var tracker: TrackerFn;
  // deno-lint-ignore no-var
  var AnalyticsQueue: AnalyticsCommand[];
}

// Export empty to make it a module
export {};
```

### Usage After Declaration

```typescript
// Now TypeScript knows about these globals
AnalyticsQueue.push(["view", productId]);
dataLayer.push({ event: "pageview" });
```

---

## 3. VTEX GraphQL Type Mismatches

VTEX SDK types often don't match the actual GraphQL response. Create bridge types.

### Problem

```typescript
// SDK says order has this shape:
interface Order {
  items: OrderItem[];
  shippingData: ShippingData;
}

// But GraphQL returns different fields:
{
  items: [...],
  logistics: [...],  // Not shippingData!
}
```

### Solution: Custom Response Types

```typescript
// types/vtex-orders.ts

// Match what GraphQL actually returns
export interface LogisticsInfo {
  deliveryChannel?: string;
  shippingEstimateDate?: string;
}

export interface VtexOrderData {
  orderId: string;
  items: OrderItem[];
  logistics: LogisticsInfo[];  // Different from SDK type
  totals: Total[];
}

// Usage with type assertion
const orderData = await fetchOrder(orderId);
const order = orderData as unknown as VtexOrderData;
```

---

## 4. Optional Chaining Patterns

### Array Access

```typescript
// BEFORE - may throw if products is undefined
const firstProduct = products[0];

// AFTER
const firstProduct = products?.[0];
```

### Nested Optional Access

```typescript
// BEFORE
const city = order.shippingData.address.city;

// AFTER
const city = order?.shippingData?.address?.city ?? "Unknown";
```

### Method Calls on Optional

```typescript
// BEFORE
const upper = user.getName().toUpperCase();

// AFTER
const upper = user?.getName?.()?.toUpperCase?.() ?? "";
```

### With Fallbacks for Different Types

```typescript
// For strings
const title = product?.name ?? "Untitled";

// For numbers
const price = product?.price ?? 0;

// For arrays
const tags = product?.tags ?? [];

// For objects
const specs = product?.specifications ?? {};
```

---

## 5. Event Handler Types

### Mouse Events

```typescript
// BEFORE - implicit any
const handleClick = (e) => { ... };

// AFTER
const handleClick = (e: MouseEvent) => { ... };

// For React/Preact
const handleClick = (e: h.JSX.TargetedMouseEvent<HTMLButtonElement>) => { ... };
```

### Input Events

```typescript
// Generic input
const handleInput = (e: Event) => {
  const target = e.target as HTMLInputElement;
  const value = target.value;
};

// Preact specific
const handleInput = (e: h.JSX.TargetedEvent<HTMLInputElement>) => {
  const value = e.currentTarget.value;
};
```

### Form Events

```typescript
const handleSubmit = (e: h.JSX.TargetedEvent<HTMLFormElement>) => {
  e.preventDefault();
  // ...
};
```

---

## 6. Import Path Updates After Migration

When migrating from a fork to official apps:

### Common Changes

```typescript
// BEFORE - forked apps
import { ProductDetailsPage } from "apps/commerce/types.ts";
import type { Product } from "apps/commerce/types.ts";

// AFTER - may need different paths or types
import { ProductDetailsPage } from "apps/commerce/types.ts";
import type { Product } from "apps/commerce/types.ts";
// Often the same, but verify the types match
```

### Loader Props Pattern

```typescript
// Ensure loaders export Props for deco
import type { Props as VTEXProps } from "apps/vtex/loaders/intelligentSearch/productList.ts";

export interface Props extends VTEXProps {
  // Additional custom props
  customField?: string;
}
```

---

## 7. Discriminated Unions for Platform Code

If supporting multiple platforms, use discriminated unions:

```typescript
type CartProps =
  | { platform: "vtex"; cartId: string }
  | { platform: "shopify"; checkoutId: string }
  | { platform: "wake"; cartToken: string };

function getCart(props: CartProps) {
  switch (props.platform) {
    case "vtex":
      return vtexCart(props.cartId);
    case "shopify":
      return shopifyCart(props.checkoutId);
    case "wake":
      return wakeCart(props.cartToken);
  }
}
```

---

## 8. Type Narrowing Patterns

### Using Type Guards

```typescript
function isProduct(item: unknown): item is Product {
  return (
    typeof item === "object" &&
    item !== null &&
    "productID" in item &&
    "name" in item
  );
}

// Usage
if (isProduct(data)) {
  console.log(data.name);  // TypeScript knows it's a Product
}
```

### Assertion Functions

```typescript
function assertProduct(item: unknown): asserts item is Product {
  if (!isProduct(item)) {
    throw new Error("Expected Product");
  }
}
```
