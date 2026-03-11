# Dependency Update Checklist

3 learnings from real Deco sites. Check these during analysis.

## Framework Updates

### 1. Deco Platform Upgrade
**Check**: Is the site on latest Deco version?

```json
// deno.json - check versions
{
  "imports": {
    "@deco/deco": "jsr:@deco/deco@1.x.x",  // Check for latest
    "@deco/dev": "jsr:@deco/dev@x.x.x"
  }
}
```

**How to check latest**:
- Visit https://jsr.io/@deco/deco
- Compare with current version in deno.json

**Benefits of updating**:
- Performance patches
- Bug fixes for image handling
- New features
- Security updates

### 2. Apps Version Alignment
**Check**: Are deco and apps versions synchronized?

```json
// deno.json
{
  "imports": {
    "@deco/deco": "jsr:@deco/deco@1.100.0",
    "apps/": "https://cdn.jsdelivr.net/gh/deco-cx/apps@0.60.0/"
  }
}
```

**Alignment matters because**:
- Breaking changes may affect compatibility
- Feature parity between framework and apps
- Image optimization improvements

**Check release notes**:
- https://github.com/deco-cx/deco/releases
- https://github.com/deco-cx/apps/releases

### 3. Deco 2.0 Migration
**Check**: Is the site on Deco 2.0?

**Deco 2.0 benefits**:
- Partytown integration
- Optimized Apps architecture
- Better performance defaults
- Improved developer experience

**Signs of old architecture**:
- Using `deco-sites/std` imports
- Old loader patterns
- Missing Fresh 1.7+ features

## Update Process

### Pre-Update Checklist

1. **Backup**: Commit current state
2. **Test**: Run e2e tests before update
3. **Review**: Check release notes for breaking changes
4. **Staging**: Test update in staging environment

### Update Commands

```bash
# Check current versions
grep -E "@deco/deco|apps/" deno.json

# Update deno.json imports manually
# Then run:
deno cache --reload main.ts

# Test the update
deno task dev
deno task test:e2e
```

### Post-Update Checklist

- [ ] Site builds successfully
- [ ] Dev server starts
- [ ] Key pages load (Home, PDP, PLP)
- [ ] E2E tests pass
- [ ] No console errors
- [ ] Images loading correctly

## Version Compatibility Matrix

| Deco Version | Apps Version | Fresh | Notes |
|--------------|--------------|-------|-------|
| 1.100+ | 0.60+ | 1.7+ | Current stable |
| 1.90-1.99 | 0.55-0.59 | 1.6+ | Stable |
| <1.90 | <0.55 | 1.5 | Consider upgrade |

## Quick Audit Commands

```bash
# Show current versions
grep -E '"@deco|"apps/' deno.json

# Check for deco-sites/std (legacy)
grep -r "deco-sites/std" sections/ loaders/ components/

# Check Fresh version
grep '\$fresh' deno.json
```

## Dependency Audit Table

Add this to AGENTS.md:

```markdown
## Dependencies

| Package | Current | Latest | Action |
|---------|---------|--------|--------|
| @deco/deco | 1.95.0 | 1.102.0 | 🟡 Consider update |
| apps/ | 0.58.0 | 0.62.0 | 🟡 Consider update |
| Fresh | 1.7.3 | 1.7.3 | ✅ Up to date |
| Preact | 10.23.1 | 10.23.1 | ✅ Up to date |
```

## When to Update

**Update immediately**:
- Security vulnerabilities
- Critical bug fixes affecting your site
- Required for new features you need

**Update with planning**:
- Major version bumps
- Architecture changes
- When you have time to test thoroughly

**Delay if**:
- In the middle of a sprint
- Before major sales events
- No clear benefit
