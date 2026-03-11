# Bug Fix Checklist

8 learnings from real Deco sites. Check these during analysis.

## Defensive Coding

### 1. Defensive Prop Handling
**Check**: Are CMS-configurable props accessed safely?

```typescript
// Bad: Crashes on undefined
const title = props.title.toUpperCase();
const items = props.items.map(i => i.name);

// Good: Optional chaining
const title = props.title?.toUpperCase() ?? "";
const items = props.items?.map(i => i?.name) ?? [];
```

CMS props can be:
- Undefined (not configured)
- Null (explicitly cleared)
- Empty arrays/strings

### 2. Safe Request Parsing
**Check**: Are API routes handling malformed requests?

```typescript
// Bad: Crashes on empty/malformed body
export async function handler(req: Request) {
  const body = await req.json();
  return Response.json({ ok: true });
}

// Good: Try-catch wrapper
export async function handler(req: Request) {
  try {
    const body = await req.json();
    // ... process
  } catch (e) {
    return new Response("Bad Request", { status: 400 });
  }
}
```

### 3. Current Product Exclusion
**Check**: Do "Related Products" shelves include current product?

```typescript
// Good: Filter out current product
const relatedProducts = allProducts.filter(p => p.id !== currentProductId);
```

## Content Sanitization

### 4. Protocol Upgrade Filter
**Check**: Does external content have `http://` links?

```typescript
// Good: Upgrade to HTTPS
function sanitizeContent(html: string): string {
  return html.replace(/http:\/\//g, 'https://');
}

// Apply to product descriptions, CMS content, etc.
<div dangerouslySetInnerHTML={{ 
  __html: sanitizeContent(product.description) 
}} />
```

Mixed content blocks images, scripts, and iframes.

### 5. UTM Injection Prevention
**Check**: Are empty links being processed?

```typescript
// Bad: Crashes on empty href
document.querySelectorAll('a').forEach(link => {
  const url = new URL(link.href); // Crashes if href is ""
  url.searchParams.set('utm_source', 'site');
  link.href = url.toString();
});

// Good: Validate first
document.querySelectorAll('a[href]').forEach(link => {
  if (!link.href || link.href === '#') return;
  try {
    const url = new URL(link.href);
    url.searchParams.set('utm_source', 'site');
    link.href = url.toString();
  } catch {}
});
```

## SEO & Indexing

### 6. Soft Out-of-Stock Handling
**Check**: Do out-of-stock pages return 404?

```typescript
// Bad: 404 for out-of-stock (loses SEO)
if (!product.available) {
  return new Response("Not Found", { status: 404 });
}

// Good: 200 with unavailable state
if (!product.available) {
  return renderUnavailablePage(product); // Status 200
}
```

Out-of-stock products should:
- Return 200 status
- Show "unavailable" UI
- Keep structured data
- Maintain SEO value

## UI Stability

### 7. Smooth Image Transitions
**Check**: Do hover effects cause flickering?

```css
/* Bad: Flicker on hover */
.product-card:hover .secondary-image {
  display: block; /* Hidden class uses display:none */
}

/* Good: Opacity transition */
.product-card .secondary-image {
  opacity: 0;
  transition: opacity 0.3s;
}
.product-card:hover .secondary-image {
  opacity: 1;
}
```

Never combine `display: none` with opacity transitions.

### 8. Pricing Consistency
**Check**: Is promotional logic duplicated?

```typescript
// Bad: Different calculations in different places
// ProductCard.tsx
const price = product.price * 0.9;

// ProductDetails.tsx
const price = product.price - 10;

// Good: Centralized utility
// utils/pricing.ts
export function calculateFinalPrice(product: Product): number {
  const promotion = getActivePromotion(product);
  return applyPromotion(product.price, promotion);
}
```

Centralize:
- Discount calculations
- Promotion logic
- Price formatting

## Quick Audit Commands

```bash
# Find unsafe prop access (no optional chaining)
grep -rn "props\.\w\+\." sections/ | grep -v "props\.\w\+?\."

# Find direct URL construction without try-catch
grep -rn "new URL" islands/ | grep -v "try"

# Find http:// in content
grep -r "http://" .deco/blocks/*.json | grep -v "https://"

# Find 404 responses
grep -r "status: 404" loaders/ sections/
```

## Common Bug Patterns

| Bug | Symptom | Fix |
|-----|---------|-----|
| Null prop access | White screen, error in console | Add optional chaining |
| Mixed content | Images not loading | Upgrade http to https |
| OOS 404 | SEO drops for seasonal items | Return 200 with unavailable UI |
| Duplicate pricing | Different prices across site | Centralize price logic |
| Flickering images | Visual glitch on hover | Use opacity not display |
