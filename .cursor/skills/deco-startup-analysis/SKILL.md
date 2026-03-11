---
name: deco-startup-analysis
description: Analyze startup logs from `deno task start` and homepage request to identify image optimization issues, dependency warnings, type errors, and other runtime problems. Essential step before code analysis.
---

# Deco Startup Analysis

Run the Deco site locally, request the homepage, and analyze the console logs to identify common issues that affect performance and correctness.

## When to Use This Skill

- **First step** when starting work on any Deco site
- Before running full analysis or making changes
- When debugging performance or rendering issues
- As part of CI/CD quality checks

## Workflow

```
1. Start the dev server: deno task start
2. Wait for startup, note any warnings
3. Request homepage: curl localhost:8000/
4. Analyze logs for common issues
5. Document findings
6. Fix critical issues before proceeding
```

## Common Issues to Look For

### 1. Image Optimization Warnings

```
Missing height. This image will NOT be optimized: https://deco-sites-assets.s3.sa-east-1.amazonaws.com/...
```

**Problem**: Images without explicit `width` and `height` props bypass the Deco image optimization CDN and load directly from S3, causing:
- Slower load times (no CDN caching)
- Larger file sizes (no compression/resizing)
- Layout shifts (no reserved space)

**Root Causes**:
1. Image component has `height={undefined}` conditionally
2. Using `<img>` instead of Deco's `<Image />` component
3. Dynamic images without known dimensions

**Fix Pattern**:
```tsx
// WRONG - height is undefined when isHalf is false
<Image
  width={imageToDisplay.isHalf ? 32 : 112}
  height={imageToDisplay.isHalf ? 24 : undefined}  // ❌
/>

// RIGHT - always provide height
<Image
  width={imageToDisplay.isHalf ? 32 : 112}
  height={24}  // ✅ Always a value
/>
```

**Finding the culprit**:
1. Note the image URL from the warning
2. Search blocks for the URL: `grep -r "filename" .deco/blocks/`
3. Find which component renders that section
4. Check all Image components for missing height/width

### 2. S3 vs CDN URLs

**Problem**: Images using raw S3 URLs bypass optimization:
```
❌ https://deco-sites-assets.s3.sa-east-1.amazonaws.com/site/image.png
✅ https://assets.decocache.com/site/image.png
```

**Fix**: Update block configurations to use CDN URLs, or ensure Image component rewrites URLs.

### 3. PostCSS Dependency Warnings

```
Warning: The following peer dependency issues were found:
└─┬ cssnano@6.0.1
  └─┬ cssnano-preset-default@6.1.2
    ├─┬ cssnano-utils@4.0.2
    │ └── peer postcss@^8.4.31: resolved to 8.4.27
```

**Problem**: Mismatched PostCSS versions can cause CSS processing issues.

**Fix**: Update postcss in `deno.json` or `package.json`:
```json
{
  "imports": {
    "postcss": "npm:postcss@^8.4.31"
  }
}
```

### 4. nodeModulesDir Deprecation

```
Warning: "nodeModulesDir": true is deprecated in Deno 2.0. Use "nodeModulesDir": "auto" instead.
```

**Fix**: Update `deno.json`:
```json
{
  "nodeModulesDir": "auto"
}
```

### 5. experimentalDecorators Warning

```
Warning: experimentalDecorators compiler option is deprecated
```

**Fix**: Remove from `deno.json` compilerOptions or migrate decorators.

### 6. Manifest Missing Entries

```
TS7053: Element implicitly has an 'any' type because expression of type '"action-name"' can't be used to index type...
```

**Problem**: Code references actions/loaders that aren't in `manifest.gen.ts`.

**Causes**:
- Action/loader file was deleted but code still references it
- File exists but manifest wasn't regenerated
- Typo in the action/loader name

**Fix**:
1. Check if the file exists in `actions/` or `loaders/`
2. If missing, restore from git or remove the reference
3. Run `deno task start` to regenerate manifest

### 7. Type Errors During Check

Running `deno check --unstable-tsgo` reveals type issues:

| Error Code | Meaning | Common Fix |
|------------|---------|------------|
| TS2322 | Type not assignable | Fix type mismatch |
| TS2339 | Property doesn't exist | Add missing property to interface |
| TS7006 | Implicit any | Add type annotation |
| TS18048 | Possibly undefined | Add null check or use optional chaining |
| TS2353 | Unknown property in object literal | Remove extra property or add to interface |

## Analysis Checklist

Run through this checklist when analyzing startup logs:

```markdown
## Startup Analysis Results

### Image Optimization
- [ ] No "Missing height" warnings
- [ ] All images use CDN URLs (assets.decocache.com)
- [ ] No direct S3 URLs in production

### Dependencies
- [ ] No peer dependency warnings
- [ ] nodeModulesDir set to "auto"
- [ ] No deprecated options

### Manifest/Types
- [ ] All actions exist in manifest
- [ ] All loaders exist in manifest
- [ ] No TS7053 indexing errors

### Type Checking
- [ ] `deno check --unstable-tsgo` passes
- [ ] No implicit any errors
- [ ] No missing property errors
```

## Example Output (add to AGENTS.md)

```markdown
## Startup Analysis

**Date:** 2024-01-21
**Command:** `deno task start` + `curl localhost:8000/`

### Issues Found

| Category | Count | Severity | Status |
|----------|-------|----------|--------|
| Missing image height | 20 | Medium | 🔴 Needs fix |
| PostCSS peer deps | 30 | Low | 🟡 Can defer |
| nodeModulesDir deprecation | 1 | Low | 🟡 Easy fix |
| Missing actions | 2 | High | 🔴 Blocking |

### Image Optimization Issues

Images missing height (will NOT be optimized):
- `tag-OFERTA.png` - Used in ProductTags component
- `tag-frete-gratis.png` - Used in ProductTags component

**Fix:** Update `components/tags/ProductTags.tsx` to always pass height.

### Missing Actions

- `actions/spin.ts` - Referenced in FortuneWheel.tsx
- `actions/can-spin.ts` - Referenced in FortuneWheel.tsx

**Fix:** Restore from git or remove references.
```

## Commands Reference

```bash
# Start dev server
deno task start

# Request homepage (in another terminal)
curl -sI localhost:8000/ | head -20
curl -s localhost:8000/ > /dev/null

# Check for type errors
deno check --unstable-tsgo 2>&1 | head -100

# Count errors by type
deno check --unstable-tsgo 2>&1 | grep -o "TS[0-9]*" | sort | uniq -c | sort -rn

# Find images without height
grep -rn "height={undefined}" components/ sections/

# Find S3 image URLs in blocks
grep -r "s3.sa-east-1.amazonaws.com" .deco/blocks/
```

## Integration with Full Analysis

This skill should be run **before** the full analysis skill:

1. **deco-startup-analysis** - Fix critical runtime issues
2. **deco-full-analysis** - Document architecture and find optimizations
3. **deco-typescript-fixes** - Fix remaining type errors
4. **deco-performance-audit** - Runtime performance analysis

## Related Learnings

From site-optimization database:
- "Prioritize Above-the-Fold PLP Images" - Dynamic fetch priority
- "Optimize LCP for Banner Carousel" - Explicit LCP prioritization
- "Smart SVG Image Handling" - Conditional asset proxying
- "Eager Load First Product Image" - LCP image prioritization
