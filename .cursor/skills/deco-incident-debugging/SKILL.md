---
name: deco-incident-debugging
description: Fast incident response skill for Deco engineering team. Rapidly identifies known issues from past learnings, proposes solutions, and guides debugging for new incidents. Optimized for speed - get to root cause in minutes, not hours.
---

# Deco Incident Debugging

**PRIORITY: SPEED** - This skill is designed for real-time incident response. Every second counts. Execute the triage workflow immediately and propose solutions as fast as possible.

## When to Use This Skill

- **Production incident** in progress
- Site is down, slow, or showing errors
- Customer escalation requiring immediate response
- On-call engineer needs AI assistance during war room
- Post-incident to document root cause and learnings

## Quick Start - 60 Second Triage

```
1. GET SYMPTOMS         → What error/behavior is the user seeing?
2. MATCH LEARNINGS      → Search learnings/ for similar patterns
3. PROPOSE SOLUTIONS    → If match found, apply known fix
4. DEEP DIVE            → If no match, run diagnostic workflow
5. DOCUMENT             → Capture new learning if novel issue
```

## Files in This Skill

| File | Purpose |
|------|---------|
| `SKILL.md` | This overview and quick reference |
| `triage-workflow.md` | Step-by-step fast triage process (interactive) |
| `headless-mode.md` | Autonomous investigation without human interaction |
| `learnings-index.md` | Categorized index of all past learnings |

## Operating Modes

### Interactive Mode (default)
Use when working alongside an engineer during an incident. The agent asks clarifying questions and collaborates on diagnosis.

### Headless Mode
Use when triggered automatically by incident management systems (PagerDuty, Opsgenie, etc.). The agent receives minimal context and autonomously:
1. Extracts keywords from alert message
2. Searches learnings for matching patterns
3. Collects live data (logs, metrics)
4. Correlates findings to known issues
5. Outputs structured diagnosis with proposed fix

See `headless-mode.md` for full autonomous workflow, input/output formats, and integration examples.

## Learnings Database

We have documented learnings from past incidents in `learnings/`. These contain:

- **Problem**: What went wrong
- **Symptoms**: Observable indicators
- **Root Cause**: Why it happened (with code examples)
- **Solution**: How to fix it (with code examples)
- **How to Debug**: Commands and techniques to diagnose
- **Impact**: What happens if unfixed

### Current Learnings Categories

| Category | Learnings | Key Issues |
|----------|-----------|------------|
| `cache-strategy` | 2 | Missing cache, cookie blocking edge cache |
| `loader-optimization` | 2 | N+1 overfetching, lazy section issues |
| `external-css` | 1 | Lazy sections missing styles |
| `block-config` | 1 | Dangling block references |
| `rich-text` | 1 | Hardcoded domain URLs |
| `ui-bug` | 1 | Invisible clickable areas |
| `responsive` | 1 | Breakpoint inconsistencies |
| `retry-logic` | 1 | Off-by-one retry attempts |
| `safari-bug` | 1 | Image flash on navigation |
| `vtex-routing` | 1 | myvtex vs vtexcommercestable domain |
| `migration` | 1 | Deno 1 to Deno 2 migration |

## Incident Response Workflow

### Phase 1: Rapid Assessment (< 2 minutes)

**Ask the engineer these questions:**

1. **What is the error message or behavior?**
   - Copy exact error text if available
   - Describe what user sees

2. **When did it start?**
   - Sudden vs gradual
   - After deployment?
   - Traffic spike?

3. **What is the scope?**
   - All users or specific segment?
   - All pages or specific routes?
   - One site or multiple?

4. **What changed recently?**
   - Code deployments
   - Config changes
   - Third-party updates

### Phase 2: Pattern Matching (< 3 minutes)

**Search learnings for known patterns:**

```bash
# Search by symptom keywords
grep -ri "SYMPTOM_KEYWORD" learnings/

# Examples:
grep -ri "429" learnings/           # Rate limiting
grep -ri "cache" learnings/         # Cache issues
grep -ri "slow" learnings/          # Performance
grep -ri "not found" learnings/     # Missing resources
grep -ri "cookie" learnings/        # Cookie/session issues
grep -ri "vtex" learnings/          # VTEX integration
grep -ri "lazy" learnings/          # Lazy loading issues
```

### Phase 3: Known Issue? Apply Fix Immediately

If symptom matches a learning:

1. **Read the full learning file**
2. **Verify root cause matches** the current symptoms
3. **Apply the documented solution**
4. **Verify the fix works**

### Phase 4: Unknown Issue? Deep Diagnostic

If no learning matches, run full diagnostics:

```bash
# Check error logs (HyperDX)
SEARCH_LOGS({ query: "level:error site:SITENAME", limit: 50 })

# Check CDN metrics (if slow)
MONITOR_SUMMARY({ sitename: "SITE", hostname: "HOSTNAME" })
MONITOR_TOP_PATHS({ ... })
MONITOR_STATUS_CODES({ ... })

# Check for TypeScript errors
deno check --unstable-tsgo --allow-import main.ts

# Check for recent changes
git log --oneline -20
git diff HEAD~5

# Check block validation
deno run -A https://deco.cx/validate -report validation-report.json
```

### Phase 5: Document New Learning

If this is a novel issue, create a new learning:

```markdown
# [Title]

## Category
[category-name]

## Problem
[What went wrong]

## Symptoms
- [Observable indicator 1]
- [Observable indicator 2]

## Root Cause
[Why it happened with code examples]

## Solution
[How to fix with code examples]

## How to Debug
[Commands and techniques]

## Files Affected
[List of file patterns]

## Pattern Name
[Short memorable name]

## Checklist Item
[One-line check for future audits]

## Impact
[What happens if unfixed]
```

## Common Incident Patterns

### Rate Limiting (429 Errors)

**Symptoms**: "Too Many Requests" errors, spiky error rates

**Quick Check**:
```bash
grep -ri "rate limit\|429\|overfetch" learnings/
```

**Likely Learnings**:
- `loader-overfetching-n-plus-problem.md` - Fetching too much data
- `cache-strategy-standardization-loaders.md` - Missing cache causing repeated calls

**Immediate Actions**:
1. Check if loaders have `export const cache`
2. Check for N+1 query patterns
3. Add stale-while-revalidate caching

### Slow Page Load

**Symptoms**: High TTFB, slow LCP, user complaints about speed

**Quick Check**:
```bash
grep -ri "slow\|cache\|lazy\|performance" learnings/
```

**Likely Learnings**:
- `cache-strategy-standardization-loaders.md` - Missing cache
- `lazy-sections-external-css-loading.md` - CSS not loading for lazy sections
- `vtex-cookies-prevent-edge-caching.md` - Edge cache blocked

**Immediate Actions**:
1. Check cache hit rates with CDN metrics
2. Verify lazy sections have proper cache headers
3. Check for sync loaders blocking render

### Missing Content / Blank Sections

**Symptoms**: Sections not rendering, blank areas on page

**Quick Check**:
```bash
grep -ri "dangling\|missing\|not found\|blank" learnings/
```

**Likely Learnings**:
- `dangling-block-references.md` - Block config points to deleted component
- `duplicate-sections-masked-by-broken-loaders.md` - Loader errors hidden by duplicates

**Immediate Actions**:
1. Run block validation: `deno run -A https://deco.cx/validate`
2. Check browser console for loader errors
3. Verify component files exist

### VTEX Integration Issues

**Symptoms**: Products not loading, cart errors, checkout problems

**Quick Check**:
```bash
grep -ri "vtex" learnings/
```

**Likely Learnings**:
- `vtex-domain-routing-myvtex-vs-vtexcommercestable.md` - Wrong domain
- `vtex-cookies-prevent-edge-caching.md` - Cookie issues

**Immediate Actions**:
1. Check VTEX domain configuration
2. Verify API credentials
3. Check for VTEX service status

### Visual Bugs / UI Issues

**Symptoms**: Broken layouts, invisible elements, style issues

**Quick Check**:
```bash
grep -ri "invisible\|css\|style\|responsive\|safari" learnings/
```

**Likely Learnings**:
- `invisible-clickable-areas-from-empty-links.md` - Empty links covering content
- `responsive-breakpoint-consistency.md` - Mobile/desktop inconsistencies
- `safari-image-flash-fix.md` - Safari-specific image issues
- `lazy-sections-external-css-loading.md` - Missing styles

**Immediate Actions**:
1. Check browser dev tools for overlapping elements
2. Inspect CSS loading order
3. Test on affected browser/device

## Debugging Commands Reference

### Error Investigation

```bash
# Search error logs
SEARCH_LOGS({ query: "level:error site:SITENAME", limit: 50 })

# Group errors by message
GET_LOG_DETAILS({ 
  query: "level:error site:SITENAME",
  groupBy: ["body", "service"]
})

# Timeline of errors
QUERY_CHART_DATA({
  series: [{ dataSource: "events", aggFn: "count", where: "level:error" }],
  granularity: "1 hour"
})
```

### Performance Investigation

```bash
# CDN summary
MONITOR_SUMMARY({ sitename: "SITE", hostname: "HOST", startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD" })

# Top paths by requests
MONITOR_TOP_PATHS({ ... })

# Cache effectiveness
MONITOR_CACHE_STATUS({ ... })

# Error rates
MONITOR_STATUS_CODES({ ... })
```

### Code Investigation

```bash
# Type errors
deno check --unstable-tsgo --allow-import main.ts

# Block validation
deno run -A https://deco.cx/validate

# Find missing cache
grep -L "export const cache" loaders/**/*.ts

# Recent changes
git log --oneline -20
git diff HEAD~5

# Find files with errors
deno check --unstable-tsgo --allow-import main.ts 2>&1 | grep "error:" | sed 's/:.*//g' | sort | uniq -c | sort -rn
```

## Escalation Criteria

### Escalate Immediately If:

- Site completely down (no pages loading)
- Checkout broken (revenue impact)
- Data breach suspected
- Issue affecting multiple customers
- Fix requires platform changes (not site code)

### Can Handle with This Skill:

- Single site performance issues
- Configuration problems
- Code bugs in site repository
- Cache/loader issues
- Visual/UI bugs

## Post-Incident Checklist

After resolving the incident:

- [ ] Document root cause in learnings/ if novel
- [ ] Create PR with fix
- [ ] Update affected checklists if pattern is common
- [ ] Share learning with team
- [ ] Consider if monitoring should be added

## Related Skills

- `deco-full-analysis` - For comprehensive site audits (non-urgent)
- `deco-performance-audit` - For deep performance analysis
- `deco-typescript-fixes` - For systematic type error fixes
