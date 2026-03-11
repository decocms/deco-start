# Incremental TypeScript Fixing Strategy

## The Core Problem

Running `deno check` on a large deco storefront can take 30-60+ seconds. With 200+ errors, a naive fix-one-check-repeat loop would take hours.

## Solution: Fast Feedback with `--unstable-tsgo`

Deno 2.1+ includes an experimental fast type checker based on the TSGo port:

```bash
# FAST - TSGo checker (~3-5s per run) - ALWAYS use this
deno check --unstable-tsgo --allow-import main.ts
```

**Requirements**: Deno 2.1 or later (ideally 2.6+)

> **Note for Deno 2.0+**: Always include `--allow-import` flag as it's required for remote imports.

```bash
# Check your version
deno --version

# Update if needed
deno upgrade
```

## The Iterative Strategy

### Phase 1: Assessment

```bash
# Get total error count
deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep -c "ERROR"

# Save full error list
deno check --unstable-tsgo --allow-import main.ts 2>&1 > /tmp/type-errors.txt

# Categorize errors
grep "possibly 'undefined'" /tmp/type-errors.txt | wc -l
grep "Cannot find name" /tmp/type-errors.txt | wc -l
grep "not assignable" /tmp/type-errors.txt | wc -l
grep "Property .* does not exist" /tmp/type-errors.txt | wc -l
```

### Phase 2: Batch Fixes

Fix errors in batches of 5-20, grouped by category:

1. **First batch**: Missing global types (biggest impact, unlocks other fixes)
2. **Second batch**: Props exports (straightforward, mechanical)
3. **Third batch**: Possibly undefined errors (repetitive pattern)
4. **Fourth batch**: Type mismatches (may need custom types)
5. **Final batch**: Edge cases and complex fixes

### Phase 3: Incremental Verification

After each batch:

```bash
# Quick check - should see error count decreasing
deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep -c "error:"

# Commit progress
git add -A
git commit -m "fix(types): reduce deno check errors from X to Y"
```

### Commit Message Pattern

Use consistent commit messages to track progress:

```
fix(types): reduce deno check errors from 200 to 180
fix(types): reduce deno check errors from 180 to 150
fix(types): reduce deno check errors from 150 to 100
...
fix(types): achieve zero deno check TypeScript errors
```

## Useful Commands Cheatsheet

```bash
# Fast type check
deno check --unstable-tsgo --allow-import main.ts

# Count errors
deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep -c "error:"

# Find errors in specific file
deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep "MyComponent.tsx"

# Find specific error patterns
deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep "TS2532"  # possibly undefined
deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep "TS2304"  # cannot find name
deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep "TS2339"  # property does not exist

# List files with most errors
deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep "error:" | \
  sed 's/:.*//g' | sort | uniq -c | sort -rn | head -20
```

## Common Gotchas

### Large Codebases May Need More Memory

```bash
# If you hit memory issues
DENO_V8_FLAGS="--max-old-space-size=8192" deno check --unstable-tsgo --allow-import main.ts
```

### Some Errors Cascade

Fixing one error may reveal or fix others. If error count changes unexpectedly, re-run and re-categorize.

## Example Session

```bash
$ deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep -c "error:"
215

# Fix global types
$ vim types/global.d.ts
$ deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep -c "error:"
181
$ git add -A && git commit -m "fix(types): reduce deno check errors from 215 to 181"

# Fix Props exports
$ # ... edit multiple files ...
$ deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep -c "error:"
150
$ git add -A && git commit -m "fix(types): reduce deno check errors from 181 to 150"

# Continue until...
$ deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep -c "error:"
0

# Done!
```

## Time Estimates

| Errors | With --unstable-tsgo | Without |
|--------|---------------------|---------|
| 200 errors, 10 fix cycles | ~30-50 min | ~5-10 hours |
| 50 errors, 5 fix cycles | ~15-25 min | ~2-3 hours |

The fast checker makes this process actually feasible for large codebases.
