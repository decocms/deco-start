# Preact -> React Import Migration

Mechanical find-and-replace. Safe to automate with `sed`.

## Replacements

| Find | Replace |
|------|---------|
| `from "preact/hooks"` | `from "react"` |
| `from "preact/compat"` | `from "react"` |
| `from "preact"` | `from "react"` |

## Special Cases

### ComponentChildren -> ReactNode

Preact's `ComponentChildren` maps to React's `ReactNode`:

```typescript
// OLD
import type { ComponentChildren } from "preact";

// NEW
import type { ReactNode as ComponentChildren } from "react";
```

If you want to modernize fully, rename `ComponentChildren` to `ReactNode` across the codebase.

### JSX type

```typescript
// OLD
import type { JSX } from "preact";

// NEW (works unchanged)
import type { JSX } from "react";
```

### FunctionalComponent -> FC

```typescript
// OLD
const Foo: preact.FunctionalComponent<Props> = ...

// NEW
import React from "react";
const Foo: React.FC<Props> = ...
```

## Automation

```bash
# Bulk replace (macOS sed)
find src/ -name '*.ts' -o -name '*.tsx' | xargs sed -i '' \
  -e 's|from "preact/hooks"|from "react"|g' \
  -e 's|from "preact/compat"|from "react"|g'

# Bare preact requires care (don't match preact/hooks or preact/compat)
find src/ -name '*.ts' -o -name '*.tsx' | xargs sed -i '' \
  's|from "preact"|from "react"|g'
```

Then handle `ComponentChildren` files individually.

## Verification

```bash
grep -r 'from "preact' src/ --include='*.ts' --include='*.tsx'
# Should return ZERO matches
```
