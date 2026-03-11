---
name: deco-typescript-fixes
description: Strategies and patterns for fixing TypeScript errors in deco.cx storefronts, especially after migrations or dependency updates.
---

# Deco TypeScript Fixes

This skill provides strategies for systematically fixing TypeScript errors in deco.cx storefronts. It's especially useful after:
- Migrating from forked apps to official `deco-cx/apps`
- Updating `@deco/deco` or `@deco/dev` versions
- Adding stricter TypeScript settings

## When to Use This Skill

- User asks to "fix all type errors" or "make deno check pass"
- After a migration that introduces many TypeScript errors
- When enabling stricter type checking in a deco project

## Critical: Use Fast Type Checker

Standard `deno check` takes 30-60+ seconds. With 200+ errors, iterating is painful.

**Always use the fast TSGo checker (Deno 2.1+, ideally 2.6+):**

```bash
# FAST (~3-5s) - ALWAYS use this
deno check --unstable-tsgo --allow-import main.ts
```

## Quick Start

1. Run `deno check --unstable-tsgo --allow-import main.ts` to get the full error list
2. Count errors: `deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep -c "error:"`
3. Categorize errors (see Common Error Categories below)
4. Fix in batches by category, committing after each batch
5. Repeat until zero errors

## Files in This Skill

| File | Purpose |
|------|---------|
| `SKILL.md` | This overview and quick reference |
| `common-fixes.md` | Detailed patterns and code examples |
| `strategy.md` | The incremental fixing strategy |

## Common Error Categories

### 1. Missing Props Exports (Deco Compatibility)

**Symptom**: Deco admin can't load the component/section properly

**Pattern**: All components used as deco blocks need an exported `Props` type/interface

```typescript
// BEFORE - Props not exported
interface Props {
  title: string;
}

// AFTER - Export the Props
export interface Props {
  title: string;
}
```

### 2. Global Type Declarations (Third-Party Scripts)

**Symptom**: `Cannot find name 'AnalyticsQueue'` or similar for injected globals

**Pattern**: Declare globals in `types/global.d.ts`

```typescript
// types/global.d.ts
declare global {
  // deno-lint-ignore no-var
  var AnalyticsQueue: AnalyticsCommand[];
  // deno-lint-ignore no-var
  var dataLayer: unknown[];
  // deno-lint-ignore no-var
  var thirdPartyTracker: TrackerFn;
}
```

### 3. Possibly Undefined Values

**Symptom**: `Object is possibly 'undefined'`

**Pattern**: Use optional chaining or nullish coalescing

```typescript
// BEFORE
const name = product.name.toLowerCase();

// AFTER - optional chaining + fallback
const name = product?.name?.toLowerCase() ?? "";

// AFTER - nullish coalescing for defaults
const quantity = item.quantity ?? 1;
```

### 4. External API Type Mismatches

**Symptom**: VTEX/external API returns different shape than expected types

**Pattern**: Create custom types for API responses, use type assertions with comments

```typescript
// Create specific types for GraphQL responses
// types/myorders.ts
export interface LogisticsInfo {
  deliveryChannel?: string;
  shippingEstimateDate?: string;
}

// Use type assertion when SDK types don't match reality
const order = data as unknown as VtexOrderData;
```

### 5. Platform Import Cleanup

**Symptom**: Imports from removed platforms (Linx, Wake, etc.) fail

**Pattern**: Search and remove unused platform code entirely

```bash
# Find all platform-specific files
find . -name "*linx*" -o -name "*wake*" -o -name "*vnda*"

# Remove them if not using those platforms
```

### 6. Optional Props Without Defaults

**Symptom**: `Type 'undefined' is not assignable to type 'string'`

**Pattern**: Make props explicitly optional or provide defaults

```typescript
// BEFORE
interface Props {
  href: string;
}

// AFTER - make optional with fallback in usage
export interface Props {
  href?: string;
}

// In component:
const link = href ?? "#";
```

## Strategy Summary

1. **Batch by category** - Fix all "possibly undefined" errors together, all "Props exports" together
2. **Commit frequently** - Small commits let you track progress and rollback if needed
3. **Document type assertions** - When using `as unknown as X`, add a comment explaining why
4. **Create custom types** - Better to have explicit custom types than to silence errors
5. **Check deco admin** - After fixes, verify blocks still load in the deco admin

## Related Commands

```bash
# Fast type check (use this for iteration)
deno check --unstable-tsgo --allow-import main.ts

# Count errors
deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep -c "error:"

# Find errors by category
deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep "possibly 'undefined'"
deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep "Cannot find name"
deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep "not assignable"

# Find files with most errors
deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep "error:" | \
  sed 's/:.*//g' | sort | uniq -c | sort -rn | head -20
```
