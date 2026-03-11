# Asset Optimization Checklist

17 learnings from real Deco sites. Check these during analysis.

## Third-Party Scripts

### 1. On-Demand Script Loading
**Check**: Are heavy scripts loaded on page load?

```typescript
// Bad: Loads immediately
<script src="https://chat-widget.com/bundle.js" />

// Good: Load on interaction
function ChatButton() {
  const [loaded, setLoaded] = useState(false);
  
  const loadChat = () => {
    if (!loaded) {
      const script = document.createElement('script');
      script.src = "https://chat-widget.com/bundle.js";
      document.body.appendChild(script);
      setLoaded(true);
    }
  };
  
  return <button onClick={loadChat}>Chat</button>;
}
```

### 2. Route-Specific Script Injection
**Check**: Do scripts load on pages where they're not used?

```typescript
// Good: Only load on relevant pages
const isCheckout = ctx.url.pathname.startsWith('/checkout');
const isPDP = ctx.url.pathname.includes('/p');

return (
  <>
    {isCheckout && <PaymentScript />}
    {isPDP && <ReviewScript />}
  </>
);
```

### 3. Script Localization
**Check**: Are external scripts hosted locally?
- Localize frequently used scripts to `/static`
- Improves reliability and performance
- Works offline

```typescript
// Before: External
<script src="https://unpkg.com/htmx.org@1.9.10" />

// After: Local
<script src="/static/htmx-1.9.10.js" />
```

### 4. GTM Implementation
**Check**: Does GTM have noscript fallback?

```html
<!-- Head -->
<script>(function(w,d,s,l,i){...})(window,document,'script','dataLayer','GTM-XXX');</script>

<!-- Body (required) -->
<noscript>
  <iframe src="https://www.googletagmanager.com/ns.html?id=GTM-XXX" />
</noscript>
```

### 5. Third-Party Widget Removal
**Check**: Are there unused third-party widgets?
- Audit PDP for review widgets that can be lazy-loaded
- Remove chat widgets from pages where not needed
- Defer non-critical analytics

## Section Optimization

### 6. Lazy Section Loading
**Check**: Are heavy below-fold sections lazy?

```json
{
  "__resolveType": "website/sections/Rendering/Lazy.tsx",
  "section": { "__resolveType": "site/sections/Product/Reviews.tsx" }
}
```

Best candidates for lazy loading:
- Product shelves
- Reviews
- Similar products
- FAQ sections
- Instagram feeds

### 7. Skeleton/Fallback Pattern
**Check**: Do async sections have loading states?

```typescript
export function LoadingFallback() {
  return (
    <div class="animate-pulse">
      <div class="h-8 bg-gray-200 rounded w-1/3 mb-4" />
      <div class="grid grid-cols-4 gap-4">
        {[...Array(4)].map(() => (
          <div class="h-64 bg-gray-200 rounded" />
        ))}
      </div>
    </div>
  );
}
```

### 8. Video Section Handling
**Check**: Are video sections wrapped in Lazy/Deferred?
- Native video or iframes should NOT be lazy wrapped
- Causes interaction breakage
- Only lazy wrap if explicitly needed

## Block Architecture

### 9. Block Flattening
**Check**: Are there unnecessary PageInclude wrappers?

```json
// Bad: Extra resolution overhead
{
  "__resolveType": "website/sections/PageInclude.tsx",
  "page": { "__resolveType": "Header-Block" }
}

// Good: Direct reference
{
  "__resolveType": "$Header-Block"
}
```

## Migration

### 10. Standard Library Migration
**Check**: Are there `deco-sites/std` imports?

```typescript
// Bad: Legacy
import { Image } from "deco-sites/std/components/Image.tsx";

// Good: Modern
import { Image } from "apps/website/components/Image.tsx";
```

Audit all imports and replace:
- `deco-sites/std` → `apps/`

## Layout Stability

### 11. Aspect Ratio Reservation
**Check**: Do images/videos cause CLS?

```tsx
// Good: Reserve space
<div class="aspect-video relative">
  <Image class="absolute inset-0 w-full h-full object-cover" />
</div>
```

## Security

### 12. CSP Hardening
**Check**: Are CSP headers configured?

```typescript
// In _middleware.ts
const cspHeader = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com",
  "worker-src 'self'",
  "frame-ancestors 'self'",
].join("; ");

response.headers.set("Content-Security-Policy", cspHeader);
```

### 13. Service Worker Strategy
**Check**: Is Service Worker strategy optimal?

```typescript
// Avoid: NetworkOnly as default (negates caching)
defaultStrategy: "NetworkOnly"

// Better: CacheFirst or StaleWhileRevalidate
defaultStrategy: "CacheFirst"
```

## Deno Configuration

### 14. Deno Native Optimization
**Check**: Is `nodeModulesDir` enabled unnecessarily?

```json
// deno.json - disable if not needed
{
  "nodeModulesDir": false  // Faster startup, less disk
}
```

### 15. Relative Path Invocation
**Check**: Are loaders using absolute URLs?

```typescript
// Bad: Cross-domain overhead
fetch("https://mysite.com/live/invoke/...");

// Good: Relative path
fetch("/live/invoke/...");
```

## Quick Audit Commands

```bash
# Find deco-sites/std imports
grep -r "deco-sites/std" sections/ loaders/ components/

# Find third-party scripts
grep -r '<script src="http' sections/ components/

# Find sections without LoadingFallback
for f in sections/**/*.tsx; do
  grep -q "LoadingFallback" "$f" || echo "Missing fallback: $f"
done

# Check CSP headers
grep -r "Content-Security-Policy" routes/ _middleware.ts
```

## Asset Audit Table

Add this to AGENTS.md:

```markdown
## Third-Party Scripts

| Script | Pages | Load Strategy | Action |
|--------|-------|---------------|--------|
| GTM | All | Head | ✅ OK |
| Chat Widget | All | Eager | 🔴 Make lazy |
| Reviews | PDP | Eager | 🟡 Consider lazy |
| Payment | Checkout | Conditional | ✅ OK |
```
