# Performance Audit Workflow

Detailed step-by-step process for running a performance audit.

## Prerequisites

1. **Site Information**
   - Sitename (e.g., `mystore`)
   - Production hostname (e.g., `www.mystore.com`)
   - Date range to analyze

2. **Access to MCP Tools**
   - MONITOR_* tools (CDN metrics)
   - SEARCH_LOGS, GET_LOG_DETAILS (error logs)

3. **Best Practices**
   - Use `granularity: "hourly"` for latency metrics (daily returns 0)
   - Run deco-full-analysis skill first to understand site structure
   - Compare with previous period when possible

---

## Step 1: Overall Health Check

### Get Summary Metrics

```
MONITOR_SUMMARY({
  sitename: "mystore",
  hostname: "www.mystore.com",
  startDate: "2026-01-17",
  endDate: "2026-01-18",
  granularity: "daily"
})
```

**What to look for**:
| Metric | Good | Warning | Critical |
|--------|------|---------|----------|
| cache_hit_ratio | >80% | 50-80% | <50% |
| status_5xx_count / total | <0.1% | 0.1-0.5% | >0.5% |
| status_4xx_count / total | <5% | 5-10% | >10% |

---

## Step 2: Traffic Pattern Analysis

### Get Top Paths

```
MONITOR_TOP_PATHS({
  sitename: "mystore",
  hostname: "www.mystore.com",
  startDate: "2026-01-17",
  endDate: "2026-01-18",
  limit: 30,
  granularity: "daily"
})
```

**Categorize results**:

| Category | Pattern | Expected % |
|----------|---------|------------|
| API Calls | `/live/invoke/*` | 20-40% |
| Static Assets | `/_frsh/js/*`, `/fonts/*`, `/sprites.svg` | 20-30% |
| Pages | `/`, `/p`, `/category` | 10-20% |
| Other | Favicon, SW, etc. | 10-20% |

**Red flags**:
- Single path > 10% (potential hotspot)
- High bandwidth on small files (inefficient)
- API calls > 50% (too many fetches)

### Group by Content Type

Manually categorize the top paths results:

| Content Type | Path Pattern | How to Identify |
|--------------|--------------|-----------------|
| API Calls | `/live/invoke/*` | Loader/action invocations |
| Lazy Sections | `/deco/render` | Section lazy loading |
| JavaScript | `/_frsh/js/*`, `*.js` | Fresh JS bundles |
| CSS/Styles | `*.css`, `/_frsh/css/*` | Stylesheets |
| Images | `/image/*`, `*.png/jpg/webp` | Product/banner images |
| Fonts | `*.woff2`, `/fonts/*` | Web fonts |
| Static | `/sprites.svg`, `/favicon.ico` | Icons, misc |
| HTML Pages | `/`, `/s`, `/:slug/p` | Server-rendered pages |

Create a summary table:

```markdown
| Type | Requests | Bandwidth | Cache Rate | Status |
|------|----------|-----------|------------|--------|
| API | 2.1M | 89GB | 0.05% | 🔴 |
| Lazy Sections | 450K | 12GB | 15% | 🟡 |
| JavaScript | 1.8M | 45GB | 94% | 🟢 |
```

### Identify Bandwidth Hotspots

Sort the top paths by bandwidth descending. The top 5-10 by bandwidth often reveal:

1. **Uncached large JSON** - API responses that should be cached
2. **Unoptimized images** - Not going through image proxy
3. **Large JS bundles** - Code splitting opportunities
4. **Repeated lazy sections** - Sections fetched too often

---

## Step 2.5: Lazy Section Analysis

### Filter for /deco/render

```
MONITOR_TOP_PATHS({
  sitename: "mystore",
  hostname: "www.mystore.com",
  startDate: "2026-01-17",
  endDate: "2026-01-18",
  limit: 20,
  filters: [
    { type: "path", operator: "contains", value: "/deco/render" }
  ]
})
```

**What to look for**:
- Which sections are lazy-loaded most
- Cache hit rate per section
- Latency (high latency = slow scroll experience)

**Create section analysis table**:

```markdown
| Section | Requests | Bandwidth | Cache Hit | Avg Latency |
|---------|----------|-----------|-----------|-------------|
| ProductShelf | 120K | 3.2GB | 12% | 180ms |
| Reviews | 85K | 1.8GB | 5% | 220ms |
```

**Common issues**:
- Lazy sections with 0% cache = origin fetch on every scroll
- High volume sections with low cache = optimization opportunity
- Consider making some sections non-lazy if always visible

---

## Step 3: Cache Analysis

### Get Cache Status Breakdown

```
MONITOR_CACHE_STATUS({
  sitename: "mystore",
  hostname: "www.mystore.com",
  startDate: "2026-01-17",
  endDate: "2026-01-18",
  granularity: "daily"
})
```

**Expected distribution (healthy site)**:
| Status | Target % |
|--------|----------|
| hit | >60% |
| miss | <25% |
| unknown | <10% |
| expired | <5% |

**Fixing low hit rate**:
1. Check if loaders have `export const cache = "..."` 
2. Add cache-control headers
3. Use stale-while-revalidate

### Find uncached hot paths

```
MONITOR_TOP_PATHS({
  sitename: "mystore",
  hostname: "www.mystore.com",
  startDate: "2026-01-17",
  endDate: "2026-01-18",
  limit: 20,
  filters: [
    { type: "cache_status", operator: "equals", value: "miss" }
  ]
})
```

---

## Step 4: Error Analysis

### Get Status Code Distribution

```
MONITOR_STATUS_CODES({
  sitename: "mystore",
  hostname: "www.mystore.com",
  startDate: "2026-01-17",
  endDate: "2026-01-18",
  granularity: "daily"
})
```

**Key status codes**:
| Code | Meaning | Action |
|------|---------|--------|
| 200 | Success | Good |
| 301/302 | Redirect | Minimize |
| 304 | Not Modified | Good (client cache) |
| 400 | Bad Request | Check client code |
| 404 | Not Found | Fix links or add redirects |
| 429 | Rate Limited | Reduce API calls |
| 500 | Server Error | Investigate logs |
| 502/504 | Gateway Error | Origin issues |

### Find paths with errors

```
MONITOR_TOP_PATHS({
  sitename: "mystore",
  hostname: "www.mystore.com",
  startDate: "2026-01-17",
  endDate: "2026-01-18",
  limit: 20,
  filters: [
    { type: "status_code", operator: "equals", value: "500" }
  ]
})
```

---

## Step 5: Error Log Deep Dive

### Search for Error Logs

```
SEARCH_LOGS({
  query: "level:error site:mystore",
  limit: 50
})
```

**Common error patterns**:

| Pattern | Cause | Fix |
|---------|-------|-----|
| "Too Many Requests" | VTEX rate limiting | Add caching |
| "TypeError: Cannot read" | JS null reference | Add null checks |
| "Failed to fetch" | Network error | Add retry logic |
| "dangling reference" | Missing block | Fix block config |

### Get Error Details

```
GET_LOG_DETAILS({
  query: "level:error site:mystore",
  groupBy: ["body", "service", "site"],
  limit: 20
})
```

### Check Error Trend

```
QUERY_CHART_DATA({
  startTime: 1737100800000,  // epoch ms
  endTime: 1737187200000,
  granularity: "1 hour",
  series: [{
    dataSource: "events",
    aggFn: "count",
    where: "level:error site:mystore",
    groupBy: []
  }]
})
```

---

## Step 6: Geographic Analysis

### Get Top Countries

```
MONITOR_TOP_COUNTRIES({
  sitename: "mystore",
  hostname: "www.mystore.com",
  startDate: "2026-01-17",
  endDate: "2026-01-18",
  limit: 10,
  granularity: "daily"
})
```

**What to look for**:
- Traffic from unexpected regions (bot traffic?)
- High latency for top regions
- Edge cache effectiveness by region

---

## Step 7: Time Series Analysis

### Get Usage Timeline

```
MONITOR_USAGE_TIMELINE({
  sitename: "mystore",
  hostname: "www.mystore.com",
  startDate: "2026-01-17",
  endDate: "2026-01-18",
  granularity: "hourly"
})
```

**What to look for**:
- Traffic patterns (peak hours)
- Cache ratio fluctuations
- Correlation with deployments

### Create 24h Pattern Table

Group hourly data into readable periods:

```markdown
| Period | Requests/hr | 5xx | 429s | Cache Hit | Notes |
|--------|-------------|-----|------|-----------|-------|
| 00:00-06:00 | 85K | <10 | 120 | 52% | Low traffic |
| 06:00-10:00 | 180K | 25 | 450 | 48% | Morning ramp |
| 10:00-14:00 | 320K | 45 | 1.2K | 45% | Peak |
| 14:00-18:00 | 280K | 40 | 980 | 46% | Steady |
| 18:00-22:00 | 380K | 120 | 1.8K | 44% | Evening peak |
| 22:00-00:00 | 150K | 20 | 320 | 50% | Wind down |
```

**Insights to draw**:
1. Peak hours = when NOT to deploy
2. Error spikes correlating with traffic = capacity issues
3. Cache hit degradation under load = cache thrashing

---

## Step 8: Correlate with Code

Using insights from `deco-full-analysis`:

### Match paths to loaders

| Hot Path | Loader | Has Cache? |
|----------|--------|------------|
| `/live/invoke/site/loaders/search/...` | `loaders/search/intelligenseSearch.ts` | Check file |
| `/live/invoke/vtex/loaders/...` | VTEX app loader | App handles |

### Check loader cache settings

```typescript
// In loader file, look for:
export const cache = "stale-while-revalidate";
export const cacheKey = (props: Props) => props.id;
```

---

## Step 9: Generate Report

Compile findings into a structured report. **MUST include these sections**:

### Required Report Sections

1. **Executive Summary** - Key metrics with status indicators
2. **Hot Paths Table** - Top 15 paths by requests AND by bandwidth
3. **Content Type Breakdown** - Grouped analysis
4. **Lazy Section Analysis** - /deco/render performance
5. **Time Series Pattern** - 24h traffic table
6. **Cache Analysis** - Status breakdown with drill-down
7. **Error Analysis** - Status codes and log patterns
8. **Actionable Recommendations** - Prioritized with specific fixes

### Report Checklist

Before finalizing, verify:
- [ ] Hot paths table shows BOTH requests and bandwidth columns
- [ ] Bandwidth hotspots are identified separately
- [ ] Content types are grouped (API, JS, Images, etc.)
- [ ] Lazy sections are analyzed with cache rates
- [ ] Time series shows peak hours
- [ ] Recommendations have specific file paths to fix
- [ ] Targets table shows current vs goal

See SKILL.md for full report template.

---

## Common Issues & Fixes

### Issue: Low Cache Hit Ratio

**Symptoms**: cache_hit_ratio < 50%

**Diagnose**:
```
MONITOR_CACHE_STATUS → high "unknown" or "miss"
MONITOR_TOP_PATHS with cache_status:miss filter → which paths
```

**Fix**:
1. Add cache headers to loaders
2. Use stale-while-revalidate
3. Increase cache TTLs

### Issue: High 429 Rate

**Symptoms**: 429 errors > 1%

**Diagnose**:
```
SEARCH_LOGS({ query: "429 site:mystore" })
MONITOR_TOP_PATHS → which paths hit rate limits
```

**Fix**:
1. Implement request deduplication
2. Add caching for frequently called APIs
3. Use batch APIs where available

### Issue: High 404 Rate

**Symptoms**: 404 errors > 5%

**Diagnose**:
```
MONITOR_TOP_PATHS with status_code:404 filter
```

**Fix**:
1. Add redirects for old URLs
2. Fix broken links in content
3. Update sitemap

### Issue: 5xx Errors Spiking

**Symptoms**: 5xx errors > 0.1%

**Diagnose**:
```
SEARCH_LOGS({ query: "level:error site:mystore" })
GET_LOG_DETAILS → specific error messages
```

**Fix**:
1. Check error logs for patterns
2. Add error handling/fallbacks
3. Fix root cause in code
