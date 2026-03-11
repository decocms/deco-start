# MCP Tools Reference

Complete reference for all monitoring and logging tools available for performance audits.

---

## CDN Monitoring Tools

### MONITOR_SUMMARY

Get overall metrics for a site.

**Arguments**:
```json
{
  "sitename": "mystore",              // Required: Deco site name
  "hostname": "www.mystore.com",      // Required: Production hostname
  "startDate": "2026-01-17",          // Required: YYYY-MM-DD
  "endDate": "2026-01-18",            // Required: YYYY-MM-DD
  "granularity": "daily",             // Optional: "hourly" | "daily"
  "filters": []                       // Optional: array of filters
}
```

**Response**:
```json
{
  "data": {
    "total_requests": 20455942,
    "total_pageviews": 0,
    "total_bandwidth_bytes": 685685974398,
    "cache_hit_ratio": 42.81,
    "avg_latency_ms": 0,
    "status_2xx_count": 16010649,
    "status_4xx_count": 1925446,
    "status_5xx_count": 3460,
    "unique_countries": 152
  }
}
```

---

### MONITOR_TOP_PATHS

Get top URLs by requests or bandwidth.

**Arguments**:
```json
{
  "sitename": "mystore",
  "hostname": "www.mystore.com",
  "startDate": "2026-01-17",
  "endDate": "2026-01-18",
  "limit": 20,                        // Optional: max results
  "groupByPath": true,                // Optional: group by path pattern
  "granularity": "daily",
  "orderBy": "requests",              // Optional: "requests" | "bandwidth"
  "filters": []
}
```

**Response**:
```json
{
  "data": [
    {
      "url": "/live/invoke",
      "total_requests": 925584,
      "total_bandwidth_bytes": 2963108217,
      "percentage": 4.52
    }
  ]
}
```

---

### MONITOR_CACHE_STATUS

Get cache hit/miss breakdown.

**Arguments**:
```json
{
  "sitename": "mystore",
  "hostname": "www.mystore.com",
  "startDate": "2026-01-17",
  "endDate": "2026-01-18",
  "granularity": "daily",
  "filters": []
}
```

**Response**:
```json
{
  "data": [
    {
      "cache_status": "hit",
      "total_requests": 8757374,
      "total_bandwidth_bytes": 348934491674,
      "percentage": 42.81
    },
    {
      "cache_status": "miss",
      "total_requests": 6634696,
      "total_bandwidth_bytes": 235138161163,
      "percentage": 32.43
    }
  ],
  "total_requests": 20455942
}
```

**Cache Status Values**:
| Status | Meaning |
|--------|---------|
| hit | Served from cache |
| miss | Fetched from origin |
| expired | Cache expired, refetched |
| revalidated | Cache validated with origin |
| stale | Served stale while revalidating |
| updating | Being updated |
| unknown | No cache header present |

---

### MONITOR_STATUS_CODES

Get HTTP status code distribution.

**Arguments**:
```json
{
  "sitename": "mystore",
  "hostname": "www.mystore.com",
  "startDate": "2026-01-17",
  "endDate": "2026-01-18",
  "granularity": "daily",
  "filters": []
}
```

**Response**:
```json
{
  "data": [
    {
      "status_code": 200,
      "total_requests": 15971414,
      "total_bandwidth_bytes": 632787067140,
      "percentage": 84.14
    },
    {
      "status_code": 429,
      "total_requests": 1287109,
      "total_bandwidth_bytes": 13878179140,
      "percentage": 6.78
    }
  ],
  "total_requests": 18981459
}
```

---

### MONITOR_TOP_COUNTRIES

Get traffic by country.

**Arguments**:
```json
{
  "sitename": "mystore",
  "hostname": "www.mystore.com",
  "startDate": "2026-01-17",
  "endDate": "2026-01-18",
  "limit": 10,
  "granularity": "daily",
  "filters": []
}
```

**Response**:
```json
{
  "data": [
    {
      "country": "BR",
      "total_requests": 18500000,
      "total_bandwidth_bytes": 600000000000,
      "total_pageviews": 0,
      "percentage": 90.4
    }
  ],
  "total_requests": 20455942
}
```

---

### MONITOR_USAGE_TIMELINE

Get time series usage data.

**Arguments**:
```json
{
  "sitename": "mystore",
  "hostname": "www.mystore.com",
  "startDate": "2026-01-17",
  "endDate": "2026-01-18",
  "granularity": "hourly",
  "filters": []
}
```

**Response**:
```json
{
  "data": [
    {
      "timestamp": "2026-01-17T00:00:00Z",
      "total_requests": 850000,
      "total_bandwidth_bytes": 28000000000,
      "total_pageviews": 0,
      "cache_hit_ratio": 43.5
    }
  ]
}
```

---

## Filter Syntax

All MONITOR tools support filters:

```json
{
  "filters": [
    {
      "type": "cache_status",    // "cache_status" | "status_code" | "path" | "country"
      "operator": "equals",       // "equals" | "not_equals" | "contains" | "not_contains"
      "value": "miss"
    }
  ]
}
```

**Examples**:

```json
// Find uncached paths
{ "type": "cache_status", "operator": "equals", "value": "miss" }

// Find 5xx errors
{ "type": "status_code", "operator": "contains", "value": "5" }

// Find product pages
{ "type": "path", "operator": "contains", "value": "/p" }

// Exclude static assets
{ "type": "path", "operator": "not_contains", "value": "/_frsh/" }

// Traffic from Brazil
{ "type": "country", "operator": "equals", "value": "BR" }
```

---

## Error Logging Tools

### SEARCH_LOGS

Search error logs from HyperDX.

**Arguments**:
```json
{
  "query": "level:error site:mystore",     // Required: search query
  "startTime": 1737100800000,              // Optional: epoch ms
  "endTime": 1737187200000,                // Optional: epoch ms
  "limit": 50                              // Optional: max results
}
```

**Query Syntax**:
- `level:error` - Error level logs
- `level:warn` - Warning level
- `site:mystore` - Specific site
- `service:admin` - Specific service
- Combine: `level:error site:mystore service:api`

**Response**:
```json
{
  "logs": [
    {
      "message": "error sending request for url: ..., body error is: Too Many Requests",
      "count": 5
    }
  ],
  "total": 30
}
```

---

### GET_LOG_DETAILS

Get detailed log entries with custom grouping.

**Arguments**:
```json
{
  "query": "level:error site:mystore",
  "groupBy": ["body", "service", "site"],  // Fields to return
  "startTime": 1737100800000,
  "endTime": 1737187200000,
  "limit": 20
}
```

**Available groupBy fields**:
- `body` - Log message
- `service` - Service name
- `site` - Site name
- `trace_id` - Trace ID
- `span_id` - Span ID
- `userEmail` - User email
- `env` - Environment
- `level` - Log level

**Response**:
```json
{
  "fields": ["body", "service", "site"],
  "entries": [
    {
      "values": ["Too Many Requests error...", "casaevideo", "casaevideo"],
      "count": 5
    }
  ]
}
```

---

### QUERY_CHART_DATA

Query time series aggregations.

**Arguments**:
```json
{
  "startTime": 1737100800000,
  "endTime": 1737187200000,
  "granularity": "1 hour",  // See granularity options
  "series": [
    {
      "dataSource": "events",  // "events" | "metrics"
      "aggFn": "count",        // See aggregation functions
      "where": "level:error site:mystore",
      "groupBy": ["service"],
      "field": null            // Required for avg, sum, etc.
    }
  ],
  "seriesReturnType": "column"  // Optional: "column" | "ratio"
}
```

**Granularity Options**:
- `30 second`, `1 minute`, `5 minute`, `10 minute`, `15 minute`, `30 minute`
- `1 hour`, `2 hour`, `6 hour`, `12 hour`
- `1 day`, `2 day`, `7 day`, `30 day`

**Aggregation Functions**:
- `count` - Count events
- `count_distinct` - Count unique values
- `avg`, `sum`, `min`, `max` - Numeric aggregations (need `field`)
- `p50`, `p90`, `p95`, `p99` - Percentiles (need `field`)

**Response**:
```json
{
  "data": [
    {
      "ts_bucket": 1737100800000,
      "group": ["mystore"],
      "series_0.data": 6
    },
    {
      "ts_bucket": 1737104400000,
      "group": ["mystore"],
      "series_0.data": 101
    }
  ]
}
```

---

## Documentation Search

### SearchDecoCx

Search Deco.cx documentation.

**Arguments**:
```json
{
  "query": "caching loaders stale-while-revalidate"
}
```

**Response**:
Multiple documentation sections with:
- Title
- Link
- Content excerpt

**Use Cases**:
- Understand Deco patterns
- Find caching strategies
- Learn about loader optimization
- Understand section lifecycle
