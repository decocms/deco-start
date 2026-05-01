# HTMX → React Rewrite Recipes

Some Deco storefronts on the Fresh stack picked up htmx as their
interactivity model — `hx-get`, `hx-post`, `hx-target`, `hx-swap`,
`hx-on:click`, etc. The TanStack Start / React stack does **not**
ship an htmx runtime, and per **D2** in the
[migration tooling policy](https://github.com/decocms/deco-start/blob/main/.cursor/rules/migration-tooling-policy.mdc)
we don't add one — every `hx-*` attribute gets rewritten to a React
equivalent on migration. There is no half-measure adapter package.

This reference is the per-pattern playbook the engineer (and the
Wave 14 codemods) follow.

## Inventory the surface first

Before rewriting anything, run the analyzer (added in
`@decocms/start >= 2.20.0`):

```bash
# From the SOURCE site directory (Fresh repo, before migration).
npx -p @decocms/start deco-htmx-analyze --top 20

# Or after migration to verify there's nothing left:
cd /path/to/migrated-site
npx -p @decocms/start deco-htmx-analyze --json | jq '.totalOccurrences'
```

The analyzer groups every `hx-*` element into one of seven
**categories**, ordered roughly by rewrite difficulty:

| Category | Cluster | Difficulty |
|---|---|---|
| `event-handler` | `hx-on:*` / `hx-on-*`, no fetch attr | trivial — direct `onClick` |
| `boost` | `hx-boost="true"` | trivial — `<Link>` |
| `click-swap` | fetch + `hx-target` on a button-like element | medium — state + conditional render |
| `form-swap` | fetch on `<form>` with target/swap | medium — `useMutation` |
| `auto-fetch` | fetch on input or `hx-trigger=keyup\|intersect` | medium — debounced state + `useQuery` |
| `oob-swap` | `hx-swap-oob` / `hx-select-oob` | hard — manual, no 1:1 |
| `unmatched` | doesn't fit a known cluster | manual — read the call site |

**Order of attack**: walk the list top-down. Most sites' surface is
~40 % event-handler, ~30 % click-swap, ~10 % each form-swap and
auto-fetch, ~5 % each oob-swap and unmatched. Knock out the trivial
ones first — they're often the easiest wins and clear the noise.

## Two syntactic flavours of `hx-on`

htmx 2.x supports both colon and dash forms of event handler attrs.
HTML's spec doesn't allow `:` in attribute names, so the dash is
canonical:

```tsx
<button hx-on:click={useScript(...)} />     // colon (older Fresh fixtures)
<button hx-on-click={useScript(...)} />     // dash  (htmx 2.x canonical)
<div    hx-on-htmx-after-request={...} />   // htmx event with prefix
```

Both rewrite to the same React `onClick` / `onChange` etc.

## Pattern 1 — `event-handler`

The biggest bucket. Almost always a `useScript`-wrapped function
attached as an event handler, with no fetch involved.

> **Codemod available** (since `@decocms/start >= 2.21.0`). The
> migration script's `transforms` pipeline now runs
> `htmx-on-event-rename`, which mechanically rewrites
> `hx-on:click={…}` → `onClick={…}` (and every other standard DOM
> event in the [STANDARD_EVENT_MAP](https://github.com/decocms/deco-start/blob/main/scripts/migrate/transforms/htmx-on-events.ts)
> table) for both colon and dash variants. Handler bodies are
> preserved verbatim; if the body references Fresh-only globals
> (`useScript(…)`, `globalThis.window.STOREFRONT`, `STOREFRONT.…`),
> the codemod injects a single MIGRATION TODO comment at the top
> of the file pointing back here. **htmx lifecycle events**
> (`hx-on:htmx-config-request`, `hx-on-htmx-before-request`, etc.)
> and unknown custom events (`hx-on:my-custom-thing`) are left
> alone — those need manual rewrite, and the `htmx-residue` audit
> rule catches them.
>
> Smoke result on als-storefront (754 files): codemod renames 98
> `hx-on:*` attributes across 71 files; 67 of those files (94 %)
> get the body-TODO. Engineers still own the body rewrite below;
> the codemod just removes the dead `hx-*` attribute name so the
> file compiles in React.

### Before

```tsx
<button
  hx-on:click={useScript(
    async (skuId: string, sellerId: string) => {
      if (!skuId || !sellerId) return;
      const button = this as HTMLButtonElement;
      button.dataset.loading = "true";
      await globalThis.window.STOREFRONT.CART.addToCart({
        orderItems: [{ id: skuId, quantity: 1, seller: sellerId }],
      });
      button.dataset.loading = "false";
    },
    productSku,
    sellerId ?? "1",
  )}
>
  Add to bag
</button>
```

### After

```tsx
import { useState } from "react";
import { useCart } from "~/hooks/useCart";

export default function AddToBagButton({ productSku, sellerId }) {
  const { addItems } = useCart();
  const [loading, setLoading] = useState(false);

  return (
    <button
      data-loading={loading}
      onClick={async () => {
        if (!productSku || !sellerId) return;
        setLoading(true);
        try {
          await addItems({
            orderItems: [{ id: productSku, quantity: 1, seller: sellerId ?? "1" }],
          });
        } finally {
          setLoading(false);
        }
      }}
    >
      Add to bag
    </button>
  );
}
```

### Gotchas

- `globalThis.window.STOREFRONT.CART.*` → the platform hook
  (`useCart` from `~/hooks/useCart`, which delegates to `createUseCart`
  from `@decocms/apps/vtex/hooks/createUseCart`). Do not reach for
  globals.
- `this as HTMLButtonElement` → use a `useRef`, or read from the
  React event (`(e) => e.currentTarget`).
- `button.dataset.loading = "true"` direct DOM mutation breaks
  hydration on F5 and React Compiler optimisations. Use state.
- The `useScript` import (`@deco/deco/hooks` or
  `@decocms/start/sdk/useScript`) becomes unused — remove it.

## Pattern 2 — `boost`

Trivial. `hx-boost` enabled SPA-style navigation on regular `<a>`
elements. TanStack Router's `<Link>` does this by default.

### Before

```tsx
<a hx-boost="true" href="/produto/foo">Foo</a>
```

### After

```tsx
import { Link } from "@tanstack/react-router";

<Link to="/produto/$slug" params={{ slug: "foo" }}>Foo</Link>;
```

### Gotchas

- For unparameterised links, `<Link to="/produto/foo">` works without
  `params`.
- `<a>` tags that aren't `hx-boost`-ed should also become `<Link>`
  if they target a route in the app — but that's covered by
  `references/navigation.md`, not by this skill.

## Pattern 3 — `click-swap`

The dominant button-driven shape: a button with `hx-get` (or
`hx-post`) + `hx-target` + `hx-swap` that fetches a server-rendered
section and swaps it into a target element.

### Before

```tsx
<button
  type="button"
  hx-target={`#${VIEW_CONTENT_ID}`}
  hx-swap="innerHTML transition:true"
  hx-trigger="click"
  hx-get={useSection({
    props: {
      viewConfig: {
        view: viewIds.RECEIVE_ACCESS_CODE_FOR_PASSWORD,
        currentEmail: props?.currentEmail,
      },
    },
  })}
  hx-indicator="this"
>
  Forgot password
</button>
```

### Two After options

**Option A — local state machine** (when the swap stays inside one
component tree, e.g. a multi-step login form). Each `view` becomes a
discriminator in component state, each section becomes a sub-component.

```tsx
import { useState } from "react";

type View =
  | { name: "EMAIL_PWD" }
  | { name: "RECEIVE_CODE_FOR_PWD"; currentEmail?: string }
  | { name: "FORGOTTEN_PWD" };

export function LoginFlow({ initialEmail }: { initialEmail?: string }) {
  const [view, setView] = useState<View>({ name: "EMAIL_PWD" });

  if (view.name === "EMAIL_PWD") {
    return (
      <EmailAndPassword
        currentEmail={initialEmail}
        onForgotPassword={() =>
          setView({
            name: "RECEIVE_CODE_FOR_PWD",
            currentEmail: initialEmail,
          })
        }
      />
    );
  }
  if (view.name === "RECEIVE_CODE_FOR_PWD") {
    return <ReceiveAccessCode currentEmail={view.currentEmail} />;
  }
  return <ForgottenPassword />;
}
```

The "Forgot password" button becomes:

```tsx
<button type="button" onClick={onForgotPassword}>Forgot password</button>
```

**Option B — sub-route** (when the swap should be URL-addressable,
e.g. cart, address-book pages, account sections that benefit from
deep-links).

```tsx
// routes/account/forgot-password.tsx
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/account/forgot-password")({
  component: ForgottenPasswordPage,
});
```

Button becomes:

```tsx
<Link to="/account/forgot-password">Forgot password</Link>
```

### Choose between A and B

- **B** if the new "view" is a meaningful URL (search filters, tabs,
  multi-step flows worth bookmarking, account pages).
- **A** if the swap is incidental UI state (modals, dropdowns,
  step-flows that should not survive reload).

## Pattern 4 — `form-swap`

Form posts that swap the result back into a target. Same surface as
click-swap but on a `<form>` and triggered by `submit`.

### Before

```tsx
<form
  hx-target={`#${VIEW_CONTENT_ID}`}
  hx-swap="innerHTML transition:true show:window:top"
  hx-trigger="submit"
  hx-post={useSection({
    props: {
      viewConfig: { view: viewIds.EMAIL_AND_PASSWORD },
      action: actionIds.CLASSIC_SIGN_IN,
    },
  })}
  hx-indicator=".submit"
>
  <input name="email" type="email" required />
  <input name="password" type="password" required />
  <button type="submit" data-test-id="login-submit">Sign In</button>
</form>
```

### After

```tsx
import { useMutation } from "@tanstack/react-query";
import { invoke } from "~/server/invoke";
import { useState } from "react";

export function EmailAndPassword({ onSuccess }: { onSuccess: (user: User) => void }) {
  const [error, setError] = useState<string | null>(null);

  const signIn = useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      invoke({ "vtex.actions.auth/classicSignIn": input }),
    onSuccess: (user) => onSuccess(user),
    onError: (e) => setError(e.message),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        signIn.mutate({
          email: String(data.get("email")),
          password: String(data.get("password")),
        });
      }}
    >
      <input name="email" type="email" required />
      <input name="password" type="password" required />
      <button type="submit" disabled={signIn.isPending}>
        {signIn.isPending ? "Signing in…" : "Sign In"}
      </button>
      {error && <p>{error}</p>}
    </form>
  );
}
```

### Gotchas

- `hx-post={useSection(...)}` posted to a Deco section that ran a
  server-side handler. The TanStack equivalent is **either** a
  server function (`createServerFn`) **or** an action exposed via
  `invoke` over `@decocms/apps`. Pick the one whose business logic
  already lives there.
- `hx-indicator=".submit"` → button `disabled={mutation.isPending}`
  + visible "Signing in…" text. No CSS class plumbing.
- Validation errors that the section returned via re-render: now
  surface via `mutation.onError` + state.

## Pattern 5 — `auto-fetch`

A fetch attribute fires automatically on a non-click trigger:
`keyup`, `intersect`, `revealed`, `load`, or `every:Xs`. Most often
seen on `<input>` for search-as-you-type.

### Before — search-as-you-type

```tsx
<input
  id={searchInputId}
  name="q"
  type="text"
  hx-sync="this:replace"
  hx-swap="innerHTML transition:true"
  hx-target={`#${searchResultsId}`}
  hx-post={useComponent(Suggestions, { id })}
  hx-trigger="keyup changed delay:200ms"
  class="…"
/>
<div id={searchResultsId}></div>
```

### After

```tsx
import { useState, useDeferredValue } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { invoke } from "~/server/invoke";

export function SearchInput() {
  const [term, setTerm] = useState("");
  const debouncedTerm = useDeferredValue(term);

  const suggestions = useQuery({
    queryKey: ["search-suggestions", debouncedTerm],
    queryFn: () =>
      invoke({ "vtex.loaders.intelligentSearch/suggestions": { term: debouncedTerm } }),
    enabled: debouncedTerm.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  return (
    <>
      <input
        type="text"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search"
      />
      <div>{suggestions.data?.map((s) => <SuggestionRow key={s.id} item={s} />)}</div>
    </>
  );
}
```

### Before — intersection-triggered (lazy load row)

```tsx
<div hx-trigger="intersect once" hx-get={useComponent(MoreItems)} hx-swap="outerHTML"></div>
```

### After

```tsx
import { useEffect, useRef, useState } from "react";

export function MoreItemsLoader() {
  const ref = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);

  useEffect(() => {
    if (loaded || !ref.current) return;
    const obs = new IntersectionObserver(
      async ([entry]) => {
        if (!entry.isIntersecting) return;
        obs.disconnect();
        setLoaded(true);
        setItems(await invoke({ "site.loaders/moreItems": {} }));
      },
      { rootMargin: "100px" },
    );
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [loaded]);

  if (items) return <>{items.map((i) => <Row key={i.id} item={i} />)}</>;
  return <div ref={ref} />;
}
```

### Gotchas

- `hx-sync="this:replace"` — the htmx-side concurrency control —
  becomes "useQuery dedupes identical query keys + replaces results
  on key change" automatically. No equivalent flag needed.
- `keyup changed delay:200ms` → `useDeferredValue` gives concurrent
  rendering, or fall back to a manual debounce hook if you want a
  fixed delay.
- Single-`once` triggers should set a flag on first intersection
  and disconnect the observer (see `loaded` above).

## Pattern 6 — `oob-swap`

Out-of-band swaps don't have a clean React equivalent. They were
htmx's mechanism for a server response to update **multiple
disconnected DOM nodes** in one request — e.g. update the cart
indicator in the header AND the cart drawer body from a single
"add to cart" response.

There's no codemod here. Two refactor patterns:

### Refactor A — global state
Lift the data the OOB nodes read into a shared store (`@tanstack/store`).
The mutation writes to the store; the consumers re-render naturally.
This is the right choice 90 % of the time.

### Refactor B — broadcast event
For cases where one component must trigger a side effect in another
without a shared data shape: dispatch a custom event on `window`,
listen for it in the consumer's `useEffect`. This is the htmx
`hx-swap-oob` pattern, just done with browser primitives.

```tsx
// Producer
window.dispatchEvent(new CustomEvent("cart:item-added", { detail: { itemId } }));

// Consumer
useEffect(() => {
  const handler = (e: Event) => { /* react to e.detail */ };
  window.addEventListener("cart:item-added", handler);
  return () => window.removeEventListener("cart:item-added", handler);
}, []);
```

Prefer A. Resort to B only when the producer/consumer can't share a
parent.

## Pattern 7 — `unmatched`

Cases the analyzer didn't fit cleanly. Read each call site. Common
shapes:

- `<div hx-indicator="…">` standalone — passive marker that some
  *other* element shows as a loading indicator. The other element
  is the real interactivity site; rewrite there. The `hx-indicator`
  div becomes plain JSX gated on a state boolean.
- `htmx-request:` Tailwind variants (`htmx-request:loading`,
  `[.htmx-request>&]:hidden`) — these toggle styles based on
  htmx's own request lifecycle. Replace with `data-[loading=true]:`
  variants driven by your component state.
- `hx-confirm`, `hx-prompt` — synchronous browser dialogs. Use the
  site's modal system, or `window.confirm()` if it was always a
  trivial native dialog.
- Any `hx-*` attribute on a Deco component import path
  (`<Accordion.Trigger hx-on-click={...}>`) — the component itself
  spreads attrs onto a child element. Lift the handler into a prop.

## Verification

After the rewrite, the post-cleanup audit's
**`htmx-residue`** rule (Wave 13-C) reports any remaining `hx-*` in
the migrated `src/`. A site is "rewrite-complete" when `htmx-residue
== 0` for non-test files.

```bash
npx -p @decocms/start deco-post-cleanup --strict
# exit 2 if any hx-* attributes survive in src/
```

You can also re-run the analyzer on the migrated tree to verify
zero hits:

```bash
npx -p @decocms/start deco-htmx-analyze
# expects: ✓ No hx-* attributes found.
```

## Real-world signal — als-storefront

Initial inventory across 133 source files, 210 occurrences:

| Bucket | Count | % |
|---|---:|---:|
| event-handler | 88 | 42 % |
| click-swap | 64 | 30 % |
| form-swap | 20 | 10 % |
| auto-fetch | 9 | 4 % |
| oob-swap | 8 | 4 % |
| unmatched | 21 | 10 % |

86 % of occurrences fall in codemod-able buckets (event-handler,
click-swap, form-swap, auto-fetch). Wave 14 ships codemods for those
four; the rest stay manual.
