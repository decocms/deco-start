# Cache Strategy Checklist

7 learnings from real Deco sites. Check these during analysis.

## Loader Caching

### 1. Stale-While-Revalidate Pattern
**Check**: Do custom loaders have cache configuration?

```typescript
// Good: Has caching
export const cache = "stale-while-revalidate";

export const cacheKey = (props: Props) =>
  `${props.productId}-${props.locale}`;

export default async function loader(props: Props) {
  // ...
}
```

### 2. Deterministic Cache Keys
**Check**: Are cache keys based on unique identifiers?

```typescript
// Bad: Uses full URL (includes tracking params)
export const cacheKey = (props: Props, req: Request) => req.url;

// Good: Uses only relevant data
export const cacheKey = (props: Props) => {
  const facets = [...(props.facets || [])].sort();
  return `${props.query}-${facets.join(",")}`;
};
```

**Common mistakes**:
- Including UTM parameters in cache key
- Including session/user-specific data
- Using unsorted arrays (order changes = cache miss)

### 3. Loader Deduplication via Shared Blocks
**Check**: Are the same loaders configured inline in multiple places?

```json
// Bad: Same loader inline in multiple pages
// pages-Home.json, pages-PLP.json, pages-PDP.json all have:
{ "loader": { "productId": "..." } }

// Good: Reference shared block
{ "__resolveType": "$live/loaders/Loader.tsx", "loader": "PDP-Main-Loader" }
```

Benefits:
- Single cache entry for same data
- Easier to update
- Better hit rate

## Rate Limiting

### 4. Bot-Specific Rate Limiting
**Check**: Do bots and users share rate limits?

```typescript
// In _middleware.ts
const isBot = req.headers.get("user-agent")?.includes("bot");

if (isBot) {
  // Apply stricter rate limiting for bots
  const botRateLimit = await checkBotRateLimit(ip);
  if (botRateLimit.exceeded) {
    return new Response("Too Many Requests", { status: 429 });
  }
}
```

### 5. Granular Rate Limit Tracking
**Check**: Is rate limiting per-endpoint or global?
- Track rate limits per endpoint for critical paths
- Allow more requests to cached endpoints

## SSR Caching

### 6. SSR Promotion Fetching
**Check**: Is promotion data fetched client-side causing CLS?
- Fetch discount/promotion rules on server
- Prevents price flickering

```typescript
// Good: Fetch on server
export default async function ProductCard({ product }: Props) {
  const promotion = await fetchPromotion(product.id);
  const finalPrice = applyPromotion(product.price, promotion);
  return <Card price={finalPrice} />;
}
```

### 7. Related Products Caching
**Check**: Do related product loaders have cache?
- Often high-volume, low-change-rate
- Good candidate for aggressive caching

```typescript
export const cache = "stale-while-revalidate";
export const cacheKey = (props: Props) => `related-${props.productId}`;
```

## Cache Audit Table

Add this to AGENTS.md:

```markdown
## Caching Inventory

| Loader | Cache | Cache Key | Priority |
|--------|-------|-----------|----------|
| `loaders/search/intelligentSearch.ts` | ❌ None | - | 🔴 High |
| `loaders/product/buyTogether.ts` | ✅ SWR | productId | - |
| `loaders/getUserGeolocation.ts` | ❌ None | - | 🟡 Medium |
| `vtex/loaders/categories/tree.ts` | ❌ None | - | 🔴 High |
```

## Quick Audit Commands

```bash
# Find loaders without cache
grep -L "export const cache" loaders/**/*.ts

# Find loaders with cache but no cacheKey
grep -l "export const cache" loaders/**/*.ts | xargs grep -L "cacheKey"

# Find inline loaders in page blocks (should be shared)
grep -r '"loader":' .deco/blocks/pages-*.json | grep -v "__resolveType"
```

## Common Cache Durations

| Content Type | Strategy | TTL |
|--------------|----------|-----|
| Product details | SWR | 5 min |
| Category tree | SWR | 1 hour |
| Search results | SWR | 1 min |
| Reviews | SWR | 15 min |
| Static content | SWR | 1 day |
| User-specific | None | - |
