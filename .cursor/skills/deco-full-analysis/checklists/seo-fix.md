# SEO Fix Checklist

10 learnings from real Deco sites. Check these during analysis.

## Structured Data (JSON-LD)

### 1. Safe JSON-LD Embedding
**Check**: Is JSON-LD properly escaped?

```typescript
// Bad: Vulnerable to injection
<script type="application/ld+json">
  {JSON.stringify(product)}
</script>

// Good: Escape < character
<script type="application/ld+json">
  {JSON.stringify(product).replace(/</g, '\\u003c')}
</script>
```

This prevents:
- Google Search Console errors
- XSS injection attacks

### 2. Price Formatting
**Check**: Are prices formatted to exactly 2 decimals?

```typescript
// Bad: Variable decimals
price: product.price // 99.9 or 99

// Good: Always 2 decimals
price: product.price.toFixed(2) // "99.90"
```

Google Merchant Center requires exactly 2 decimal places.

### 3. GTIN/EAN Validation
**Check**: Are GTIN codes validated before including?

```typescript
function isValidGTIN(gtin: string): boolean {
  // Implement checksum validation
  const digits = gtin.replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  // ... checksum logic
}

// Only include if valid
gtin: isValidGTIN(product.gtin) ? product.gtin : undefined
```

Invalid GTINs cause Merchant Center penalties.

### 4. FAQ Schema
**Check**: Do FAQ sections inject JSON-LD?

```typescript
const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": questions.map(q => ({
    "@type": "Question",
    "name": q.question,
    "acceptedAnswer": {
      "@type": "Answer",
      "text": q.answer
    }
  }))
};
```

## Meta Tags

### 5. Duplicate Meta Descriptions
**Check**: Is only one SEO section active per page?

```bash
# Find pages with multiple SEO sections
grep -l "SEO" .deco/blocks/pages-*.json | xargs grep -c "SEO"
```

Multiple SEO sections = duplicate meta tags = SEO penalty.

### 6. SEO Block on Every Page
**Check**: Does every page block have an `seo` section?

```json
{
  "name": "Home",
  "sections": [...],
  "seo": {
    "__resolveType": "website/sections/Seo/Seo.tsx",
    "title": "...",
    "description": "..."
  }
}
```

## Canonical URLs

### 7. Strip Non-SEO Parameters
**Check**: Do canonical URLs include tracking params?

```typescript
// Good: Strip UTMs and tracking
function getCanonicalUrl(url: URL): string {
  const canonical = new URL(url);
  ['utm_source', 'utm_medium', 'utm_campaign', 'gclid', 'fbclid']
    .forEach(param => canonical.searchParams.delete(param));
  return canonical.toString();
}
```

### 8. Noindex for Filtered PLPs
**Check**: Are PLPs with filters indexed?

```typescript
// Add noindex for filtered/sorted pages
const hasFilters = url.searchParams.has('filter') || 
                   url.searchParams.has('sort');

<meta name="robots" content={hasFilters ? "noindex,follow" : "index,follow"} />
```

## Semantic HTML

### 9. Single H1 Per Page
**Check**: Is the primary title wrapped in `<h1>`?

```tsx
// PDP: Product name should be h1
<h1>{product.name}</h1>

// PLP: Category name should be h1
<h1>{category.name}</h1>

// Search: Search term should be h1
<h1>Results for "{query}"</h1>
```

### 10. Language Attribute
**Check**: Is the `lang` attribute correct?

```typescript
// In fresh.config.ts
export default defineConfig({
  lang: "pt-BR", // or "en-US", etc.
});
```

## Quick Audit Commands

```bash
# Check for pages without SEO section
for f in .deco/blocks/pages-*.json; do
  grep -q '"seo"' "$f" || echo "Missing SEO: $f"
done

# Find duplicate meta descriptions in page
grep -c '"description"' .deco/blocks/pages-*.json | grep -v ':1$'

# Check for unescaped JSON-LD
grep -r "JSON.stringify" sections/ | grep -v "replace"
```

## SEO Audit Table

Add this to AGENTS.md:

```markdown
## SEO Health

| Check | Status |
|-------|--------|
| All pages have SEO section | ✅ |
| JSON-LD properly escaped | ✅ |
| Prices have 2 decimals | ❌ Check ProductCard |
| GTIN validation | ⚠️ Not implemented |
| Canonical URLs clean | ✅ |
| Filtered PLPs noindex | ❌ Missing |
```
