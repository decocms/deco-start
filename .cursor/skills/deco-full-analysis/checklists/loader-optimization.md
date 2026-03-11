# Loader Optimization Checklist

33 learnings from real Deco sites. Check these during analysis.

## Critical Patterns

### 1. Lazy Section Wrapping
**Check**: Are below-fold sections with heavy loaders wrapped in `Lazy`?
- BuyTogether, ProductShelf, Reviews, SimilarProducts
- Any section that fetches data and isn't above the fold

```json
// Good: Wrapped in Lazy
{
  "__resolveType": "website/sections/Rendering/Lazy.tsx",
  "section": { "__resolveType": "site/sections/Product/BuyTogether.tsx" }
}
```

### 2. AbortController Timeout
**Check**: Do external API calls have timeout protection?
- Reviews APIs, recommendation APIs, third-party services
- Add `AbortController` with reasonable timeout (5-10s)

```typescript
// Good: Has timeout
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5000);
const response = await fetch(url, { signal: controller.signal });
```

### 3. Client-Side Data Fetching for Below-Fold
**Check**: Are PDP loaders blocking on below-fold content?
- Move `fetchSimilars`, `fetchReviews`, `fetchRelated` to client-side islands
- Don't block SSR on non-critical data

### 4. Remove Sync Product Loaders from Header
**Check**: Does Header have product loaders that block render?
- Headers should be fast and static
- Move product data to islands or separate sections

## VTEX-Specific

### 5. Simulation Behavior
**Check**: Is VTEX simulation set correctly?

| Setting | Use Case |
|---------|----------|
| `skip` | Maximum performance, no real-time pricing |
| `only1P` | Balanced - first-party simulation only |
| `default` | Full simulation (slower) |

```typescript
// In VTEX loader config
simulationBehavior: "only1P" // or "skip" for PLPs
```

### 6. Intelligent Search Migration
**Check**: Are you using legacy loaders?
- Replace `deco-sites/std` loaders with `vtex/loaders/intelligentSearch`
- Replace legacy cross-selling with Intelligent Search

### 7. Legacy Loader Fallback
**Check**: Do category paths fail to resolve?
- If Intelligent Search fails, try Legacy VTEX loader as fallback

## Loader Architecture

### 8. Loader Deduplication via Blocks
**Check**: Are common loaders duplicated across pages?
- Use shared loader blocks instead of inline configurations
- Centralizes PDP/PLP loaders for cache deduplication

```json
// Good: Reference shared block
{ "__resolveType": "$live/loaders/Loader.tsx", "loader": "PDP-Main-Loader" }
```

### 9. Loader Simplification
**Check**: Are there redundant loaders?
- Remove loaders that only pass through data already available
- Avoid manual `fetch` calls when standard loaders exist

### 10. Cascading Fallback Search
**Check**: Do recommendation loaders return empty?
- Implement fallback: Subcategory → Category → Global
- Prevents empty shelves

## Performance Patterns

### 11. Batch and Debounce
**Check**: Are there high-frequency small API calls?
- Batch review/stock/rating calls into single loader
- Use client-side debouncing

### 12. API Result Limiting
**Check**: Do loaders fetch too much data?
- Always apply limits to review/comment loaders
- Use pagination for large datasets

### 13. Concurrent Batch Fetching
**Check**: Are multi-item lookups sequential?
```typescript
// Bad: Sequential
for (const id of ids) { await fetch(id); }

// Good: Parallel
await Promise.all(ids.map(id => fetch(id)));
```

### 14. Cursor Pagination
**Check**: Do infinite scroll lists use offset pagination?
- Use cursor-based pagination for better scaling

## Custom Loaders

### 15. Global Signal Caching
**Check**: Do multiple components make the same API call?
- Use global signals or shared cache
- Prevents duplicate cashback/loyalty requests

### 16. Retail API Integration
**Check**: Are personalization APIs using correct session IDs?
- Extract visitor/session ID from cookies correctly

### 17. External API Loaders
**Check**: Do loaders have proper error handling?
- Use `ctx.invoke` instead of raw `fetch` where possible
- Add timeout and retry logic

### 18. Slug Normalization
**Check**: Do collection URLs work consistently?
- Normalize slugs and database keys using same logic

## Section Optimization

### 19. Section Deferral
**Check**: Are heavy non-LCP sections deferred?
- Complex headers/footers can use Lazy rendering
- Balance against UX

### 20. Skeleton Fallbacks
**Check**: Do async sections have loading states?
```typescript
export function LoadingFallback() {
  return <div class="skeleton h-64 w-full" />;
}
```

### 21. Deferred Tab Loading
**Check**: Do tabbed components load all tabs on server?
- Use `isDeferred` and `asResolved` to load only active tab

## Quick Audit Commands

```bash
# Find loaders without cache
grep -L "export const cache" loaders/**/*.ts

# Find sections not wrapped in Lazy
grep -r "__resolveType.*sections" .deco/blocks/pages-*.json | grep -v "Lazy"

# Find fetch calls in loaders (should use ctx.invoke)
grep -r "await fetch" loaders/
```
