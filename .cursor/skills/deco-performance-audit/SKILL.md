---
name: deco-performance-audit
description: Perform a deep dive analysis of CDN metrics, cache performance, error rates, and traffic patterns for a Deco site. Use this skill to identify performance bottlenecks, optimize cache hit rates, and reduce error rates.
---

# Deco Performance Audit Skill

This skill performs a comprehensive performance analysis of a Deco site using CDN metrics and error logs. It generates actionable reports with specific recommendations.

## When to Use This Skill

- Investigating slow page loads
- Analyzing cache effectiveness
- Debugging high error rates
- Understanding traffic patterns
- Before/after deployment comparisons
- Monthly performance reviews

## What the Audit Produces

### Performance Report
- Overall metrics summary (requests, bandwidth, cache rate)
- **Hot paths table** - Top 20 paths with requests AND bandwidth columns
- **Content type breakdown** - Grouped by type (API, HTML, JS, Images, etc.)
- **Bandwidth hotspots** - Which paths consume the most bandwidth
- Cache status breakdown with drill-down
- HTTP status code distribution
- **Time series analysis** - Peak hours, traffic patterns
- **Lazy section analysis** - `/deco/render` performance
- Error log analysis with grouping
- Geographic traffic distribution
- **Period comparison** - Week over week (if available)
- Actionable recommendations with priority

## Tools Used

### CDN Monitoring (MONITOR_* tools)

| Tool | Purpose |
|------|---------|
| `MONITOR_SUMMARY` | Overall metrics: requests, pageviews, bandwidth, cache ratio, latency |
| `MONITOR_TOP_PATHS` | Top URLs by requests or bandwidth |
| `MONITOR_CACHE_STATUS` | Cache hit/miss/expired breakdown |
| `MONITOR_STATUS_CODES` | HTTP status code distribution |
| `MONITOR_TOP_COUNTRIES` | Geographic traffic distribution |
| `MONITOR_USAGE_TIMELINE` | Time series usage data |

### Error Logs (HyperDX)

| Tool | Purpose |
|------|---------|
| `SEARCH_LOGS` | Find error messages by query |
| `GET_LOG_DETAILS` | Get detailed log entries with grouping |
| `QUERY_CHART_DATA` | Time series error counts |

### Tool Parameters

All MONITOR tools require:
```json
{
  "sitename": "mystore",              // Deco site name
  "hostname": "www.mystore.com",      // Production hostname
  "startDate": "2026-01-17",          // YYYY-MM-DD
  "endDate": "2026-01-18",            // YYYY-MM-DD
  "granularity": "daily"              // "hourly" or "daily"
}
```

Optional filters:
```json
{
  "filters": [
    { "type": "path", "operator": "contains", "value": "/p" },
    { "type": "cache_status", "operator": "equals", "value": "miss" },
    { "type": "status_code", "operator": "equals", "value": "500" }
  ]
}
```

Filter types: `cache_status`, `status_code`, `path`, `country`
Operators: `equals`, `not_equals`, `contains`, `not_contains`

## Workflow

```
1. Get MONITOR_SUMMARY → Overall health
2. Get MONITOR_TOP_PATHS → Hot pages
3. Get MONITOR_CACHE_STATUS → Cache effectiveness
4. Get MONITOR_STATUS_CODES → Error rates
5. SEARCH_LOGS → Find error patterns
6. GET_LOG_DETAILS → Dig into specific errors
7. Correlate with code → Find root causes
8. Generate report → Actionable recommendations
```

## Metrics to Analyze

### 1. Cache Performance

**Goal**: Cache hit ratio > 80%

```
MONITOR_CACHE_STATUS response:
- hit: Served from cache (good)
- miss: Origin fetch required (optimize)
- expired: Cache expired, refetched
- revalidated: Cache validated with origin
- unknown: No cache header
```

**Red Flags**:
- Cache hit ratio < 50%
- High "unknown" cache status (missing headers)
- High "miss" on static assets

**Recommendations**:
- Add cache-control headers to loaders
- Use stale-while-revalidate for dynamic content
- Cache static assets aggressively

### 2. Error Rates

**Goal**: 5xx errors < 0.1%, 4xx < 5%

```
MONITOR_STATUS_CODES response:
- 200: Success
- 301/302/307: Redirects (expected but minimize)
- 304: Not Modified (good - client cache)
- 400: Bad Request (client issue)
- 404: Not Found (check for broken links)
- 429: Too Many Requests (rate limiting)
- 500: Server Error (investigate immediately)
- 502/504: Gateway errors (origin issues)
```

**Red Flags**:
- 5xx > 0.5%
- 429 > 5% (hitting rate limits)
- 404 > 10% (broken links/SEO issue)

### 3. Hot Paths & Traffic Analysis

**Goal**: Understand traffic patterns with full visibility

#### MUST Include: Complete Hot Paths Table

Always generate a table showing the actual data:

```markdown
### Hot Paths by Requests

| Rank | Path | Requests | % | Bandwidth | Cache Hit |
|------|------|----------|---|-----------|-----------|
| 1 | `/live/invoke/vtex/loaders/...` | 835K | 4.0% | 46.9GB | 0.0002% |
| 2 | `/_frsh/js/chunk-abc123.js` | 524K | 2.5% | 15.2GB | 94.3% |
| 3 | `/sprites.svg` | 312K | 1.5% | 890MB | 99.1% |
| ... | ... | ... | ... | ... | ... |

### Hot Paths by Bandwidth

| Rank | Path | Bandwidth | % | Requests | Notes |
|------|------|-----------|---|----------|-------|
| 1 | `/live/invoke/vtex/loaders/...` | 46.9GB | 35% | 835K | 🔴 Uncached |
| 2 | `/_frsh/js/chunk-abc123.js` | 15.2GB | 11% | 524K | ✅ Well cached |
| ... | ... | ... | ... | ... | ... |
```

#### Content Type Grouping

Group paths by type for clearer analysis:

| Content Type | Pattern | Requests | Bandwidth | Cache Rate |
|--------------|---------|----------|-----------|------------|
| **API Calls** | `/live/invoke/*` | 2.1M | 89GB | 0.05% |
| **Lazy Sections** | `/deco/render` | 450K | 12GB | 15% |
| **JavaScript** | `/_frsh/js/*` | 1.8M | 45GB | 94% |
| **Static Images** | `/image/*`, `*.png/jpg` | 890K | 120GB | 88% |
| **HTML Pages** | `/`, `/s`, `/:slug/p` | 320K | 8GB | 5% |
| **Fonts** | `*.woff2` | 210K | 3.2GB | 99% |
| **Icons** | `/sprites.svg` | 180K | 540MB | 99% |

This grouping reveals:
- API calls often consume most bandwidth but have low cache
- Lazy sections (`/deco/render`) need cache optimization
- Static assets should have >90% cache rate

### 4. Lazy Section Analysis

**Goal**: Understand `/deco/render` performance

```
MONITOR_TOP_PATHS with filter:
filters: [{ type: "path", operator: "contains", value: "/deco/render" }]
```

Analyze:
| Section (from query params) | Requests | Avg Latency | Cache Hit |
|-----------------------------|----------|-------------|-----------|
| ProductShelf | 120K | 180ms | 12% |
| Reviews | 85K | 220ms | 5% |
| SimilarProducts | 65K | 350ms | 0% |

**Red Flags**:
- Lazy sections with 0% cache = every scroll triggers origin fetch
- High latency on popular sections = poor UX

### 5. Time Series Analysis

**Goal**: Identify traffic patterns and correlations

```
MONITOR_USAGE_TIMELINE with granularity: "hourly"
```

Generate:
| Hour | Requests | Errors | Cache Hit % | Notes |
|------|----------|--------|-------------|-------|
| 00:00 | 85K | 12 | 52% | Low traffic |
| 10:00 | 320K | 45 | 48% | Morning peak |
| 14:00 | 410K | 120 | 45% | Afternoon peak |
| 20:00 | 380K | 200 | 44% | Evening peak, **error spike** |

Look for:
- Peak hours (when to avoid deployments)
- Error spikes correlated with traffic spikes
- Cache hit rate degradation under load

### 6. Bandwidth Hotspots

**Goal**: Find paths consuming disproportionate bandwidth

Sort by bandwidth descending and highlight:
- Uncached large payloads (JSON API responses)
- Large images not going through optimization
- JS bundles that could be smaller

```markdown
🔴 **Bandwidth Concerns**:
| Path | Bandwidth | Cache | Issue |
|------|-----------|-------|-------|
| `/live/invoke/vtex/loaders/productList` | 46GB | 0% | Uncached, high volume |
| `/deco/render?section=BigCarousel` | 8GB | 5% | Large payloads |
```

### 4. Error Log Analysis

**Common Error Patterns**:

| Error | Meaning | Action |
|-------|---------|--------|
| "Too Many Requests" | VTEX rate limiting | Reduce API calls, add caching |
| "TypeError: Cannot read" | JS runtime error | Fix the code |
| "Failed to fetch" | Network/API issue | Add retries, timeout handling |
| "Oops! dangling reference" | Missing block | Fix block config |

**Searching Logs**:
```
SEARCH_LOGS({ 
  query: "level:error site:mystore",
  limit: 50
})
```

**Getting Details**:
```
GET_LOG_DETAILS({
  query: "level:error site:mystore",
  groupBy: ["body", "service", "site"]
})
```

## Report Template

```markdown
# Performance Audit Report - [Site Name]

**Period**: 2026-01-17 to 2026-01-18
**Generated**: 2026-01-18T15:00:00Z

---

## Executive Summary

| Metric | Value | Status |
|--------|-------|--------|
| Total Requests | 20.4M | - |
| Total Bandwidth | 1.2 TB | - |
| Cache Hit Ratio | 42.8% | 🔴 Below 80% target |
| API Avg Latency | 245ms | 🟡 Review |
| 5xx Error Rate | 0.017% | 🟢 Below 0.1% |
| 429 Rate Limit | 6.8% | 🔴 High |

### Key Findings
1. **Finding 1** with impact and recommendation
2. **Finding 2** with impact and recommendation
3. **Finding 3** with impact and recommendation

---

## Traffic Analysis

### Hot Paths by Requests (Top 15)

| # | Path | Requests | % | Bandwidth | Cache Hit |
|---|------|----------|---|-----------|-----------|
| 1 | `/live/invoke/vtex/loaders/...` | 835K | 4.0% | 46.9GB | 🔴 0.0% |
| 2 | `/_frsh/js/chunk-abc.js` | 524K | 2.5% | 15.2GB | 🟢 94.3% |
| 3 | `/sprites.svg` | 312K | 1.5% | 890MB | 🟢 99.1% |
| ... | ... | ... | ... | ... | ... |

### Bandwidth Hotspots (Top 10 by GB)

| # | Path | Bandwidth | % of Total | Cache | Action |
|---|------|-----------|------------|-------|--------|
| 1 | `/live/invoke/vtex/loaders/productList` | 46.9GB | 15% | 🔴 0% | Add caching |
| 2 | `/_frsh/js/*` (combined) | 25GB | 8% | 🟢 94% | OK |
| 3 | `/deco/render?section=Carousel` | 12GB | 4% | 🟡 15% | Improve cache |

### Content Type Summary

| Type | Requests | Bandwidth | Cache Rate | Notes |
|------|----------|-----------|------------|-------|
| API (`/live/invoke/*`) | 2.1M | 89GB | 0.05% | 🔴 Needs caching |
| Lazy Sections (`/deco/render`) | 450K | 12GB | 15% | 🟡 Improve |
| JavaScript (`/_frsh/*`) | 1.8M | 45GB | 94% | 🟢 Good |
| Images | 890K | 120GB | 88% | 🟢 Good |
| HTML Pages | 320K | 8GB | 5% | 🟡 Expected for dynamic |
| Fonts | 210K | 3.2GB | 99% | 🟢 Excellent |

---

## Lazy Section Performance

### /deco/render Analysis

| Section | Requests | Bandwidth | Avg Latency | Cache | Priority |
|---------|----------|-----------|-------------|-------|----------|
| ProductShelf | 120K | 3.2GB | 180ms | 12% | 🔴 High |
| Reviews | 85K | 1.8GB | 220ms | 5% | 🔴 High |
| SimilarProducts | 65K | 2.1GB | 350ms | 0% | 🔴 Critical |
| FAQ | 45K | 890MB | 85ms | 45% | 🟢 OK |

**Issues**:
- SimilarProducts has 0% cache hit - every scroll fetches from origin
- High latency on Reviews section affects perceived performance

---

## Time Series (24h Pattern)

| Hour | Requests | 5xx | 429 | Cache Hit | Notes |
|------|----------|-----|-----|-----------|-------|
| 00-06 | 85K/hr | <10 | 120 | 52% | Low traffic |
| 06-10 | 180K/hr | 25 | 450 | 48% | Morning ramp |
| 10-14 | 320K/hr | 45 | 1.2K | 45% | Peak hours |
| 14-18 | 280K/hr | 40 | 980 | 46% | Steady |
| 18-22 | 380K/hr | 120 | 1.8K | 44% | Evening peak, **429 spike** |
| 22-00 | 150K/hr | 20 | 320 | 50% | Wind down |

**Pattern Analysis**:
- Peak: 10:00-14:00 and 18:00-22:00
- 429 errors correlate with evening peak
- Cache hit degrades under high load

---

## Cache Analysis

### Status Breakdown

| Status | Requests | % | Bandwidth | Issue |
|--------|----------|---|-----------|-------|
| HIT | 8.7M | 42.8% | 480GB | ✅ |
| MISS | 6.6M | 32.4% | 520GB | 🟡 Review |
| UNKNOWN | 4.7M | 23.0% | 180GB | 🔴 Missing headers |
| expired | 280K | 1.4% | 15GB | - |
| revalidated | 80K | 0.4% | 5GB | - |

### Uncached Hot Paths (Cache MISS filter)

| Path | Requests | Bandwidth | Should Cache? |
|------|----------|-----------|---------------|
| `/live/invoke/vtex/loaders/productList` | 450K | 32GB | ✅ Yes, with SWR |
| `/live/invoke/site/loaders/search` | 280K | 18GB | ✅ Yes, short TTL |
| `/deco/render?section=Reviews` | 85K | 1.8GB | ✅ Yes |

---

## Error Analysis

### HTTP Status Distribution

| Status | Count | % | Trend | Action |
|--------|-------|---|-------|--------|
| 200 | 18.2M | 89.2% | - | ✅ |
| 304 | 680K | 3.3% | - | ✅ Good client cache |
| **429** | **1.38M** | **6.8%** | ↑ | 🔴 **Rate limiting** |
| 404 | 536K | 2.6% | → | 🟡 Audit links |
| 500 | 3.1K | 0.015% | → | ✅ Low |

### 500 Error Breakdown

| Path | Count | % of 500s | Root Cause |
|------|-------|-----------|------------|
| `/live/invoke/vtex/actions/cart/simulation` | 1.4K | 45% | VTEX timeout |
| `/live/invoke/site/loaders/search` | 380 | 12% | Search API |

### Error Log Patterns

| Error Message | Count | Service | Action |
|---------------|-------|---------|--------|
| "Too Many Requests" | 1.2K | vtex | Add request dedup |
| "The operation was canceled" | 450 | catalog | Increase timeout |
| "TypeError: Cannot read..." | 85 | site | Fix code |

---

## Geographic Distribution

| Country | Requests | % | Expected? |
|---------|----------|---|-----------|
| Brazil | 18.5M | 90.7% | ✅ Primary market |
| USA | 500K | 2.4% | 🟡 Could be CDN/bots |
| Unknown | 380K | 1.9% | 🟡 Review |
| ... | ... | ... | ... |

---

## Recommendations

### 🔴 High Priority

| # | Issue | Impact | Fix |
|---|-------|--------|-----|
| 1 | 23% requests have unknown cache | Wasted bandwidth | Add `export const cache` to loaders |
| 2 | 6.8% hitting rate limits | User errors | Implement request deduplication |
| 3 | SimilarProducts 0% cache | High latency | Add SWR cache |

### 🟡 Medium Priority

| # | Issue | Impact | Fix |
|---|-------|--------|-----|
| 4 | 2.6% 404 errors | SEO impact | Audit broken links |
| 5 | Cart simulation errors | Checkout drops | Add retry logic |

### 🟢 Low Priority

| # | Issue | Impact | Fix |
|---|-------|--------|-----|
| 6 | Non-BR traffic | Possible bots | Monitor, consider geo-blocking |

---

## Targets

| Metric | Current | Target | Gap | Priority |
|--------|---------|--------|-----|----------|
| Cache Hit Ratio | 42.8% | 80% | -37.2% | 🔴 |
| 429 Error Rate | 6.8% | <0.5% | -6.3% | 🔴 |
| Unknown Cache | 23% | <5% | -18% | 🔴 |
| 404 Error Rate | 2.6% | <2% | -0.6% | 🟡 |
```

## Example Queries

### Find pages with high miss rate
```
MONITOR_TOP_PATHS with filter:
filters: [{ type: "cache_status", operator: "equals", value: "miss" }]
```

### Find 5xx errors by path
```
MONITOR_TOP_PATHS with filter:
filters: [{ type: "status_code", operator: "contains", value: "5" }]
```

### Error trend over time
```
QUERY_CHART_DATA({
  series: [{
    dataSource: "events",
    aggFn: "count",
    where: "level:error site:mystore",
    groupBy: ["service"]
  }],
  granularity: "1 hour"
})
```

## Integration with deco-full-analysis

Use this skill after running `deco-full-analysis` to:

1. **Correlate** performance issues with specific loaders/sections
2. **Identify** which custom code paths are problematic
3. **Validate** that lazy loading is working correctly
4. **Verify** cache headers on custom loaders

## Best Practices

### Cache Headers for Loaders

```typescript
// loaders/myLoader.ts
export const cache = "stale-while-revalidate";
export const cacheKey = (props: Props) => `${props.id}`;
```

### Reducing API Calls

```typescript
// Use loader deduplication
// Same loader called multiple times = single fetch
export const cache = "stale-while-revalidate";
```

### Error Handling

```typescript
// Graceful degradation
try {
  const data = await fetch(url);
  return data;
} catch (e) {
  console.error("Fetch failed:", e);
  return fallbackData;
}
```
