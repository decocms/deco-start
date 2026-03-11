# Hooks and Components

Server-side hooks and shared components provided by the Deco framework.

## Hooks (`hooks/`)

### useSection (`useSection.ts`)

Generates a URL for partial section rendering via `/deco/render`.

```typescript
function useSection<TProps>(options: {
  props?: Partial<TProps>;   // new props for the section
  href?: string;             // target URL
}): string  // returns URL to POST for partial render
```

Used in section components to create interactive behavior without client-side JS:

```tsx
function ProductShelf({ products, page = 0 }: Props) {
  const nextPageUrl = useSection({ props: { page: page + 1 } });

  return (
    <div>
      {products.map(p => <ProductCard product={p} />)}
      <button hx-get={nextPageUrl} hx-target="closest section">
        Load more
      </button>
    </div>
  );
}
```

Internals:
- Serializes `props`, `href`, `pathTemplate`, `resolveChain` into the URL
- Strips tracking query params (BLOCKED_QS: utm_*, gclid, fbclid, etc.)
- Supports `__cb` callback parameter

### usePartialSection (`usePartialSection.ts`)

Fresh-specific: returns attributes for Fresh `<Partial>` navigation.

```typescript
function usePartialSection<TProps>(options: {
  props?: Partial<TProps>;
  href?: string;
}): { "f-client-nav": true; "f-partial": string }
```

Usage:
```tsx
<button {...usePartialSection({ props: { page: 2 } })}>
  Next Page
</button>
```

### useScript (`useScript.ts`)

Minifies a function and returns it as a script string or data URI.

```typescript
// Returns minified script string
function useScript<Args>(fn: (...args: Args) => void, ...args: Args): string;

// Returns data:text/javascript,... URI
function useScriptAsDataURI<Args>(fn: (...args: Args) => void, ...args: Args): string;
```

Usage:
```tsx
<script dangerouslySetInnerHTML={{
  __html: useScript((count) => {
    document.getElementById("counter").textContent = String(count);
  }, initialCount)
}} />
```

Uses Terser for minification.

### useDevice (`useDevice.ts`)

Returns the current device type from the server context.

```typescript
function useDevice(): "desktop" | "mobile" | "tablet";
```

Detection is done server-side via User-Agent header using `userAgent.ts`.

### useSetEarlyHints (`useSetEarlyHints.ts`)

Adds `Link` headers for HTTP 103 Early Hints (preload/preconnect).

```typescript
function useSetEarlyHints(links: Array<{
  href: string;
  as?: string;
  rel?: string;
}>): void;
```

## Components (`components/`)

### Section (`section.tsx`)

Core section rendering infrastructure:

| Export | Purpose |
|--------|---------|
| `withSection(Component)` | HOC wrapping component with context + error boundary |
| `SectionContext` | Preact context providing section ID, resolve chain |
| `getSectionID(resolveChain)` | Extracts unique section ID from resolve chain |
| `ErrorBoundary` | Catches render errors, shows fallback UI |
| `Framework` | Framework-agnostic section wrapper |

### StubSection (`StubSection.tsx`)

Placeholder for dangling references (when a section's module is not found):

```tsx
function StubSection({ component }: { component: string }) {
  return <div>Section not found: {component}</div>;
}
```

Used as `defaultDanglingRecover` for section blocks.

### PreviewNotAvailable (`PreviewNotAvailable.tsx`)

Shown in admin when a block doesn't have a preview implementation.

### LiveControls (`LiveControls.tsx`)

Injected into every page in edit mode. Provides:

- `__DECO_STATE` global with decofile state
- `DomInspector` for element selection
- Keyboard shortcuts (`Ctrl+Shift+E` for editor)
- `postMessage` bridge to admin iframe
- Script loads from `decoAssistantUrl`

### JsonViewer (`JsonViewer.tsx`)

Renders JSON data using jQuery JSONView. Used in admin previews for loaders/actions.

## Exports Map (`hooks/mod.ts`)

All hooks are re-exported from `@deco/deco/hooks`:

```typescript
export { useSection } from "./useSection.ts";
export { usePartialSection } from "./usePartialSection.ts";
export { useScript, useScriptAsDataURI } from "./useScript.ts";
export { useDevice } from "./useDevice.ts";
export { useSetEarlyHints } from "./useSetEarlyHints.ts";
```
