# Image Optimization Checklist

18 learnings from real Deco sites. Check these during analysis.

## LCP (Largest Contentful Paint)

### 1. LCP Image Prioritization
**Check**: Does the LCP image have correct attributes?

```tsx
// Good: LCP image
<Image
  src={bannerUrl}
  loading="eager"           // NOT "lazy"
  fetchPriority="high"      // Prioritize network fetch
  decoding="sync"           // Don't defer decoding
  preload                   // Add link preload header
/>
```

### 2. Banner Carousel First Item
**Check**: Is the first carousel item prioritized?
- First banner: `loading="eager"`, `fetchPriority="high"`
- Other banners: `loading="lazy"`

### 3. PLP First Products
**Check**: Are the first 4-6 product images prioritized?
```tsx
{products.map((p, i) => (
  <Image
    loading={i < 6 ? "eager" : "lazy"}
    fetchPriority={i < 4 ? "high" : "auto"}
  />
))}
```

### 4. Full-width Hero Optimization
**Check**: Do LCP banners have restrictive styles?
- Use `w-full` without max-width constraints
- Avoid padding that causes layout shift

### 5. Preload Background Images
**Check**: Are CSS background images preloaded?
```tsx
// In section, add preload header
ctx.response.headers.append(
  "Link",
  `<${imageUrl}>; rel="preload"; as="image"; fetchpriority="high"`
);
```

## Image Component

### 6. Use Deco Image Component
**Check**: Are all images using `<Image />`?
- Enables automatic CDN optimization
- Requires explicit `width` and `height`

```tsx
// Good
import { Image } from "apps/website/components/Image.tsx";
<Image src={url} width={300} height={200} />

// Bad
<img src={url} />
```

### 7. Platform Standard Optimization
**Check**: Are custom URL parsers used instead of standard?
- Use `getOptimizedMediaUrl` from apps/website
- Don't parse VTEX image URLs manually

### 8. URL Sanitization
**Check**: Do image URLs contain special characters?
- Sanitize URLs from external APIs
- Remove characters like `§` that break optimization

## Special Cases

### 9. SVG Handling
**Check**: Are SVGs going through image optimization?
- SVGs don't need raster optimization
- Use wrapper to bypass proxy for SVGs

```tsx
// Skip optimization for SVG
if (src.endsWith('.svg')) {
  return <img src={src} {...props} />;
}
return <Image src={src} {...props} />;
```

### 10. Animated WebP/GIF
**Check**: Are animated images becoming static?
- Disable optimization for animated WebP/GIF
- Check `animate` flag in VTEX URLs

### 11. VTEX Image Resizing
**Check**: Are VTEX images using correct dimensions?
```typescript
// Transform VTEX image URL
function getVtexImageUrl(url: string, width: number, height: number) {
  return url.replace(/\-\d+\-\d+/, `-${width}-${height}`);
}
```

## Responsive Images

### 12. CSS-based Responsiveness
**Check**: Is `useDevice()` used for responsive images?
- Prefer `<picture>` and CSS media queries
- Avoids hydration mismatches

```tsx
// Good: CSS-based
<picture>
  <source media="(max-width: 768px)" srcSet={mobileUrl} />
  <Image src={desktopUrl} />
</picture>

// Avoid: JS-based
const device = useDevice();
return device === "mobile" ? <MobileImg /> : <DesktopImg />;
```

### 13. Breakpoint Precision
**Check**: Do responsive breakpoints overlap?
- Use non-overlapping breakpoints
- Prevent loading wrong image size

### 14. Sizes Attribute
**Check**: Do images have `sizes` attribute?
```tsx
<Image
  sizes="(max-width: 768px) 100vw, 50vw"
/>
```

## Layout Stability

### 15. Aspect Ratio Reservation
**Check**: Do images cause CLS?
- Wrap in containers with `aspect-ratio`
- Or use fixed dimensions

```tsx
<div class="aspect-video">
  <Image class="object-cover w-full h-full" />
</div>
```

### 16. Object-Fit for Banners
**Check**: Do banners crop marketing text?
- Use `object-fit: contain` for text-heavy banners
- Use `object-fit: cover` for full-bleed images

## UI Patterns

### 17. CSS-Based Peek Animation
**Check**: Are scroll animations JS-based?
- Prefer CSS keyframes for "product peeking" hints
- Reduces TBT

### 18. LCP Isolation
**Check**: Is LCP element in a complex section?
- Isolate LCP into standalone section
- Reduces render blocking

## Quick Audit Commands

```bash
# Find images without width/height
grep -r "<img" sections/ components/ | grep -v "width"

# Find images using native img instead of Image component
grep -rn "<img src" sections/ islands/

# Find useDevice in image components
grep -r "useDevice" sections/ | grep -i image
```
