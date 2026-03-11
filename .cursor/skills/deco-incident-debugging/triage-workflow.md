# Triage Workflow - Fast Incident Response

This workflow is optimized for **SPEED**. Follow these steps in order. Stop as soon as you identify the issue.

## Step 0: Get Context (30 seconds)

**Gather from the engineer:**

```
INCIDENT BRIEF:
- Site: [site name]
- Error/Behavior: [exact message or description]
- Started: [when - sudden or gradual]
- Scope: [all users? specific pages? specific browsers?]
- Recent changes: [deployments, config, third-party]
```

## Step 1: Symptom Keyword Search (60 seconds)

**Extract keywords from the error/behavior and search learnings:**

| Symptom Type | Keywords to Search | Command |
|--------------|-------------------|---------|
| Rate limits | 429, rate limit, too many requests | `grep -ri "429\|rate limit" learnings/` |
| Slow pages | slow, cache, ttfb, performance | `grep -ri "slow\|cache\|ttfb" learnings/` |
| Missing content | blank, missing, not found, null | `grep -ri "missing\|not found\|blank" learnings/` |
| Errors | error, exception, failed | `grep -ri "error\|failed\|exception" learnings/` |
| VTEX | vtex, cart, checkout, product | `grep -ri "vtex" learnings/` |
| Visual | css, style, invisible, layout | `grep -ri "css\|style\|invisible" learnings/` |
| Safari | safari, webkit, ios | `grep -ri "safari\|webkit" learnings/` |
| Images | image, flash, loading, lcp | `grep -ri "image\|flash\|lcp" learnings/` |
| Lazy | lazy, defer, render | `grep -ri "lazy\|defer\|render" learnings/` |

**If match found**: Read the learning file and jump to Step 4.

## Step 2: Category-Based Search (60 seconds)

**If keyword search didn't find exact match, search by category:**

```bash
# List all learnings
ls learnings/

# Read category headers
head -20 learnings/*.md | grep -A 2 "## Category"
```

| Category | When to Check |
|----------|---------------|
| `cache-strategy` | Slow pages, high API calls, rate limits |
| `loader-optimization` | Performance, N+1 queries, overfetching |
| `block-config` | Missing sections, "not found" errors |
| `rich-text` | Content display issues, broken links |
| `ui-bug` | Visual problems, click issues |
| `responsive` | Mobile/desktop differences |
| `safari-bug` | Safari-only issues |
| `vtex-routing` | VTEX API errors, wrong responses |
| `migration` | Post-migration issues |

## Step 3: Quick Diagnostics (2 minutes)

**If no learning match, run quick diagnostics:**

### 3a. Error-Based Issues

```bash
# Check error logs (last 1 hour)
SEARCH_LOGS({ 
  query: "level:error site:SITENAME", 
  limit: 50,
  startTime: "-1h",
  endTime: "now"
})

# Group by error type
GET_LOG_DETAILS({ 
  query: "level:error site:SITENAME",
  groupBy: ["body"]
})
```

**Look for**:
- Error message patterns
- Stack traces pointing to specific files
- Frequency of errors

### 3b. Performance Issues

```bash
# CDN metrics
MONITOR_SUMMARY({ 
  sitename: "SITE", 
  hostname: "HOST", 
  startDate: "TODAY", 
  endDate: "TODAY",
  granularity: "hourly"
})

# Top error paths
MONITOR_TOP_PATHS({
  ...baseParams,
  filters: [{ type: "status_code", operator: "contains", value: "5" }]
})

# Cache effectiveness
MONITOR_CACHE_STATUS({ ...baseParams })
```

**Look for**:
- Cache hit rate < 50% (should be >80%)
- 5xx error spike
- 429 rate limiting
- Specific paths with high errors

### 3c. Code Issues

```bash
# Type errors (fast check)
deno check --unstable-tsgo --allow-import main.ts 2>&1 | head -50

# Block validation
deno run -A https://deco.cx/validate 2>&1 | grep -E "❌|⚠️|error"

# Recent changes
git log --oneline -10
```

**Look for**:
- New TypeScript errors after deployment
- Invalid block configurations
- Recent commits touching affected areas

## Step 4: Apply Known Fix (if learning matched)

**Read the full learning file:**

```bash
cat learnings/[MATCHED_FILE].md
```

**Verify match:**
- [ ] Symptoms in learning match current symptoms
- [ ] Root cause explanation makes sense for this case
- [ ] Solution is applicable to this site

**Apply solution:**
1. Follow the code examples in the learning
2. Test the fix locally if possible
3. Deploy with confidence

## Step 5: Unknown Issue - Deep Dive

**If no learning matches, gather comprehensive data:**

### 5a. Full Error Context

```bash
# Extended error search
SEARCH_LOGS({ 
  query: "level:error site:SITENAME path:AFFECTED_PATH", 
  limit: 100
})

# Error timeline
QUERY_CHART_DATA({
  series: [{
    dataSource: "events",
    aggFn: "count",
    where: "level:error site:SITENAME",
    groupBy: ["body"]
  }],
  granularity: "5 minute",
  startTime: "-6h"
})
```

### 5b. Code Investigation

```bash
# Find the affected file
grep -r "ERROR_KEYWORD" sections/ loaders/ actions/

# Read the file
cat [AFFECTED_FILE]

# Check git blame
git blame [AFFECTED_FILE] | head -50

# Check recent changes to file
git log -5 --oneline -- [AFFECTED_FILE]
```

### 5c. Runtime Investigation

```bash
# Check server timing
curl -sI "https://SITE.com/affected-page?__d" | grep server-timing

# Check response headers
curl -sI "https://SITE.com/affected-page" | grep -i "cache\|set-cookie\|x-"

# Check for specific loader
curl -s "https://SITE.com/live/invoke/site/loaders/[LOADER]" | jq '.'
```

## Step 6: Document Novel Issue

**If this is a new pattern, create a learning:**

```bash
# Create new learning file
touch learnings/[descriptive-name].md
```

**Template:**

```markdown
# [Title - Descriptive Problem Name]

## Category
[category-name]

## Problem
[Clear description of what went wrong]

## Symptoms
- [Observable indicator 1]
- [Observable indicator 2]
- [Error message if applicable]

## Root Cause
[Explanation with code examples showing the problem]

\`\`\`typescript
// PROBLEM CODE
\`\`\`

## Solution
[How to fix with code examples]

\`\`\`typescript
// FIXED CODE
\`\`\`

## How to Debug
\`\`\`bash
# Commands to diagnose this issue
\`\`\`

## Files Affected
- [File pattern 1]
- [File pattern 2]

## Pattern Name
[Short memorable name]

## Checklist Item
[One-line check for future audits]

## Impact
[What happens if unfixed - severity and scope]
```

## Decision Tree

```
START: What is the primary symptom?
│
├─► Rate Limit / 429
│   └─► Check: loader-overfetching, cache-strategy learnings
│       ├─► Match? Apply fix
│       └─► No match? Check for missing cache exports, N+1 queries
│
├─► Slow Page / High Latency
│   └─► Check: cache-strategy, lazy-sections, vtex-cookies learnings
│       ├─► Match? Apply fix
│       └─► No match? Run MONITOR_CACHE_STATUS, check for uncached loaders
│
├─► Missing Content / Blank Areas
│   └─► Check: dangling-block, duplicate-sections learnings
│       ├─► Match? Apply fix
│       └─► No match? Run block validation, check browser console
│
├─► Visual / UI Bug
│   └─► Check: invisible-clickable, responsive, safari, lazy-css learnings
│       ├─► Match? Apply fix
│       └─► No match? Inspect DOM, check CSS loading order
│
├─► VTEX Error
│   └─► Check: vtex-domain, vtex-cookies learnings
│       ├─► Match? Apply fix
│       └─► No match? Check VTEX status, verify credentials
│
└─► Unknown Error
    └─► Run full diagnostics (Step 3a-3c)
        └─► Create new learning when resolved
```

## Speed Tips

1. **Parallel searches**: Run multiple grep commands at once
2. **Use exact error text**: Copy-paste errors for precise matching
3. **Check recent deploys first**: Most incidents follow deployments
4. **Trust the learnings**: If symptoms match, the fix likely works
5. **Don't over-investigate**: If you find a match, apply it and verify

## Common Pitfalls

- **Over-diagnosing**: Stop investigating once you find the cause
- **Ignoring learnings**: Always check learnings before deep diving
- **Missing scope**: Verify if issue is widespread or isolated
- **Forgetting to document**: Novel issues must become learnings
