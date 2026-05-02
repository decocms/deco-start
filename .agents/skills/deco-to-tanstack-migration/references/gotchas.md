# Gotchas Index

This file is an index. Each topic has its own focused file.

| File | Topic | Key Gotchas |
|------|-------|-------------|
| [react-hooks-patterns.md](react-hooks-patterns.md) | useEffect, useQuery, useMemo, lazy init | #2, #33, #46, #47 |
| [react-signals-state.md](react-signals-state.md) | TanStack Store, signal.value, subscribe() | #3, #19, #38 |
| [jsx-migration.md](jsx-migration.md) | Preact→React JSX differences | #4–6, #11, #20–22, #41 |
| [vtex-commerce.md](vtex-commerce.md) | VTEX loaders, cart, facets, price specs | #1, #7–8, #32, #34–36, #39 |
| [worker-cloudflare.md](worker-cloudflare.md) | Worker entry, build, Cloudflare, npm | #9–10, #12–14, #19, #24–28, #30, #44–45 |
| [css-styling.md](css-styling.md) | Tailwind v4, oklch, DaisyUI, custom palettes | #15, #17, #31, #37, #40, #42–43, #48–49 |
| [admin-cms.md](admin-cms.md) | Admin routes, schema, device context | #16, #18, #23, #26, #29 |
| [vtex-commerce.md](vtex-commerce.md) | Section loader composition (`withSectionLoader`) | #50 |

## #50 Quick Reference — Section Loader Composition

When wiring `registerSectionLoaders`, mixins (`withDevice`, `withMobile`,
`withSearchParam`) MUST be composed with the section's own `loader`
export — never replace it. The framework calls the registered entry as
THE section loader; if you register only mixins, the section's
`loader.ts` work silently never runs and the section renders empty
(or worse, downstream components crash on the missing data).

**Use `withSectionLoader` from `@decocms/start/cms` (≥ 2.28):**

```typescript
import { compose, withDevice, withSearchParam, withSectionLoader } from "@decocms/start/cms";

registerSectionLoaders({
  "site/sections/Header/Header.tsx": compose(
    withDevice(),
    withSearchParam(),
    withSectionLoader(() => import("~/sections/Header/Header")),
  ),
});
```

`withSectionLoader` MUST be last — it sees the mixin-enriched props and
returns the merged result. The `@decocms/start@2.28+` migrator emits
this layout automatically; sites migrated with older versions need a
manual rewire (16 sections in als-tanstack — symptom was empty pages
and `Cannot read properties of undefined` cascades). Full pattern in
[vtex-commerce.md](vtex-commerce.md).
