---
name: deco-tanstack-hydration-fixes
description: Fix hydration mismatches, flash-of-white, CLS from third-party scripts, scroll-to-top bugs, and React DOM warnings in Deco storefronts on TanStack Start/React/Cloudflare Workers. Use when debugging hydration errors, page flicker during navigation, blank screen on F5, layout shifts from external scripts, or React console warnings about invalid DOM properties.
---

# Hydration & Navigation Fixes for Deco TanStack Storefronts

Patterns and fixes for hydration mismatches, flash-of-white, CLS, scroll issues, and React warnings discovered in production Deco storefronts running TanStack Start + React 19 + Cloudflare Workers.

## 1. Flash-of-White / Blank Screen on F5

**Symptom**: Page loads, goes blank for a moment, then content reappears.

**Root cause**: `React.lazy` + `<Suspense>` for eager (above-the-fold) sections. Even with `syncThenable` optimization, the module may not be synchronously available during hydration, causing React to show the fallback and discard server HTML.

### Fix: Synchronous Section Registry

Register critical above-the-fold sections with static imports so they never go through `React.lazy`:

```typescript
// site setup.ts
import { registerSectionsSync } from "@decocms/start/cms";
import HeaderSection from "./sections/Header/Header";
import FooterSection from "./sections/Footer/Footer";
import ThemeSection from "./sections/Theme/Theme";

registerSectionsSync({
  "site/sections/Header/Header.tsx": HeaderSection,
  "site/sections/Footer/Footer.tsx": FooterSection,
  "site/sections/Theme/Theme.tsx": ThemeSection,
});
```

In `DecoPageRenderer`, check `getSyncComponent(key)` first. If found, render directly without `<Suspense>`:

```tsx
const SyncComp = getSyncComponent(section.component);
if (SyncComp) {
  return (
    <section id={sectionId} data-manifest-key={section.key}>
      <SyncComp {...section.props} />
    </section>
  );
}
// else fall back to React.lazy
```

**Which sections to register sync**: Header, Footer, Theme, and any section visible on initial viewport (ProductInfo for PDP, SearchResult for PLP).

## 2. Hydration Mismatch from Environment Variables

**Symptom**: Console error `A tree hydrated but some attributes of the server rendered HTML didn't match the client properties` for `__DECO_STATE`.

**Root cause**: `process.env.DECO_SITE_NAME` resolves on the server (from `.env`) but is `undefined` on the client, falling back to a different hardcoded string.

### Fix: Vite `define` for Build-Time Injection

```typescript
// vite.config.ts
export default defineConfig({
  define: {
    "process.env.DECO_SITE_NAME": JSON.stringify(
      process.env.DECO_SITE_NAME || "your-site-name"
    ),
  },
});
```

This replaces `process.env.DECO_SITE_NAME` at build-time in **both** SSR and client bundles, guaranteeing the same value.

**Rule**: Any `process.env.*` used in JSX that renders on both server and client needs a Vite `define` entry. Otherwise, use `import.meta.env.VITE_*` (Vite auto-exposes `VITE_`-prefixed vars to client).

## 3. CLS from Third-Party Scripts

**Symptom**: Large Cumulative Layout Shift (CLS > 0.25) traced to external scripts injecting content.

### Common Offenders

| Script | Problem | Fix |
|--------|---------|-----|
| Raichu/ReclameAqui `bundle.js` | Inline `<script>` loads CSS that shifts layout | Convert to React component, defer with `useEffect` + `requestIdleCallback`, add `minHeight` |
| TrustVox widget | Injects DOM after load | Add `minHeight` on container divs |
| Any analytics/chat widget | Injects floating elements | Reserve space or load after hydration |

### Pattern: Deferred Script Component

```tsx
function DeferredScript({ src, id, dataset, minHeight = 60 }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || document.getElementById(id)) return;
    const load = () => {
      const script = document.createElement("script");
      script.id = id;
      script.async = true;
      script.src = src;
      Object.entries(dataset).forEach(([k, v]) => {
        script.dataset[k] = v;
      });
      ref.current?.appendChild(script);
    };
    if ("requestIdleCallback" in window) {
      requestIdleCallback(load, { timeout: 3000 });
    } else {
      setTimeout(load, 2000);
    }
  }, []);
  return <div ref={ref} id={`${id}-container`} style={{ minHeight }} />;
}
```

## 4. Async Rendering Double-Flash

**Symptom**: Deferred sections show the generic gray skeleton, then replace it with the custom `LoadingFallback`, then show the real content.

**Root cause**: `DeferredSectionWrapper` renders `DefaultSectionFallback` immediately while `preloadSectionModule` fetches the module to discover if a custom `loadingFallback` exists.

### Fix: Wait for Options Before Showing Any Fallback

```tsx
const [optionsReady, setOptionsReady] = useState(
  () => !!getSectionOptions(deferred.component),
);

useEffect(() => {
  if (optionsReady) return;
  preloadSectionModule(deferred.component).then((opts) => {
    if (opts) setLoadedOptions(opts);
    setOptionsReady(true);
  });
}, [deferred.component]);

const skeleton = !optionsReady
  ? null  // render nothing until we know which fallback to show
  : hasCustomFallback
    ? createElement(loadedOptions!.loadingFallback!)
    : <DefaultSectionFallback />;
```

## 5. Scroll-to-Top Inconsistency

**Symptom**: Clicking a product card navigates to PDP but page stays at scroll position of the shelf (near bottom).

**Root cause**: TanStack Router `scrollRestoration: true` has a known bug (#3804) where scroll-to-top doesn't always fire on forward navigation.

### Fix: Manual Scroll-to-Top on Forward Navigation

```typescript
// router.tsx
const router = createTanStackRouter({
  routeTree,
  scrollRestoration: true,
});

if (typeof window !== "undefined") {
  let lastAction: string | undefined;

  router.history.subscribe(({ action }) => {
    lastAction = action.type;
  });

  router.subscribe("onResolved", (evt) => {
    // PUSH/REPLACE = forward nav → scroll top
    // GO = back/forward → let scrollRestoration handle it
    if (evt.pathChanged && lastAction !== "GO") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });
}
```

Use `"smooth"` for pleasant UX, `"instant"` if speed is preferred.

## 6. Navigation Loading Feedback

**Symptom**: Clicking a product card gives no visual feedback for several seconds until the page loads.

### Fix: ProductLink Component with Spinner Overlay

```tsx
import { Link, useRouterState } from "@tanstack/react-router";

export default function ProductLink({ children, className, showSpinner = true, ...props }) {
  const targetPath = typeof props.to === "string" ? props.to : "";
  const isNavigating = useRouterState({
    select: (s) => {
      if (!s.isLoading || !targetPath) return false;
      const pending = s.location.pathname;
      const current = s.resolvedLocation?.pathname;
      return pending !== current && pending === targetPath;
    },
  });

  return (
    <Link
      className={`relative ${className ?? ""}${isNavigating ? " pointer-events-none" : ""}`}
      {...props}
    >
      {children}
      {showSpinner && isNavigating && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/60 rounded">
          <span className="loading loading-spinner loading-md text-primary" />
        </div>
      )}
    </Link>
  );
}
```

Replace `<Link>` in product card image areas with `<ProductLink>`. Use `showSpinner={false}` for text areas where the overlay would look odd.

**Complement with NavigationProgress bar** in `__root.tsx` using `useRouterState({ select: s => s.isLoading })`.

## 7. Common React DOM Warnings

| Warning | Cause | Fix |
|---------|-------|-----|
| `fetchpriority` → `fetchPriority` | HTML attr not camelCased | Change to camelCase in JSX |
| `stroke-linecap` → `strokeLinecap` | SVG attr not camelCased | Change to camelCase in JSX |
| `fill-rule` → `fillRule` | SVG attr not camelCased | Change to camelCase in JSX |
| `clip-rule` → `clipRule` | SVG attr not camelCased | Change to camelCase in JSX |
| `class` → `className` | Preact migration leftover | Replace throughout |
| Missing `key` in list | `.map()` without `key` | Add unique `key` prop |
| `value` without `onChange` | Controlled input missing handler | Add `onChange` or use `defaultValue` |
| `selected` on `<option>` | Old HTML pattern | Use `value` on parent `<select>` |

## 8. Performance Trace Recording (Chrome DevTools)

The Chrome Performance recorder is the most powerful tool for diagnosing CLS, hydration flash, and layout shift root causes. It captures exactly **which element shifted**, **by how many pixels**, and **what triggered it**.

### How to Record a Trace

1. Open Chrome DevTools → **Performance** tab
2. Check **Web Vitals** checkbox (bottom of panel) — this enables CLS tracking
3. Check **Screenshots** checkbox — captures visual frames to see the flash
4. Click **Record** (circle button) or press `Ctrl+E`
5. Reproduce the issue: F5 to reload, or navigate to the problematic page
6. Wait for the page to fully load (3-5 seconds)
7. Click **Stop** to end recording

### Reading the Trace for CLS

1. In the trace timeline, look for **red/orange diamonds** labeled "Layout Shift" in the Experience lane
2. Click on a Layout Shift diamond — the **Summary** panel shows:
   - **Score**: the CLS value for that shift (e.g., 0.59)
   - **Cumulative Score**: running total
   - **Elements affected**: the DOM node that moved (e.g., `DIV#ra-verified-seal`)
3. Click the element name to jump to it in the Elements panel
4. Look at **what happened just before** the shift in the timeline: did a script load? a stylesheet? a font?

### Reading the Trace for Flash-of-White

1. Enable **Screenshots** in the recording
2. In the filmstrip at the top, look for white/blank frames between painted frames
3. Hover over the white frame — note the timestamp
4. At that timestamp in the Main thread, look for:
   - **React reconciliation** work (`performConcurrentWorkOnRoot`)
   - **Suspense fallback** activation (the `React.lazy` path)
   - **Hydration** warnings (logged to console at same time)

### Reading the Trace for Slow Navigation

1. Record during a SPA navigation (click a product card)
2. Look at the **Network** waterfall — find the server function call (e.g., `loadCmsPage`)
3. Check the duration — if it's > 1s, the loader is the bottleneck
4. Look at **Main thread** for long tasks blocking the UI after data arrives

### Exporting and Sharing Traces

1. After recording, click the **down arrow** (Export) in the Performance panel
2. Save as `.json` file — this is the full trace with all timing data
3. Share with teammates — they can **Import** it into their DevTools
4. The trace file also works with tools like [Perfetto UI](https://ui.perfetto.dev/)

### Quick CLS Diagnosis Shortcut

Instead of a full trace, use the **Lighthouse** panel:
1. DevTools → **Lighthouse** → check only **Performance**
2. Run on the specific page
3. Scroll to **Diagnostics** → **Avoid large layout shifts**
4. It lists the exact elements and their shift contributions

Or use the browser console:

```javascript
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.hadRecentInput) continue;
    console.log("CLS:", entry.value.toFixed(4), entry.sources?.map(s =>
      s.node?.nodeName + "#" + s.node?.id + "." + s.node?.className
    ));
  }
}).observe({ type: "layout-shift", buffered: true });
```

This logs each layout shift with the element that moved — useful for quick identification without a full trace.

### Real Example: Diagnosing Raichu CLS

From an actual trace on espacosmart:
1. Trace showed Layout Shift score **0.59** at 1.2s mark
2. Affected element: `DIV#ra-verified-seal` in the Footer
3. Just before the shift: Network showed `raichu-beta/ra-verified/bundle.js` loading
4. The script injected CSS that resized the seal container from 0 to ~60px
5. **Fix**: Converted inline `<script>` to deferred React component with `minHeight: 60` container

## 9. `suppressHydrationWarning` for Dynamic Content

### Problem

Components that render dynamic content (counters, totals, timestamps, state-dependent lists) will always differ between server and client. React throws a hydration mismatch error for every element in the subtree.

### Fix — Target `suppressHydrationWarning` at the right level

Add `suppressHydrationWarning` to the **specific element** whose content changes, not the whole tree:

```tsx
// BAD — suppresses warnings for the entire component
<div suppressHydrationWarning>
  <header>...</header>
  <ul>
    {items.map(item => <li key={item.id}>{item.label}</li>)}
  </ul>
</div>

// GOOD — only on the element that actually differs
<ul suppressHydrationWarning>
  {items.map((item, i) => (
    <li key={item.id} suppressHydrationWarning>
      {item.label}
    </li>
  ))}
</ul>
```

### Common Cases

| Component | What changes | Where to add |
|-----------|-------------|--------------|
| Cart icon badge | item count | `<span>` showing count |
| User greeting | username from cookie | `<span>` with name |
| Wishlist button | favorite state | `<button>` or wrapper `<li>` |
| `UserInteractions` | wishlist/cart state per product | `<ul>` + `<li>` |

---

## 10. Missing `key` Props in Lists

### Problem

React warns `Each child in a list should have a unique "key" prop` when mapping arrays to JSX without a stable key. This causes:
- Console warnings during development
- Unexpected DOM reuse leading to visual glitches

### Fix — Always add `key` to mapped elements

```tsx
// BAD
{products.map(product => <ProductCard {...product} />)}

// GOOD — prefer stable IDs over index
{products.map(product => (
  <ProductCard key={product.productID} {...product} />
))}

// When stable ID unavailable — index is acceptable for static lists
{items.map((item, index) => (
  <li key={index}>{item.label}</li>
))}
```

### `Encountered two children with the same key`

Happens when the key source has duplicates (e.g., two products with `inProductGroupWithID` pointing to the same group). Use a combination:

```tsx
key={`${product.productID ?? ""}-${index}`}
```

### Common Affected Components in Deco Storefronts

| Component | Fix |
|-----------|-----|
| `BannerCarousel` dots/images | `key={index}` on each dot/image |
| `ProductShelf` product cards | `key={product.productID ?? index}` |
| `ImageGallery` images | `key={index}` |
| `SuccessFulHouse` items | `key={index}` |
| `InfoEnvironment` items | `key={item.id ?? index}` |
| `Slide01/02` big banners | `key={index}` |

---

## 11. Invalid HTML Nesting (`<a>` inside `<a>`)

### Problem

Nesting an `<a>` tag inside another `<a>` is invalid HTML. React and browsers both warn, and behavior is unpredictable (inner link may be ignored or outer link may break):

```
Warning: validateDOMNesting: <a> cannot appear as a descendant of <a>.
```

### Common Pattern

A "See more" link component is used inside a card that is itself a link:

```tsx
// BAD — SeeMoreLink renders <a>, but it's inside a <Link> (which renders <a>)
<Link to={product.url}>
  <img ... />
  <SeeMoreLink href={product.url} /> {/* renders <a> — invalid! */}
</Link>
```

### Fix — `insideLink` prop to switch to `<span>`

Add an `insideLink` prop to the child component to render a non-anchor element when it's already inside a link:

```tsx
// SeeMoreLink.tsx
interface Props {
  href: string;
  label?: string;
  insideLink?: boolean;
}

export function SeeMoreLink({ href, label = "Ver mais", insideLink }: Props) {
  if (insideLink) {
    // Already inside an <a> — use span to avoid invalid nesting
    return <span className="see-more-link">{label}</span>;
  }
  return (
    <a href={href} className="see-more-link">
      {label}
    </a>
  );
}

// Usage inside a card link:
<Link to={product.url}>
  <img ... />
  <SeeMoreLink href={product.url} insideLink /> {/* safe */}
</Link>
```

### Discovery Command

```bash
rg '<a[^>]*>.*<a' src/ --glob '*.{tsx,ts}' -l
rg 'SeeMoreLink|VerMais' src/ --glob '*.{tsx,ts}'
```

---

## 12. Diagnostic Checklist

When investigating hydration/flash issues on a Deco TanStack storefront:

1. **Record a Performance trace** (see section 8) — look for Layout Shift diamonds and white screenshot frames
2. **Open DevTools Console** — look for hydration mismatch errors (they tell you exactly which element differs)
3. **Check `__DECO_STATE`** — compare server vs client values for `site.name`; if different, fix env var injection
4. **Use the CLS console observer** (code above) — quickly identifies which elements shift without a full trace
5. **Disable browser extensions** — some extensions inject DOM that causes hydration mismatches
6. **Check for inline `<script>` tags in JSX** — these often load external CSS/JS that causes shifts; convert to deferred React components
7. **Verify sync registry** — ensure all above-the-fold sections are in `registerSectionsSync`
8. **Test with F5 (hard reload)** — SPA navigation may hide issues that appear on cold load
9. **Check scroll behavior** — navigate from shelf to PDP; verify page scrolls to top
10. **Compare SSR HTML vs client render** — view source (`Ctrl+U`) and compare with inspected DOM to find hydration diffs
