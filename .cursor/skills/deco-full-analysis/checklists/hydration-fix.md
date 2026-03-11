# Hydration Fix Checklist

9 learnings from real Deco sites. Check these during analysis.

## SDK & Script Race Conditions

### 1. SDK Initialization Guard
**Check**: Do components assume SDK is ready?

```typescript
// Bad: Race condition
const { cart } = useCart(); // May be undefined

// Good: Wait for SDK
async function waitForSDK() {
  while (!window.__STOREFRONT_SDK__) {
    await new Promise(r => setTimeout(r, 50));
  }
  return window.__STOREFRONT_SDK__;
}

const sdk = await waitForSDK();
const cart = sdk.cart;
```

### 2. Script Dependency Synchronization
**Check**: Do components wait for external scripts?

```typescript
// Good: Wait for HTMX
function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (check()) return resolve();
    const start = Date.now();
    const interval = setInterval(() => {
      if (check()) { clearInterval(interval); resolve(); }
      if (Date.now() - start > timeout) { clearInterval(interval); reject(); }
    }, 50);
  });
}

await waitFor(() => window.htmx !== undefined);
```

### 3. Safe Browser API Access
**Check**: Are `window`/`document` accessed during SSR?

```typescript
// Bad: Crashes on SSR
const width = window.innerWidth;

// Good: Check for browser
import { IS_BROWSER } from "$fresh/runtime.ts";

const width = IS_BROWSER ? window.innerWidth : 1024;
```

## Unique IDs

### 4. Deterministic useId
**Check**: Are there hydration mismatches with IDs?

```typescript
// Bad: Random IDs cause mismatch
const id = Math.random().toString(36);

// Good: Deterministic based on props
function useStableId(prefix: string, index: number) {
  return `${prefix}-${index}`;
}
```

Or use a custom deterministic ID generator if `useId()` causes issues.

## External Widgets

### 5. Onload Script Guard
**Check**: Are external widgets manipulated before load?

```typescript
// Bad: Widget may not exist
document.querySelector('.hubspot-form').style.display = 'block';

// Good: Wait for load
script.onload = () => {
  const widget = document.querySelector('.hubspot-form');
  if (widget) widget.style.display = 'block';
};
```

### 6. MutationObserver for Third-Party Widgets
**Check**: Do third-party widgets need conditional styling?

```typescript
// Good: Watch for widget insertion
const observer = new MutationObserver((mutations) => {
  const widget = document.querySelector('.review-widget');
  if (widget) {
    widget.classList.add('loaded');
    observer.disconnect();
  }
});

observer.observe(document.body, { childList: true, subtree: true });
```

## HTML Content

### 7. HTML Repair Utility
**Check**: Is `dangerouslySetInnerHTML` used with external content?

```typescript
// Bad: Broken HTML causes hydration errors
<div dangerouslySetInnerHTML={{ __html: product.description }} />

// Good: Sanitize and repair
import DOMPurify from "dompurify";

function repairHtml(html: string): string {
  // Close unclosed tags, fix nesting
  const doc = new DOMParser().parseFromString(html, "text/html");
  return DOMPurify.sanitize(doc.body.innerHTML);
}

<div dangerouslySetInnerHTML={{ __html: repairHtml(product.description) }} />
```

## Lazy Loading

### 8. Deferred Portal Rendering
**Check**: Are heavy drawers rendered on mount?

```typescript
// Good: Lazy render minicart/menu
import { createPortal } from "preact/compat";

function Minicart() {
  const [show, setShow] = useState(false);
  
  return (
    <>
      <button onClick={() => setShow(true)}>Cart</button>
      {show && createPortal(<MinicartContent />, document.body)}
    </>
  );
}
```

### 9. Interaction-based Lazy Hydration
**Check**: Are heavy navigation menus loaded eagerly?

```typescript
// Good: Load drawer content on first interaction
function Header() {
  const [menuLoaded, setMenuLoaded] = useState(false);
  
  return (
    <button 
      onMouseEnter={() => setMenuLoaded(true)}
      onClick={() => setMenuLoaded(true)}
    >
      Menu
    </button>
    {menuLoaded && <MegaMenu />}
  );
}
```

## Quick Audit Commands

```bash
# Find direct window/document access
grep -rn "window\." islands/ | grep -v "IS_BROWSER"
grep -rn "document\." islands/ | grep -v "IS_BROWSER"

# Find dangerouslySetInnerHTML usage
grep -r "dangerouslySetInnerHTML" sections/ islands/

# Find Math.random in components (ID generation)
grep -r "Math.random" sections/ islands/ components/
```

## Common Hydration Issues

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| "Text content mismatch" | Date/time formatting | Use consistent timezone |
| "Expected server HTML" | `useDevice()` for layout | Use CSS media queries |
| "Hydration failed" | Random IDs | Use deterministic IDs |
| White flash | Script race condition | Add SDK initialization guard |
| Missing styles | CSS-in-JS during SSR | Use Tailwind or static CSS |
