---
name: deco-full-analysis
description: Run a full analysis of a Deco site - generates AGENTS.md with architecture, navigation flows, caching inventory, block health, and optimization findings. Includes 114 learnings from real sites as 9 checklists.
---

# Deco Full Analysis

Run a comprehensive analysis of a Deco e-commerce site. Generates **AGENTS.md** - a complete guide with architecture, custom code inventory, navigation flows, and everything an AI agent needs to work effectively with the codebase.

Includes **114 optimization learnings** from real Deco sites organized into 9 checklists covering loaders, images, caching, SEO, hydration, assets, bugs, dependencies, and site cleanup.

## When to Use This Skill

- Onboarding to a new Deco site
- Before making significant changes
- Understanding the site's architecture
- Documenting custom implementations
- Preparing for code reviews
- **Validating block configurations** match TypeScript Props

## What It Produces

### 1. AGENTS.md
A comprehensive guide for AI agents containing:
- Framework versions and stack (Fresh vs HTMX)
- Apps installed and their versions
- Key page blocks (Home, PDP, PLP, Search, etc.)
- **Navigation flow** - How pages connect to each other
- **Lazy loading map** - Which sections are lazy on each page
- **Caching inventory** - Which loaders have cache vs don't
- Custom sections, loaders, and actions
- Integration details (VTEX, Shopify, etc.)
- **Critical user journeys** - Common flows to test
- **Debugging tips** - How to troubleshoot common issues
- Top committers and ownership

### 2. BLOCKS_DIAGNOSTICS.md
A human-readable diagnostics report from block validation:
- **Summary metrics** - Total files, valid %, errors, unused counts
- **Critical issues** - Top errors grouped by root cause with impact assessment
- **Schema errors** - Tables of sections/loaders/actions with type mismatches
- **Unused code inventory** - Categorized lists for cleanup review
- **Prioritized recommendations** - Actionable fix suggestions
- **Re-run commands** - How to regenerate the report

### 3. validation-report.json
Structured JSON report for programmatic use:
- Timestamps and project metadata
- Summary counts (sections, errors, warnings, unused)
- Detailed error list with file, line, property, message
- Full unused files list

### 4. README.md Updates
If the README is outdated or missing key info:
- How to run the site locally
- Environment setup
- Key commands
- Link to AGENTS.md

## Workflow

```
1.  Analyze deno.json → Framework versions, dependencies, apps
2.  Analyze .deco/blocks/ → Page configurations, key blocks
3.  Map page navigation → How pages link together
4.  Identify lazy sections → Find Rendering/Lazy.tsx wrappers
5.  Analyze loaders/ → Custom data loading
6.  Audit cache headers → Check for `export const cache`
7.  Analyze sections/ → Custom UI components
8.  Analyze actions/ → Custom mutations
9.  Run block validation → Generate validation-report.json
10. Generate BLOCKS_DIAGNOSTICS.md → Human-readable diagnostics
11. Search Deco docs → Understand patterns used
12. Check git log → Top committers
13. Generate AGENTS.md → Comprehensive guide with all sections
14. Update README.md → Quick start, run commands
```

## Tools Used

### Code Analysis (file system)
- Read `deno.json` for dependencies and versions
- Read `.deco/blocks/*.json` for page configurations
- List `sections/`, `loaders/`, `actions/` directories
- Read key component files

### Deco Documentation
```
SearchDecoCx({ query: "blocks sections loaders" })
```
Use this to understand Deco patterns and concepts.

### Git Analysis
```bash
git log --format='%an' | sort | uniq -c | sort -rn | head -10
```
Find top committers (code owners).

## Key Files to Analyze

| File/Directory | Purpose |
|----------------|---------|
| `deno.json` | Framework versions, apps, dependencies |
| `.deco/blocks/pages-*.json` | Page configurations |
| `.deco/blocks/Header*.json` | Header configurations |
| `sections/` | Custom UI components |
| `loaders/` | Custom data loaders |
| `actions/` | Custom mutations |
| `apps/` | App configurations |
| `fresh.gen.ts` | Generated routes/islands |
| `manifest.gen.ts` | Generated manifest |

## Framework Detection

### Fresh Stack (SSR + Islands)
```json
// deno.json
{
  "imports": {
    "@deco/deco": "jsr:@deco/deco@...",
    "preact": "npm:preact@...",
    "$fresh/": "..."
  }
}
```
- Uses `islands/` for interactive components
- Uses `routes/` for pages
- Sections render on server

### HTMX Stack
```json
// deno.json
{
  "imports": {
    "@deco/deco/htmx": "..."
  }
}
```
- Uses HTMX for interactivity
- Sections can have `hx-*` attributes

## Understanding Page Blocks

Page blocks in `.deco/blocks/pages-*.json` define which sections appear on each page:

```json
{
  "name": "Home (principal)",
  "__resolveType": "website/pages/Page.tsx",
  "sections": [
    { "__resolveType": "site/sections/Header/Header.tsx" },
    { "__resolveType": "website/sections/Rendering/Lazy.tsx", 
      "section": { "__resolveType": "site/sections/Product/ProductShelf.tsx" }
    }
  ]
}
```

Key patterns:
- `site/sections/*` - Custom sections in the repo
- `website/sections/*` - Sections from website app
- `Rendering/Lazy.tsx` - Lazy-loaded sections
- `Rendering/Deferred.tsx` - Deferred sections

## App Analysis

Apps in Deco provide loaders, sections, and integrations. Check `deno.json`:

```json
{
  "imports": {
    "apps/": "https://cdn.jsdelivr.net/gh/deco-cx/apps@...",
    // or forked
    "apps/": "https://cdn.jsdelivr.net/gh/OrgName/deco-apps@..."
  }
}
```

Common apps:
- `apps/vtex/` - VTEX integration
- `apps/shopify/` - Shopify integration
- `apps/wake/` - Wake integration
- `apps/website/` - Core website features
- `apps/analytics/` - Analytics

## Custom Code Analysis

### Custom Sections
```
sections/
├── Header/
│   └── Header.tsx      # Custom header
├── Product/
│   ├── ProductShelf.tsx
│   └── ProductCard.tsx
└── Footer/
    └── Footer.tsx
```

### Custom Loaders
```
loaders/
├── search/
│   └── intelligenseSearch.ts  # Custom search
├── product/
│   └── productDetails.ts
└── getUserGeolocation.ts
```

### Custom Actions
```
actions/
├── cart/
│   └── addToCart.ts
└── newsletter/
    └── subscribe.ts
```

## AGENTS.md Template

```markdown
# AGENTS.md - [Site Name]

## Quick Reference

| Item | Value |
|------|-------|
| Framework | Deco + Fresh |
| Deco Version | @deco/deco@1.x.x |
| Platform | VTEX / Shopify / Wake |
| Apps Version | apps@commit-hash |

## How to Run

\`\`\`bash
deno task dev
# or
deno task start
\`\`\`

## Architecture

### Stack
- **Framework**: Deco with Fresh (SSR + Islands)
- **Platform**: VTEX IO
- **CDN**: Deco Edge

### Key Pages
| Page | Block | Route | Custom? |
|------|-------|-------|---------|
| Home | pages-Home-123 | `/` | Yes |
| PDP | pages-PDP-456 | `/:slug/p` | Yes |
| PLP | pages-PLP-789 | `/category-slug` | Yes |
| Search | pages-Search-101 | `/s` | Yes |

### Navigation Flow

\`\`\`
Home (/)
  ├── Search (/s) ───────────────────┐
  ├── Category (PLP) ────────────────┤
  │     └── Subcategory ─────────────┤
  └── Product Cards ────────────────→┴─→ PDP (/:slug/p)
                                           ├── Add to Cart → Minicart
                                           └── Buy Now → Checkout
\`\`\`

### Lazy Loading Map

Which sections are lazy-loaded on each key page:

| Page | Lazy Sections | Above Fold |
|------|---------------|------------|
| Home | ProductShelf, InstagramPosts, FAQ | HeroBanner, Carousel |
| PDP | Reviews, BuyTogether, SimilarProducts | ProductInfo, Gallery |
| PLP | ProductShelf (pagination) | Header, Filters |

### Caching Inventory

| Loader | Cache | TTL | Notes |
|--------|-------|-----|-------|
| `loaders/search/intelligenseSearch.ts` | ❌ None | - | Should add SWR |
| `loaders/product/buyTogether.ts` | ✅ SWR | 5min | Good |
| `loaders/getUserGeolocation.ts` | ❌ None | - | Should cache per session |
| `vtex/loaders/categories/tree.ts` | ❌ None | - | High volume, needs cache |

### Custom Code
| Type | Count | Examples |
|------|-------|----------|
| Sections | 15 | ProductShelf, CustomHeader |
| Loaders | 8 | intelligenseSearch |
| Actions | 3 | addToCart |

## Critical User Journeys

### 1. Browse & Purchase
\`\`\`
Home → Search/Category → PDP → Add to Cart → Checkout
\`\`\`

### 2. Direct Search
\`\`\`
Home → Searchbar → Search Results → PDP → Add to Cart
\`\`\`

### 3. Account Access
\`\`\`
Any Page → Login → Account Dashboard → Orders/Wishlist
\`\`\`

## Debugging Tips

### Common Issues

| Issue | How to Debug |
|-------|--------------|
| Section not rendering | Check `.deco/blocks/pages-*.json` for `__resolveType` |
| Loader returning empty | Add `console.log` in loader, check browser devtools |
| Slow page load | Check lazy sections with `?__d` debug flag |
| Cache not working | Verify `export const cache` in loader file |
| VTEX errors | Check VTEX account in `.deco/blocks/vtex.json` |

### Useful Debug Commands

\`\`\`bash
# Check which loaders are called on a page
curl -sI "https://site.com/page?__d" | grep server-timing

# Find sections with a specific loader
grep -r "loaderName" .deco/blocks/

# Check for missing cache headers
grep -L "export const cache" loaders/**/*.ts
\`\`\`

### Performance Flags

- `?__d` - Shows server timing with loader breakdown
- `?__d=verbose` - Extended debug info
- Check `/deco/render` calls in Network tab for lazy sections

## Block Health

Run `deno task validate-blocks -report validation-report.json` to check for configuration issues.

| Status | Count |
|--------|-------|
| ✅ Valid | 85 |
| ⚠️ Warnings | 3 |
| ⚠️ Unused | 14 |
| ❌ Errors | 8 |

### Sections with Errors
- `sections/Product/NotFound.tsx` (7 errors) - missing required props
- `loaders/SAP/createCase.ts` (9 errors) - type mismatches

### Unused Files (candidates for removal)
- `sections/Product/Wishlist.tsx`
- `sections/Social/InstagramPosts.tsx`
- `loaders/legacy/oldProductLoader.ts`

## Code Owners

| Contributor | Commits |
|-------------|---------|
| dev1@co.com | 150 |
| dev2@co.com | 89 |

## Important Files

- `deno.json` - Dependencies and tasks
- `.deco/blocks/` - Page configurations
- `sections/` - Custom UI components
- `loaders/` - Custom data loading

## Common Tasks

### Add a new section
1. Create file in `sections/YourSection.tsx`
2. Export default component with Props interface
3. Add to page via Admin or `.deco/blocks/`

### Modify a page
1. Find the page block in `.deco/blocks/pages-*.json`
2. Edit sections array
3. Or use the Deco Admin UI

### Add caching to a loader
\`\`\`typescript
// loaders/myLoader.ts
export const cache = "stale-while-revalidate";
export const cacheKey = (props: Props) => \`\${props.key}\`;
\`\`\`
```

## Example Output

When you run this skill on an e-commerce site, you'll discover:

- Using Deco + Fresh stack
- Platform integration (VTEX, Shopify, etc.)
- Custom intelligent search loader
- Forked or custom deco-apps
- 50+ custom sections
- Key pages: Home, PDP, PLP, Search, Checkout
- Top contributors and their commit counts

## Block Validation (validate-blocks)

Run block validation to ensure JSON configurations match TypeScript Props.

### How to Run

**Run directly from any deco site directory (no installation needed):**
```bash
# Validate all sections, loaders, and actions
deno run -A https://deco.cx/validate

# Generate a JSON report for analysis
deno run -A https://deco.cx/validate -report validation-report.json
```

**Optional: Add as a deno task for convenience:**

Add to your site's `deno.json`:
```json
{
  "tasks": {
    "validate-blocks": "deno run -A https://deco.cx/validate"
  }
}
```

Then run:
```bash
deno task validate-blocks -report validation-report.json
```

### What It Validates

1. **Type Matching** - JSON values match Props interface types
2. **Required Properties** - All required props are present
3. **Unused Files** - Sections, loaders, and actions not referenced in any block
4. **Extra Properties** - Properties in JSON not defined in types (with `-unused` flag)
5. **Anti-Patterns** - Dead code and structural issues (see Anti-Patterns section below)

### Unused Detection

| Type | Detection | Auto-Removal |
|------|-----------|--------------|
| **Unused Sections** | ✅ Detected | ✅ With `-rm-sections` |
| **Unused Loaders** | ✅ Detected | ❌ Manual only* |
| **Unused Actions** | ✅ Detected | ❌ Manual only* |
| **Unused Properties** | ✅ With `-unused` | ✅ With `-rm-vars` |

*Loaders and actions are not auto-removed because they may be imported dynamically.

### Sample Output

```
🔍 Validating sections, loaders, and actions...

✅ sections/Header/Header.tsx - 15 occurrence(s)
⚠️  sections/Footer/Footer.tsx - 1 occurrence(s), 2 warning(s)
❌ sections/Category/CategoryGrid.tsx - 1 error(s)
   - "items": required property missing

═══════════════════════════════════════
📊 SUMMARY
═══════════════════════════════════════
Total sections/loaders/actions: 95
Total occurrences: 284
✅ No issues: 85
⚠️  With warnings: 3
⚠️  Unused: 3
❌ With errors: 4
```

### JSON Report (`-report` flag)

Generate a structured JSON report for automated analysis:

```bash
deno run -A https://deco.cx/validate -report validation-report.json
```

The report includes:
- `summary`: Total counts (sections, errors, warnings, unused)
- `sectionsWithErrors`: Detailed error list with file, line, property, message
- `sectionsWithWarnings`: Detailed warning list
- `unusedSections`: List of unreferenced files

Use the report to:
1. Track validation status over time
2. Integrate with CI/CD pipelines
3. Generate AGENTS.md Block Health sections automatically

### Diagnostics MD Report

After running block validation with `-report`, generate a human-readable diagnostics file:

```bash
# 1. Run validation and save JSON report
deno run -A https://deco.cx/validate -report validation-report.json

# 2. Generate BLOCKS_DIAGNOSTICS.md from the JSON report
```

The diagnostics MD should include:
- **Summary table** - Total files, valid, errors, warnings, unused counts
- **Critical issues** - Top errors grouped by root cause
- **Sections with errors** - Table of files with error counts
- **Loader/action errors** - Separate section for non-section files
- **Warnings** - Props interface issues
- **Unused code inventory** - Sections, loaders, actions not referenced
- **Recommendations** - Prioritized fix suggestions
- **How to re-run** - Commands to regenerate the report

#### BLOCKS_DIAGNOSTICS.md Template

```markdown
# Block Validation Diagnostics - [Site Name]

**Generated:** [Date]
**Tool:** validate-blocks v1.1.0

---

## Summary

| Metric | Count |
|--------|-------|
| **Total files analyzed** | X |
| **Total block occurrences** | X |
| **Valid (no issues)** | X (X%) |
| **With warnings** | X (X%) |
| **Unused files** | X (X%) |
| **With errors** | X (X%) |
| **Total errors** | X |

---

## Critical Issues

### 1. [Root Cause Name] (X errors)

**File:** `sections/Example/Example.tsx`
**Impact:** HIGH/MEDIUM/LOW - Affects X pages

[Description of the issue and root cause]

**Affected Pages (sample):**
- page1.json
- page2.json

**Fix Required:** [Specific instructions]

---

## Sections with Schema Errors

| Section | Errors | Issue |
|---------|--------|-------|
| `sections/Example.tsx` | X | Missing required prop |

---

## Unused Code (X files)

### Unused Sections (X files)

| Section | Notes |
|---------|-------|
| `sections/Unused.tsx` | Consider removal |

### Unused Loaders (X files)

| Loader | Notes |
|--------|-------|
| `loaders/unused.ts` | May be called dynamically |

---

## Recommendations

### Priority 1 - [Issue Name] (HIGH)
[Specific fix instructions]

### Priority 2 - [Issue Name] (MEDIUM)
[Specific fix instructions]

---

## How to Re-run Validation

\`\`\`bash
deno run -A https://deco.cx/validate -report validation-report.json
\`\`\`
```

#### Task: Generate Diagnostics MD

When analyzing a site, always generate both files:

1. **validation-report.json** - For programmatic use
2. **BLOCKS_DIAGNOSTICS.md** - For human review

The diagnostics MD makes it easier to:
- Share findings with the team
- Track issues in PRs/tickets
- Reference specific errors without parsing JSON
- Prioritize fixes by impact

### Cleanup Options

```bash
# Remove properties not in Props interface
deno task validate-blocks -rm-vars

# Remove unused section files (with confirmation - type 'yes')
deno task validate-blocks -rm-sections

# Show warnings for extra properties
deno task validate-blocks -unused

# Use custom blocks directory
deno task validate-blocks -blocks /path/to/.deco/blocks
```

### Anti-Patterns Detection

The validator detects structural issues beyond type mismatches:

#### 1. Dead Code (`never` rule)
Sections with `website/matchers/never.ts` rule will never execute:

```json
{
  "__resolveType": "website/flags/multivariate/section.ts",
  "variants": [{
    "rule": { "__resolveType": "website/matchers/never.ts" },  // 💀 DEAD CODE
    "value": { "__resolveType": "site/sections/Product/ProductShelf.tsx" }
  }]
}
```

**Impact**: Bloats page config, confuses developers, slows admin load.
**Fix**: Remove the entire variant or replace with `always` matcher.

#### 2. Lazy Wrapping Multivariate (Anti-Pattern)
Lazy should not wrap multivariate - the flag evaluation happens immediately anyway:

```json
{
  "__resolveType": "website/sections/Rendering/Lazy.tsx",
  "section": {
    "__resolveType": "website/flags/multivariate/section.ts",  // ❌ WRONG
    "variants": [...]
  }
}
```

**Why it's wrong**: Lazy defers rendering, but multivariate flags are evaluated at request time regardless. If you need lazy loading per variant, the multivariate should wrap Lazy sections:

```json
{
  "__resolveType": "website/flags/multivariate/section.ts",
  "variants": [{
    "rule": { "__resolveType": "website/matchers/always.ts" },
    "value": {
      "__resolveType": "website/sections/Rendering/Lazy.tsx",  // ✅ CORRECT
      "section": { "__resolveType": "site/sections/Product/ProductShelf.tsx" }
    }
  }]
}
```

#### Sample Anti-Pattern Output

```
🚨 ANTI-PATTERNS DETECTED

💀 Dead Code (40 sections with 'never' rule):
   📄 pages-Home.json: 30 dead code section(s)
   📄 pages-BlackFriday.json: 10 dead code section(s)

⚠️  Lazy wrapping Multivariate (5 instances):
   📄 pages-Home.json
      Path: sections.variants[0].value[5]
      Lazy wrapping multivariate is an anti-pattern...
```

### Common Block Corruption Patterns

#### Exploded Strings
Sometimes strings get corrupted into character-indexed objects:

```json
// ❌ Corrupted
{
  "image": {
    "0": "h", "1": "t", "2": "t", "3": "p", "4": "s",
    "5": ":", "6": "/", "7": "/", ...
  }
}

// ✅ Should be
{
  "image": "https://example.com/image.jpg"
}
```

**Detection**: Objects with 50+ numeric keys where values are single characters.
**Fix Script**: Reconstruct string from numeric keys sorted by index.

#### Arrays as Objects
Sometimes arrays get saved as indexed objects:

```json
// ❌ Corrupted
{
  "items": { "0": {...}, "1": {...}, "2": {...} }
}

// ✅ Should be
{
  "items": [{...}, {...}, {...}]
}
```

### Loader-Injected Props Pattern

When a loader injects props at runtime (like `device` from `ctx.device`), use this pattern:

```typescript
// sections/Product/ProductShelfGroup.tsx

export interface Props {
  shelves: ShelfConfig[];
  /**
   * @hide
   */
  device: "mobile" | "desktop" | "tablet";  // Required with @hide
}

export function loader(props: Props, _req: Request, ctx: AppContext) {
  return {
    ...props,
    device: ctx.device,  // Loader always provides actual device
  };
}
```

**In the JSON block**, store a default value (will be overwritten by loader):
```json
{
  "__resolveType": "site/sections/Product/ProductShelfGroup.tsx",
  "shelves": [...],
  "device": "mobile"
}
```

**Why this pattern:**
1. `@hide` prevents the prop from showing in admin UI
2. Prop is required in Props, so TypeScript is happy
3. JSON has a value, so deco admin validation passes
4. Loader overwrites with actual runtime value

**Validator divergence**: Our script validates against the `Props` interface. Deco admin may validate against `SectionProps<typeof loader>` which includes loader return types. If you see admin errors not caught by the script, check for loader-injected props.

### Nested Props with Loader-Injected Values

When a section has nested props that reference another component's Props (which includes loader-injected values like `device`), you must Omit those values:

```typescript
// ❌ WRONG - ProductShelfProps includes required `device`
export interface ProductShelfTimedOffersConfig {
  type: "ProductShelfTimedOffers";
  props: ProductShelfTimedOffersProps;  // shelfProps.device is required!
}

// ✅ CORRECT - Omit device from nested props
type ShelfPropsWithoutDevice = Omit<ProductShelfProps, "device">;

export interface ProductShelfTimedOffersConfig {
  type: "ProductShelfTimedOffers";
  props: Omit<ProductShelfTimedOffersProps, "shelfProps" | "shelfPropsOffer"> & {
    shelfProps: ShelfPropsWithoutDevice;
    shelfPropsOffer?: ShelfPropsWithoutDevice;
  };
}
```

**Why**: The parent component injects `device` at runtime, but deco admin validates the JSON before runtime. If nested props require `device`, admin shows validation errors even though the code works.

### Add to AGENTS.md

Include block health summary:

```markdown
## Block Health

| Status | Count |
|--------|-------|
| ✅ Valid | 85 |
| ⚠️ Warnings | 3 |
| ⚠️ Unused | 14 |
| ❌ Errors | 8 |

**Files with errors**:
- sections/Product/NotFound.tsx (7 errors)
- loaders/SAP/createCase.ts (9 errors)

**Unused files** (candidates for removal):
- sections/Product/Wishlist.tsx
- sections/Social/InstagramPosts.tsx
- actions/legacy/oldAction.ts
```

## Optimization Checklists

Based on 105 learnings from real Deco sites, run these checklists during analysis:

### Available Checklists

| Checklist | Items | Key Focus |
|-----------|-------|-----------|
| [loader-optimization.md](checklists/loader-optimization.md) | 33 | Lazy sections, VTEX simulation, deduplication |
| [image-optimization.md](checklists/image-optimization.md) | 18 | LCP, eager/lazy loading, responsive images |
| [cache-strategy.md](checklists/cache-strategy.md) | 7 | SWR, cache keys, rate limiting |
| [seo-fix.md](checklists/seo-fix.md) | 10 | JSON-LD, meta tags, canonicals |
| [hydration-fix.md](checklists/hydration-fix.md) | 9 | SDK race conditions, SSR/client mismatch |
| [asset-optimization.md](checklists/asset-optimization.md) | 17 | Third-party scripts, lazy loading, CSP |
| [bug-fix.md](checklists/bug-fix.md) | 8 | Defensive coding, content sanitization |
| [dependency-update.md](checklists/dependency-update.md) | 3 | Version alignment, Deco 2.0 |
| [site-cleanup.md](checklists/site-cleanup.md) | 9 | Platform files, dead code, type fixes |

### Top Patterns to Check

**Loader Optimization** (most common):
- [ ] Heavy sections wrapped in Lazy (BuyTogether, Reviews, Shelves)
- [ ] VTEX simulation set to `skip` or `only1P`
- [ ] No sync product loaders in Header
- [ ] AbortController timeout on external APIs

**Image Optimization**:
- [ ] LCP image has `loading="eager"` and `fetchPriority="high"`
- [ ] First 4-6 PLP products are eager loaded
- [ ] All images use Deco `<Image />` component
- [ ] SVGs bypass optimization proxy

**Cache Strategy**:
- [ ] Custom loaders have `export const cache = "stale-while-revalidate"`
- [ ] Cache keys are deterministic (no URL params, sorted arrays)
- [ ] Common loaders use shared blocks for deduplication

**SEO**:
- [ ] JSON-LD escapes `<` character
- [ ] Every page has SEO section
- [ ] Prices have exactly 2 decimal places

**Hydration**:
- [ ] No direct `window`/`document` access without `IS_BROWSER` check
- [ ] External widgets wait for load via callback
- [ ] No `Math.random()` for ID generation

### How to Use Checklists

1. **During analysis**: Reference relevant checklists when examining code
2. **In AGENTS.md**: Include findings table showing pass/fail for each area
3. **For recommendations**: Use checklist items as specific action items

### Example Findings Table (add to AGENTS.md)

```markdown
## Optimization Audit

| Category | Status | Key Findings |
|----------|--------|--------------|
| Loader Optimization | 🟡 | 3 sections need Lazy wrapping |
| Image Optimization | 🔴 | LCP banner missing fetchPriority |
| Cache Strategy | 🔴 | 5 loaders missing cache config |
| SEO | 🟢 | All pages have SEO section |
| Hydration | 🟢 | No SSR/client mismatches found |
| Asset Optimization | 🟡 | Chat widget loads on all pages |
| Bug Fixes | 🟢 | No critical issues |
| Dependencies | 🟡 | Consider updating to latest apps |
```

## Next Steps After Generating AGENTS.md

1. Review the generated AGENTS.md
2. **Run block validation** to generate `validation-report.json`
3. **Generate BLOCKS_DIAGNOSTICS.md** from the validation report
4. **Run through optimization checklists** for each category
5. Check if README.md needs updates
6. Identify areas that need documentation
7. Use the performance-audit skill for runtime analysis
