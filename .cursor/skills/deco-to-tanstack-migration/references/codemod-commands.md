# Codemod Commands

All automation commands organized by phase. Run from project root.

## Phase 1 — Imports & JSX

### Preact → React (safe for bulk)

```bash
find src/ -name '*.ts' -o -name '*.tsx' | xargs sed -i '' \
  -e 's|from "preact/hooks"|from "react"|g' \
  -e 's|from "preact/compat"|from "react"|g' \
  -e 's|from "preact"|from "react"|g'
```

### ComponentChildren → ReactNode

```bash
find src/ -name '*.ts' -o -name '*.tsx' | xargs sed -i '' \
  -e 's/ComponentChildren/ReactNode/g'
```

### SVG attributes (safe for bulk)

```bash
find src/ -name '*.tsx' | xargs sed -i '' \
  -e 's/stroke-width=/strokeWidth=/g' \
  -e 's/stroke-linecap=/strokeLinecap=/g' \
  -e 's/stroke-linejoin=/strokeLinejoin=/g' \
  -e 's/fill-rule=/fillRule=/g' \
  -e 's/clip-rule=/clipRule=/g' \
  -e 's/clip-path=/clipPath=/g' \
  -e 's/stroke-dasharray=/strokeDasharray=/g' \
  -e 's/stroke-dashoffset=/strokeDashoffset=/g'
```

### HTML attributes

```bash
find src/ -name '*.tsx' | xargs sed -i '' \
  -e 's/ for=/ htmlFor=/g' \
  -e 's/ fetchpriority=/ fetchPriority=/g' \
  -e 's/ autocomplete=/ autoComplete=/g'
```

### Remove JSX pragmas

```bash
find src/ -name '*.tsx' -o -name '*.ts' | xargs sed -i '' \
  -e '/\/\*\* @jsxRuntime automatic \*\//d' \
  -e '/\/\*\* @jsx h \*\//d' \
  -e '/\/\*\* @jsxFrag Fragment \*\//d'
```

## Phase 2 — Signals

### Module-level signal imports (safe for bulk)

```bash
find src/ -name '*.ts' -o -name '*.tsx' | xargs sed -i '' \
  's|from "@preact/signals"|from "@decocms/start/sdk/signal"|g'
```

### Audit useSignal usage (manual conversion needed)

```bash
grep -rn 'useSignal\|useComputed' src/ --include='*.tsx' --include='*.ts'
```

## Phase 3 — Deco Framework

### Remove $fresh imports

```bash
find src/ -name '*.ts' -o -name '*.tsx' | xargs sed -i '' \
  -e 's|import { asset } from "\$fresh/runtime.ts";||g' \
  -e 's|asset(\([^)]*\))|\1|g'
```

### Replace site-local import aliases

```bash
# Replace with your actual site name:
SITE_NAME="osklenbr"

find src/ -name '*.ts' -o -name '*.tsx' | xargs sed -i '' \
  -e "s|from \"\\\$store/|from \"~/|g" \
  -e "s|from \"deco-sites/${SITE_NAME}/|from \"~/|g" \
  -e "s|from \"site/|from \"~/|g"
```

### IS_BROWSER replacement

```bash
find src/ -name '*.ts' -o -name '*.tsx' | xargs sed -i '' \
  -e 's|import { IS_BROWSER } from "\$fresh/runtime.ts";||g' \
  -e 's|IS_BROWSER|typeof window !== "undefined"|g'
```

## Phase 4 — Commerce

```bash
find src/ -name '*.ts' -o -name '*.tsx' | xargs sed -i '' \
  -e 's|from "apps/commerce/types.ts"|from "@decocms/apps/commerce/types"|g' \
  -e 's|from "apps/admin/widgets.ts"|from "~/types/widgets"|g' \
  -e 's|from "apps/website/components/Image.tsx"|from "~/components/ui/Image"|g' \
  -e 's|from "apps/website/components/Picture.tsx"|from "~/components/ui/Picture"|g' \
  -e 's|from "apps/website/components/Video.tsx"|from "~/components/ui/Video"|g'
```

### SDK utilities

```bash
find src/ -name '*.ts' -o -name '*.tsx' | xargs sed -i '' \
  -e 's|from "~/sdk/useOffer.ts"|from "@decocms/apps/commerce/sdk/useOffer"|g' \
  -e 's|from "~/sdk/useOffer"|from "@decocms/apps/commerce/sdk/useOffer"|g' \
  -e 's|from "~/sdk/format.ts"|from "@decocms/apps/commerce/sdk/formatPrice"|g'
```

## Phase 6 — Islands

### Audit island types

```bash
echo "=== Wrapper islands (re-export from components) ==="
grep -rl 'export.*from.*components' src/islands/ --include='*.tsx' 2>/dev/null

echo ""
echo "=== Standalone islands (have real logic) ==="
find src/islands/ -name '*.tsx' ! -exec grep -l 'export.*from.*components' {} \; 2>/dev/null
```

### Repoint imports from islands/ to components/

```bash
find src/ -name '*.ts' -o -name '*.tsx' | xargs sed -i '' \
  's|from "~/islands/|from "~/components/|g'
```

## Verification Commands

```bash
# Zero old imports (run after all phases):
echo "Preact: $(grep -r 'from "preact' src/ --include='*.tsx' --include='*.ts' | wc -l)"
echo "Signals: $(grep -r '@preact/signals' src/ --include='*.tsx' --include='*.ts' | wc -l)"
echo "@deco/deco: $(grep -r '@deco/deco' src/ --include='*.tsx' --include='*.ts' | wc -l)"
echo "\$fresh: $(grep -r '\$fresh' src/ --include='*.tsx' --include='*.ts' | wc -l)"
echo "apps/: $(grep -r 'from \"apps/' src/ --include='*.tsx' --include='*.ts' | wc -l)"
echo "islands/: $(grep -r 'from \"~/islands/' src/ --include='*.tsx' --include='*.ts' | wc -l)"
```

## Pre-Flight Audit Script

Run against the source site before starting migration:

```bash
echo "=== Source Site Audit ==="
echo "Components: $(find components/ sections/ -name '*.tsx' 2>/dev/null | wc -l)"
echo "Islands: $(find islands/ -name '*.tsx' 2>/dev/null | wc -l)"
echo "Sections: $(find sections/ -name '*.tsx' 2>/dev/null | wc -l)"
echo "Loaders: $(find loaders/ -name '*.ts' -o -name '*.tsx' 2>/dev/null | wc -l)"
echo ""
echo "=== Import Dependencies ==="
echo "Preact: $(grep -rl 'from "preact' . --include='*.tsx' --include='*.ts' 2>/dev/null | wc -l) files"
echo "Signals: $(grep -rl '@preact/signals' . --include='*.tsx' --include='*.ts' 2>/dev/null | wc -l) files"
echo "@deco/deco: $(grep -rl '@deco/deco' . --include='*.tsx' --include='*.ts' 2>/dev/null | wc -l) files"
echo "\$fresh: $(grep -rl '\$fresh/' . --include='*.tsx' --include='*.ts' 2>/dev/null | wc -l) files"
echo "apps/: $(grep -rl 'from \"apps/' . --include='*.tsx' --include='*.ts' 2>/dev/null | wc -l) files"
echo "useSignal: $(grep -r 'useSignal' . --include='*.tsx' --include='*.ts' -c 2>/dev/null | awk -F: '{sum+=$2} END{print sum}')"
echo ""
echo "=== CMS Blocks ==="
echo "Total: $(find .deco/blocks/ -name '*.json' 2>/dev/null | wc -l)"
echo "Pages: $(find .deco/blocks/ -name 'pages-*.json' 2>/dev/null | wc -l)"
```
