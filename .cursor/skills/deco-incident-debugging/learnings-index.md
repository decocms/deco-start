# Learnings Index - Quick Reference

This index provides fast access to all documented learnings from past incidents. Use this during incidents to quickly find relevant solutions.

**Location**: `learnings/` folder in workspace root

## By Category

### Cache Strategy

| Learning | Key Symptoms | Quick Fix |
|----------|--------------|-----------|
| [cache-strategy-standardization-loaders.md](../../learnings/cache-strategy-standardization-loaders.md) | High API calls, cache misses, rate limits | Add `export const cache = "stale-while-revalidate"` |
| [vtex-cookies-prevent-edge-caching.md](../../learnings/vtex-cookies-prevent-edge-caching.md) | `/deco/render` uncached, high origin load | Middleware to strip Set-Cookie on lazy renders |

### Loader Optimization

| Learning | Key Symptoms | Quick Fix |
|----------|--------------|-----------|
| [loader-overfetching-n-plus-problem.md](../../learnings/loader-overfetching-n-plus-problem.md) | 429 errors, high API volume, slow pages | Reduce pagination, fetch only needed data |
| [lazy-sections-external-css-loading.md](../../learnings/lazy-sections-external-css-loading.md) | Lazy sections missing styles | Preload CSS or inline critical styles |

### Block Configuration

| Learning | Key Symptoms | Quick Fix |
|----------|--------------|-----------|
| [dangling-block-references.md](../../learnings/dangling-block-references.md) | "dangling reference" error, missing sections | Remove or update broken block references |
| [duplicate-sections-masked-by-broken-loaders.md](../../learnings/duplicate-sections-masked-by-broken-loaders.md) | Duplicate content, hidden loader errors | Fix loader errors, remove duplicates |

### Content Issues

| Learning | Key Symptoms | Quick Fix |
|----------|--------------|-----------|
| [hardcoded-domain-urls-in-rich-text.md](../../learnings/hardcoded-domain-urls-in-rich-text.md) | Broken links in rich text, wrong domains | Use relative URLs or dynamic domain |

### UI / Visual Bugs

| Learning | Key Symptoms | Quick Fix |
|----------|--------------|-----------|
| [invisible-clickable-areas-from-empty-links.md](../../learnings/invisible-clickable-areas-from-empty-links.md) | Elements not clickable, invisible overlays | Remove empty anchor tags |
| [responsive-breakpoint-consistency.md](../../learnings/responsive-breakpoint-consistency.md) | Mobile/desktop layout differences | Align breakpoint definitions |
| [safari-image-flash-fix.md](../../learnings/safari-image-flash-fix.md) | Image flashing in Safari on navigation | Use CSS contain property |

### VTEX Integration

| Learning | Key Symptoms | Quick Fix |
|----------|--------------|-----------|
| [vtex-domain-routing-myvtex-vs-vtexcommercestable.md](../../learnings/vtex-domain-routing-myvtex-vs-vtexcommercestable.md) | VTEX API errors, wrong store data | Use correct domain (vtexcommercestable) |

### Retry Logic

| Learning | Key Symptoms | Quick Fix |
|----------|--------------|-----------|
| [retry-strategy-max-attempts-off-by-one.md](../../learnings/retry-strategy-max-attempts-off-by-one.md) | Fewer retries than expected, early failures | Fix off-by-one in retry loop |

### Migration

| Learning | Key Symptoms | Quick Fix |
|----------|--------------|-----------|
| [migrate-deno1-to-deno2.md](../../learnings/migrate-deno1-to-deno2.md) | Deno 2 compatibility issues | Follow migration checklist |
| [deco-subpath-imports-version-mismatch.md](../../learnings/deco-subpath-imports-version-mismatch.md) | Import errors after updates | Align subpath import versions |

---

## By Symptom

### Rate Limiting / 429 Errors

1. **loader-overfetching-n-plus-problem.md** - Fetching too much data
2. **cache-strategy-standardization-loaders.md** - Missing cache causing repeated calls

### Slow Performance / High Latency

1. **cache-strategy-standardization-loaders.md** - Missing or inconsistent caching
2. **vtex-cookies-prevent-edge-caching.md** - Edge cache blocked by cookies
3. **lazy-sections-external-css-loading.md** - CSS loading delays
4. **loader-overfetching-n-plus-problem.md** - Too many API calls

### Missing Content / Blank Sections

1. **dangling-block-references.md** - Block points to deleted component
2. **duplicate-sections-masked-by-broken-loaders.md** - Loader errors hidden

### Visual / Layout Issues

1. **invisible-clickable-areas-from-empty-links.md** - Empty links blocking clicks
2. **responsive-breakpoint-consistency.md** - Breakpoint misalignment
3. **safari-image-flash-fix.md** - Safari image flashing
4. **lazy-sections-external-css-loading.md** - Missing styles on lazy sections

### VTEX Errors

1. **vtex-domain-routing-myvtex-vs-vtexcommercestable.md** - Wrong VTEX domain
2. **vtex-cookies-prevent-edge-caching.md** - Cookie issues

### Build / Type Errors

1. **migrate-deno1-to-deno2.md** - Deno 2 migration issues
2. **deco-subpath-imports-version-mismatch.md** - Import version conflicts

---

## Quick Search Commands

### Find learning by keyword

```bash
# Rate limiting issues
grep -ri "429\|rate limit\|too many" learnings/

# Cache issues
grep -ri "cache\|stale\|swr" learnings/

# Performance issues
grep -ri "slow\|performance\|ttfb\|latency" learnings/

# VTEX issues
grep -ri "vtex\|myvtex\|vtexcommerce" learnings/

# Visual/UI issues
grep -ri "css\|style\|invisible\|layout\|safari" learnings/

# Block/config issues
grep -ri "dangling\|reference\|block\|missing" learnings/

# Migration issues
grep -ri "deno\|migrate\|version\|import" learnings/
```

### List all learnings with categories

```bash
# Show category of each learning
for f in learnings/*.md; do echo "=== $f ==="; grep -A 1 "## Category" "$f"; done
```

### Find learning by error message

```bash
# Exact error text search
grep -ri "EXACT_ERROR_TEXT" learnings/

# Partial match
grep -ri "partial error" learnings/
```

---

## Learning File Structure

Each learning follows this structure:

```
# Title

## Category
[category-name]

## Problem
[Description]

## Symptoms
- Observable indicators

## Root Cause
[Explanation with code]

## Solution
[Fix with code examples]

## How to Debug
[Commands]

## Files Affected
[File patterns]

## Pattern Name
[Short name]

## Checklist Item
[One-line check]

## Impact
[Severity]
```

---

## Adding New Learnings

When documenting a new incident:

1. **Choose a descriptive filename**: `[keyword]-[brief-description].md`
   - Example: `cors-headers-missing-api-routes.md`

2. **Pick the right category**:
   - `cache-strategy` - Caching issues
   - `loader-optimization` - Data fetching issues
   - `block-config` - Deco block configuration
   - `ui-bug` - Visual/layout issues
   - `vtex-integration` - VTEX-specific issues
   - `migration` - Version/migration issues
   - `retry-logic` - Error handling patterns
   - Or create a new category if needed

3. **Include code examples**: Both problem and solution code

4. **Document debug commands**: Make it reproducible

5. **Update this index**: Add entry to appropriate sections

---

## Statistics

| Metric | Count |
|--------|-------|
| Total Learnings | 14 |
| Categories | 9 |
| Cache-related | 2 |
| Loader-related | 2 |
| VTEX-related | 2 |
| UI/Visual | 4 |
| Migration | 2 |
| Other | 2 |

**Last Updated**: Check git log for learnings/ folder
