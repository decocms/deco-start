# Site Discovery Guide

Step-by-step process to analyze a Deco site's implementation.

## Step 1: Framework & Dependencies

Read `deno.json` to understand:

```typescript
// Key things to extract:
{
  "imports": {
    "@deco/deco": "...",        // Deco version
    "@deco/dev": "...",         // Dev tools version
    "apps/": "...",             // Apps source (official or forked)
    "preact": "...",            // UI library
    "$fresh/": "..."            // Fresh framework (if present)
  },
  "tasks": {
    "dev": "...",               // How to run locally
    "start": "...",             // Production start
    "build": "..."              // Build command
  }
}
```

### Determine Stack Type

| Indicator | Stack |
|-----------|-------|
| `$fresh/` import | Fresh (SSR + Islands) |
| `@deco/deco/htmx` import | HTMX |
| `islands/` directory | Fresh (interactive) |
| `hx-*` attributes in sections | HTMX |

### Detect Platform

| Import Pattern | Platform |
|----------------|----------|
| `apps/vtex/` usage in blocks | VTEX |
| `apps/shopify/` usage | Shopify |
| `apps/wake/` usage | Wake |
| `apps/vnda/` usage | VNDA |

### Check for Unused Platform Files

Most Deco sites start from templates that include files for **all** platforms. If the site only uses one platform (e.g., VTEX), the other platform files are dead code.

```bash
# Find platform-specific files that might be unused
for platform in vtex shopify wake linx vnda nuvemshop; do
  echo "$platform: $(find . -name "*$platform*" -type f 2>/dev/null | wc -l) files"
done

# Check which platform is actually configured
grep -r "__resolveType.*apps/vtex\|apps/shopify\|apps/wake" .deco/blocks/ | head -5
```

**Common locations of unused platform files:**
- `components/header/Buttons/Cart/{platform}.tsx`
- `components/minicart/{platform}/Cart.tsx`
- `components/product/AddToCartButton/{platform}.tsx`
- `islands/AddToCartButton/{platform}.tsx`
- `islands/Header/Cart/{platform}.tsx`

**Document in AGENTS.md:**
```markdown
## Platform Cleanup Status

| Check | Status |
|-------|--------|
| Active platform | VTEX |
| Unused platform files | 25 files (shopify, wake, linx, vnda, nuvemshop) |
| Platform switching logic | Components have unnecessary conditionals |
| Recommended action | Run site-cleanup checklist |
```

See [site-cleanup.md](checklists/site-cleanup.md) for detailed cleanup steps.

---

## Step 2: Apps Configuration

Check which apps are installed by looking at:

1. **deno.json imports**: `apps/` source
2. **apps/ directory**: Local app configurations
3. **.deco/blocks/**: Which app loaders/sections are used

### Common App Patterns

```json
// .deco/blocks/site.json or apps config
{
  "__resolveType": "apps/vtex/mod.ts",
  "account": "storename",
  "platform": "vtex"
}
```

---

## Step 3: Page Blocks Analysis

List all page blocks:
```bash
ls .deco/blocks/pages-*.json
```

Key pages to identify:
| Page Type | Common Block Names |
|-----------|-------------------|
| Home | `pages-Home*`, `pages-Principal*` |
| PDP | `pages-PDP*`, `pages-Product*` |
| PLP | `pages-PLP*`, `pages-Category*` |
| Search | `pages-Search*`, `pages-Busca*` |
| Cart | `pages-Cart*`, `pages-Carrinho*` |
| Checkout | `pages-Checkout*` |
| Login | `pages-Login*`, `pages-SignIn*` |
| My Account | `pages-MyAccount*`, `pages-Account*` |

### Analyze a Page Block

```json
// .deco/blocks/pages-Home-123.json
{
  "name": "Home (principal)",
  "__resolveType": "website/pages/Page.tsx",
  "sections": [
    // List of sections on this page
    { "__resolveType": "site/sections/Header/Header.tsx" },
    { "__resolveType": "site/sections/Hero/HeroBanner.tsx" },
    // Lazy sections
    { 
      "__resolveType": "website/sections/Rendering/Lazy.tsx",
      "section": { "__resolveType": "site/sections/Product/ProductShelf.tsx" }
    }
  ]
}
```

### Section Resolution Types

| Pattern | Meaning |
|---------|---------|
| `site/sections/*` | Custom section in this repo |
| `website/sections/*` | From website app |
| `vtex/sections/*` | From VTEX app |
| `Rendering/Lazy.tsx` | Lazy-loaded wrapper |
| `Rendering/Deferred.tsx` | Deferred loading |

### Build Lazy Loading Map

For each key page, identify:
1. Which sections are above-the-fold (sync rendered)
2. Which sections are wrapped in `Rendering/Lazy.tsx`

```bash
# Find all lazy sections in page blocks
grep -r "Rendering/Lazy.tsx" .deco/blocks/pages-*.json
```

Document in a table:
| Page | Lazy Sections | Above Fold |
|------|---------------|------------|
| Home | ProductShelf, Reviews | HeroBanner, Categories |

---

## Step 3.5: Map Navigation Flow

Trace how users navigate between pages:

### Key Entry Points
1. **Home** (`/`) - Main landing
2. **Search** (`/s?q=`) - Search results
3. **Direct PDP** (via external link)

### Connection Points
Look for:
- Links in sections that point to other pages
- Category menu structure
- Product card click targets
- Call-to-action buttons

### Build Navigation Diagram
```
Home (/)
  ├── Search (/s) ───────────────────┐
  ├── Category (PLP) ────────────────┤
  │     └── Subcategory ─────────────┤
  └── Product Cards ────────────────→┴─→ PDP (/:slug/p)
                                           ├── Add to Cart → Minicart
                                           └── Buy Now → Checkout
```

---

## Step 4: Custom Code Inventory

### Sections
```bash
find sections -name "*.tsx" | wc -l  # Count
find sections -name "*.tsx"          # List
```

Categorize by directory:
- `sections/Header/` - Header components
- `sections/Footer/` - Footer components
- `sections/Product/` - Product display
- `sections/Content/` - Content blocks
- `sections/Gallery/` - Image galleries

### Loaders
```bash
find loaders -name "*.ts" | wc -l   # Count
find loaders -name "*.ts"            # List
```

Important loaders to note:
- Search loaders (intelligent search, suggestions)
- Product loaders (details, recommendations)
- User loaders (geolocation, session)

### Caching Inventory

Audit which loaders have cache headers:

```bash
# Find loaders WITH cache
grep -l "export const cache" loaders/**/*.ts

# Find loaders WITHOUT cache (potential issues)
grep -L "export const cache" loaders/**/*.ts
```

For each loader, check for:
```typescript
// Good: Has caching
export const cache = "stale-while-revalidate";
export const cacheKey = (props: Props) => `${props.id}`;

// Bad: No caching - every request hits origin
export default async function loader(props: Props) { ... }
```

Build a caching inventory table:
| Loader | Cache | TTL | Priority to Fix |
|--------|-------|-----|-----------------|
| `loaders/search/intelligenseSearch.ts` | ❌ None | - | 🔴 High (hot path) |
| `loaders/product/buyTogether.ts` | ✅ SWR | 5min | - |
| `loaders/getUserGeolocation.ts` | ❌ None | - | 🟡 Medium |

### Actions
```bash
find actions -name "*.ts" | wc -l   # Count
find actions -name "*.ts"            # List
```

Common actions:
- Cart operations
- Newsletter signup
- User authentication

### Islands (Fresh interactive components)
```bash
find islands -name "*.tsx" | wc -l  # Count
find islands -name "*.tsx"           # List
```

---

## Step 5: Understanding Custom Implementations

### Search for Deco Docs
Use `SearchDecoCx` to understand patterns:

```
SearchDecoCx({ query: "lazy loading sections" })
SearchDecoCx({ query: "caching loaders" })
SearchDecoCx({ query: "VTEX integration" })
```

### Common Customizations

| Customization | Where to Look |
|---------------|---------------|
| Custom search | `loaders/search/` |
| Product enrichment | `loaders/product/` |
| Cart modifications | `actions/cart/` |
| Header/Menu | `sections/Header/`, `.deco/blocks/Header*.json` |
| Checkout flow | `sections/Checkout/`, `routes/` |

---

## Step 5.5: Document Debugging Tips

Gather common debugging scenarios for this specific site:

### Debug Flags
```
?__d          - Server timing with loader breakdown
?__d=verbose  - Extended debug info
```

### Common Issues to Document

| Issue | How to Debug |
|-------|--------------|
| Section not rendering | Check `.deco/blocks/pages-*.json` for `__resolveType` |
| Loader returning empty | Add `console.log`, check browser devtools |
| Slow page load | Check lazy sections with `?__d` flag |
| Cache not working | Verify `export const cache` in loader file |
| Platform API errors | Check account config in `.deco/blocks/` |

### Find Platform Configuration
```bash
# VTEX
grep -r "myvtex.com" .deco/blocks/ --include="*.json"

# Shopify
grep -r "myshopify.com" .deco/blocks/ --include="*.json"
```

### Trace Lazy Section Performance
In browser devtools, filter Network tab by `/deco/render` to see:
- Which sections are lazy-loaded
- Their response times
- Cache hit/miss (x-cache header)

---

## Step 6: Block Validation

Run the block validator (validate-blocks) to check configuration health:

```bash
# Run directly from any deco site (no installation needed)
deno run -A https://deco.cx/validate -report validation-report.json
```

> **Note:** This command works without any setup. Just run it from the site's root directory.

### What to Capture

| Category | What to Document |
|----------|------------------|
| **Error Count** | Sections/loaders/actions with type mismatches |
| **Unused Count** | Files not referenced in any block |
| **Warning Count** | Extra properties not in Props |
| **Top Errors** | List files with most errors |

### Using the JSON Report

The `-report` flag generates a structured JSON file:

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "summary": {
    "totalSections": 133,
    "totalErrors": 15,
    "totalWarnings": 4,
    "unusedSections": 8,
    "validSections": 110
  },
  "sectionsWithErrors": [...],
  "unusedSections": [...]
}
```

Use this to automatically populate AGENTS.md Block Health section.

### Generate Diagnostics MD Report

After running validation, create a human-readable diagnostics file (`BLOCKS_DIAGNOSTICS.md`):

```bash
# 1. Run validation with JSON report
deno run -A https://deco.cx/validate -report validation-report.json

# 2. Read the JSON and create BLOCKS_DIAGNOSTICS.md with:
```

**BLOCKS_DIAGNOSTICS.md should contain:**

| Section | Content |
|---------|---------|
| **Summary Table** | Total files, valid %, errors, warnings, unused |
| **Critical Issues** | Top errors grouped by root cause with impact assessment |
| **Sections with Errors** | Table of files, error counts, issue descriptions |
| **Loader/Action Errors** | Separate table for non-section files |
| **Warnings** | Props interface issues, extra properties |
| **Unused Code Inventory** | Categorized lists: sections, loaders, actions |
| **Recommendations** | Prioritized fixes (Priority 1/2/3 with impact level) |
| **How to Re-run** | Commands to regenerate reports |

**Example structure:**

```markdown
# Block Validation Diagnostics - [Site Name]

**Generated:** [Date]

## Summary

| Metric | Count |
|--------|-------|
| **Total files analyzed** | 139 |
| **Valid (no issues)** | 82 (59%) |
| **With errors** | 13 (9%) |
| **Unused files** | 42 (30%) |
| **Total errors** | 367 |

## Critical Issues

### 1. Footer Type Mismatch (327 errors)

**File:** `sections/Footer/Footer.tsx`
**Impact:** HIGH - Affects 62 pages

The `security.images` property changed schema...

## Unused Code (42 files)

### Unused Sections (14 files)
| Section | Notes |
|---------|-------|
| `sections/ShippingSimulation.tsx` | Consider removal |

### Unused Loaders (23 files)
| Category | Files |
|----------|-------|
| **SAP Integration** | getUser.ts, createUploadLink.ts, ... |

## Recommendations

### Priority 1 - Fix Footer Schema (HIGH)
...
```

### Common Error Types

| Error | Meaning | Fix |
|-------|---------|-----|
| "required property missing" | Block JSON missing a required prop | Add the property to the block |
| "expected array, got object" | Type mismatch | Fix JSON structure |
| "Props interface not found in file" | Can't parse Props from TSX | Check file exports |
| "not used in any JSON" | Section/loader/action has no occurrences | Consider removing or adding to a page |
| "property not defined in type" | Extra prop in JSON | Remove with `-rm-vars` |

### Block Health Table for AGENTS.md

```markdown
## Block Health

| Status | Count |
|--------|-------|
| ✅ Valid | 85 |
| ⚠️ Warnings | 3 |
| ⚠️ Unused | 14 |
| ❌ Errors | 8 |

**Files with errors** (fix these):
- sections/Product/NotFound.tsx (7 errors)
- loaders/SAP/createCase.ts (9 errors)

**Unused files** (candidates for removal):
- sections/Product/Wishlist.tsx
- sections/Social/InstagramPosts.tsx
```

---

## Step 7: Git History Analysis

### Top Contributors
```bash
git log --format='%an <%ae>' | sort | uniq -c | sort -rn | head -10
```

### Recent Activity
```bash
git log --oneline -20
```

### File Change Frequency
```bash
git log --format='' --name-only | sort | uniq -c | sort -rn | head -20
```

---

## Step 7: Generate AGENTS.md

Compile all findings into AGENTS.md:

1. **Framework Summary** - Versions, stack type
2. **Platform Details** - VTEX/Shopify/etc config
3. **Page Architecture** - Key pages and their blocks
4. **Custom Code** - Sections, loaders, actions count
5. **Top Contributors** - Code owners
6. **Run Commands** - How to start locally
7. **Important Files** - Key files to know

---

## Step 8: Update README.md

If README is missing or outdated, update:

1. **Project Description** - What is this site?
2. **Quick Start** - How to run
3. **Prerequisites** - Deno version, env vars
4. **Architecture Link** - Point to AGENTS.md
5. **Contributing** - How to contribute

### README Template

```markdown
# [Site Name]

[Brief description]

## Quick Start

\`\`\`bash
# Install Deno (if needed)
curl -fsSL https://deno.land/install.sh | sh

# Run locally
deno task dev
\`\`\`

## Architecture

See [AGENTS.md](./AGENTS.md) for detailed architecture documentation.

## Environment Variables

Copy `.env.example` to `.env` and configure:
- `VTEX_ACCOUNT` - VTEX account name
- ...

## Top Contributors

[Auto-generated from git history]
```
