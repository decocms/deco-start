# JSX Migration — Preact → React Differences

> class→className, htmlFor, SVG attrs, createPortal, ComponentChildren, fresh attrs.


## 4. class vs className

Preact accepts both. React only accepts `className`.

**Fix**: `grep -rn ' class=' src/ --include='*.tsx'` and replace in JSX contexts.


## 5. dangerouslySetInnerHTML Syntax

Some Deco components use `innerHTML` directly.

**Fix**: `dangerouslySetInnerHTML={{ __html: content }}`.


## 6. ComponentChildren → ReactNode

Not just a type rename. Usually fine in practice.


## 11. SVG Attributes

React uses camelCase: `strokeWidth`, `fillRule`, `clipPath`, etc.


## 20. createPortal Imported from Wrong Module

In Preact, `createPortal` is available from `preact/compat` which maps to `react` in some setups. In React, `createPortal` lives in `react-dom`.

**Symptom**: `createPortal is not a function` or components using portals (modals, drawers, toasts) silently fail.

**Fix**:
```bash
# Find and replace across all files
grep -r 'createPortal.*from "react"' src/ --include='*.tsx' -l
# Change to: import { createPortal } from "react-dom";
```


## 21. for Attribute Must Be htmlFor in React JSX

Preact accepts both `for` and `htmlFor` on `<label>` elements. React only accepts `htmlFor`. Using `for` causes a hydration mismatch because the server renders `for` but the client expects `htmlFor`.

**Symptom**: React #419 hydration errors on pages with labels (search bars, forms, drawers).

**Fix**: `grep -r ' for={' src/ --include='*.tsx'` and replace with `htmlFor={`.


## 22. Fresh-Specific Attributes Must Be Removed

Fresh/Preact components may use `data-fresh-disable-lock={true}` on elements. This attribute has no meaning in React and can cause hydration mismatches.

**Fix**: Remove all `data-fresh-disable-lock` attributes.


## 41. Component Props `class` vs `className` Causes Silent Failures

**Severity**: HIGH — specific component features silently disappear

Gotcha #4 covers JSX attributes (`class=` on HTML elements), but this is about **component props** that are destructured as `class`. Preact components often destructure `{ class: _class }` from props because Preact accepts both `class` and `className`. In React, only `className` is passed, so `_class` ends up as `undefined`.

**Symptom**: The Drawer component's `className="drawer-end"` never reaches the rendered div. CartDrawer renders without `drawer-end`, making it overlay the wrong side or not render at all.

**Fix**: In component interfaces, accept both and merge:

```typescript
// Before (Preact-style):
function Drawer({ class: _class, ...rest }) {
  return <div className={`drawer ${_class}`}>

// After (React-compatible):
function Drawer({ className, ...rest }) {
  return <div className={`drawer ${className ?? ""}`}>
```

Search for `class:` in component destructuring patterns across all files, not just in JSX attributes.
