# Headless Mode - Autonomous Incident Investigation

This mode is designed for **automated triggering** from incident management systems. The agent receives minimal context and must autonomously discover, investigate, and propose solutions without human interaction.

## Trigger Input Format

The incident management system should provide a structured input:

```json
{
  "site": "storename",
  "hostname": "www.storename.com.br",
  "alert_type": "error_spike | latency | availability | rate_limit | custom",
  "alert_message": "Error rate exceeded 5% threshold",
  "alert_source": "hyperdx | cloudflare | uptime | custom",
  "started_at": "2026-02-03T22:30:00Z",
  "severity": "critical | high | medium | low",
  "metadata": {
    "error_sample": "TypeError: Cannot read property 'x' of undefined",
    "affected_path": "/product/123/p",
    "error_count": 150,
    "timeframe_minutes": 5
  }
}
```

**Minimum required fields**: `site`, `alert_type`, `alert_message`

## Autonomous Investigation Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 1: CONTEXT GATHERING (autonomous)                        │
│  - Parse alert input                                            │
│  - Extract keywords from alert_message                          │
│  - Determine investigation scope                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 2: LEARNINGS SCAN (parallel)                             │
│  - Search learnings/ by extracted keywords                      │
│  - Match alert_type to learning categories                      │
│  - Score matches by symptom similarity                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 3: LIVE DATA COLLECTION (parallel)                       │
│  - Pull error logs from HyperDX                                 │
│  - Pull CDN metrics from monitoring                             │
│  - Check recent deployments                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 4: CORRELATION & DIAGNOSIS                               │
│  - Match live data patterns to learnings                        │
│  - Identify root cause hypothesis                               │
│  - Determine confidence level                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 5: OUTPUT REPORT                                         │
│  - Generate structured findings                                 │
│  - Propose solutions with confidence                            │
│  - Suggest next actions                                         │
└─────────────────────────────────────────────────────────────────┘
```

## Phase 1: Context Gathering

**Extract investigation parameters from alert:**

```python
# Pseudo-code for context extraction
def extract_context(alert):
    context = {
        "site": alert.site,
        "hostname": alert.hostname or f"{alert.site}.deco.site",
        "timeframe": {
            "start": alert.started_at - 30min,  # Look back 30min before alert
            "end": "now"
        },
        "keywords": extract_keywords(alert.alert_message),
        "alert_category": map_alert_to_category(alert.alert_type)
    }
    return context
```

**Alert type to category mapping:**

| Alert Type | Investigation Focus | Primary Learnings Category |
|------------|--------------------|-----------------------------|
| `error_spike` | Error logs, stack traces | `block-config`, `loader-optimization` |
| `latency` | CDN metrics, cache rates | `cache-strategy`, `loader-optimization` |
| `availability` | Health checks, deployments | `migration`, `block-config` |
| `rate_limit` | API call volume, cache | `cache-strategy`, `loader-optimization` |
| `custom` | Keyword extraction from message | All categories |

**Keyword extraction patterns:**

```javascript
// Extract actionable keywords from error messages
const KEYWORD_PATTERNS = [
  /(\d{3})\s*(error|response)/i,           // HTTP status codes
  /(timeout|timed out)/i,                   // Timeouts
  /(cannot read|undefined|null)/i,          // JS errors
  /(vtex|shopify|wake)/i,                   // Platform names
  /(cache|cached)/i,                        // Cache issues
  /(loader|section|action)/i,               // Deco components
  /(rate limit|too many|429)/i,             // Rate limiting
  /\/([a-z-]+)\.(ts|tsx)/i,                 // File paths
];
```

## Phase 2: Learnings Scan

**Parallel search strategy:**

```bash
# Run these searches in parallel
SEARCHES=(
  "grep -ri '${KEYWORD_1}' learnings/"
  "grep -ri '${KEYWORD_2}' learnings/"
  "grep -ri '${ALERT_CATEGORY}' learnings/"
  "grep -ri '${ERROR_CODE}' learnings/"
)

# Execute all and collect results
parallel ::: "${SEARCHES[@]}"
```

**Scoring algorithm:**

| Match Type | Score | Example |
|------------|-------|---------|
| Exact error message match | +10 | "429" in alert matches "429" in learning |
| Category match | +5 | `rate_limit` alert matches `cache-strategy` learning |
| Keyword in symptoms section | +3 | "slow" in alert, "slow" in learning symptoms |
| Keyword anywhere in learning | +1 | General term match |

**Select top 3 learnings by score for detailed review.**

## Phase 3: Live Data Collection

**Execute these data gathering operations in parallel:**

### 3a. Error Logs (HyperDX)

```javascript
// Search recent errors for this site
SEARCH_LOGS({
  query: `level:error site:${site}`,
  startTime: timeframe.start,
  endTime: timeframe.end,
  limit: 100
})

// Group errors by message
GET_LOG_DETAILS({
  query: `level:error site:${site}`,
  groupBy: ["body", "service"],
  startTime: timeframe.start,
  endTime: timeframe.end
})
```

### 3b. CDN Metrics

```javascript
// Overall health
MONITOR_SUMMARY({
  sitename: site,
  hostname: hostname,
  startDate: timeframe.start.toDateString(),
  endDate: timeframe.end.toDateString(),
  granularity: "hourly"
})

// Error breakdown
MONITOR_STATUS_CODES({ ...baseParams })

// Cache effectiveness
MONITOR_CACHE_STATUS({ ...baseParams })

// Hot paths (if latency alert)
MONITOR_TOP_PATHS({ ...baseParams })
```

### 3c. Recent Changes

```bash
# Check for recent deployments (if repo access available)
git log --oneline --since="${timeframe.start}" --until="${timeframe.end}"

# Check for config changes
git diff HEAD~10 -- .deco/blocks/
```

## Phase 4: Correlation & Diagnosis

**Pattern matching rules:**

```yaml
rules:
  - name: "Rate Limit - Missing Cache"
    conditions:
      - alert_type: rate_limit
      - cache_hit_rate: < 50%
      - top_errors_contain: "429"
    diagnosis: "Loaders missing cache configuration causing API overload"
    confidence: high
    learning_match: cache-strategy-standardization-loaders.md

  - name: "Rate Limit - Overfetching"
    conditions:
      - alert_type: rate_limit
      - error_logs_contain: "Too Many Requests"
      - top_paths_contain: "/live/invoke"
    diagnosis: "Loaders fetching more data than needed"
    confidence: high
    learning_match: loader-overfetching-n-plus-problem.md

  - name: "Latency - Edge Cache Blocked"
    conditions:
      - alert_type: latency
      - cache_hit_rate: < 30%
      - paths_contain: "/deco/render"
      - headers_contain: "set-cookie"
    diagnosis: "VTEX cookies preventing edge caching of lazy sections"
    confidence: high
    learning_match: vtex-cookies-prevent-edge-caching.md

  - name: "Error Spike - Dangling Reference"
    conditions:
      - alert_type: error_spike
      - error_logs_contain: "dangling reference"
    diagnosis: "Block configuration references deleted component"
    confidence: very_high
    learning_match: dangling-block-references.md

  - name: "Error Spike - Type Error"
    conditions:
      - alert_type: error_spike
      - error_logs_contain: "TypeError"
      - error_logs_contain: "undefined"
    diagnosis: "Runtime type error - possible null/undefined access"
    confidence: medium
    learning_match: null  # May need code investigation

  - name: "Latency - Slow Loaders"
    conditions:
      - alert_type: latency
      - top_paths_latency: > 500ms
      - paths_contain: "/live/invoke"
    diagnosis: "Slow API responses or missing loader optimization"
    confidence: medium
    learning_match: loader-overfetching-n-plus-problem.md
```

**Confidence levels:**

| Level | Meaning | Action |
|-------|---------|--------|
| `very_high` | Exact match to known pattern | Auto-suggest fix |
| `high` | Strong correlation to learning | Recommend fix with verification |
| `medium` | Partial match, needs validation | Suggest investigation path |
| `low` | Weak signals, inconclusive | Escalate to human |

## Phase 5: Output Report

**Structured output format:**

```json
{
  "investigation_id": "inc-2026-02-03-001",
  "site": "storename",
  "alert_received": "2026-02-03T22:30:00Z",
  "investigation_completed": "2026-02-03T22:32:15Z",
  "duration_seconds": 135,
  
  "diagnosis": {
    "root_cause": "Loaders missing cache configuration causing repeated API calls",
    "confidence": "high",
    "matched_learning": "cache-strategy-standardization-loaders.md",
    "evidence": [
      "Cache hit rate: 23% (target: >80%)",
      "Top error: '429 Too Many Requests' (1,234 occurrences)",
      "Uncached paths: /live/invoke/vtex/loaders/productList (45K requests)"
    ]
  },
  
  "proposed_solution": {
    "summary": "Add stale-while-revalidate cache to high-volume loaders",
    "steps": [
      "Add `export const cache = 'stale-while-revalidate'` to loaders/productList.ts",
      "Add cacheKey function with product ID",
      "Deploy and monitor cache hit rate"
    ],
    "code_changes": [
      {
        "file": "loaders/productList.ts",
        "action": "add",
        "content": "export const cache = 'stale-while-revalidate';\nexport const cacheKey = (props) => `productList:${props.collection}`;"
      }
    ],
    "estimated_impact": "Reduce API calls by 60-70%, eliminate 429 errors"
  },
  
  "metrics_snapshot": {
    "total_requests": "2.1M",
    "error_rate": "6.8%",
    "cache_hit_rate": "23%",
    "p95_latency_ms": 450,
    "top_errors": [
      { "message": "429 Too Many Requests", "count": 1234 },
      { "message": "timeout", "count": 89 }
    ]
  },
  
  "next_actions": [
    {
      "action": "apply_fix",
      "confidence": "high",
      "requires_human": false
    },
    {
      "action": "monitor_post_deploy",
      "check": "cache_hit_rate > 70%",
      "timeout_minutes": 30
    }
  ],
  
  "escalation": {
    "required": false,
    "reason": null
  }
}
```

## Escalation Triggers

**Auto-escalate to human when:**

```yaml
escalation_rules:
  - condition: confidence < medium
    reason: "Unable to determine root cause with confidence"
  
  - condition: no_learning_match AND no_pattern_match
    reason: "Novel issue - not in knowledge base"
  
  - condition: severity == critical AND site_down
    reason: "Critical outage requires human oversight"
  
  - condition: fix_requires_platform_change
    reason: "Fix cannot be applied to site code"
  
  - condition: multiple_root_causes
    reason: "Complex incident with multiple contributing factors"
  
  - condition: data_collection_failed
    reason: "Unable to gather sufficient diagnostic data"
```

## Integration Examples

### PagerDuty Webhook

```json
{
  "event": {
    "event_type": "incident.triggered",
    "incident": {
      "title": "High error rate on www.storename.com.br",
      "urgency": "high",
      "custom_details": {
        "site": "storename",
        "hostname": "www.storename.com.br",
        "alert_type": "error_spike",
        "error_rate": "8.5%"
      }
    }
  }
}
```

### Opsgenie Alert

```json
{
  "alert": {
    "message": "Error rate threshold exceeded",
    "priority": "P1",
    "details": {
      "site": "storename",
      "metric": "error_rate",
      "value": "8.5%",
      "threshold": "5%"
    }
  }
}
```

### Slack Workflow Trigger

```
/debug-incident site:storename type:latency message:"Pages loading slowly"
```

## Output Destinations

The investigation report can be sent to:

| Destination | Format | Use Case |
|-------------|--------|----------|
| Slack | Formatted message | Real-time team notification |
| PagerDuty | Note on incident | Incident timeline |
| GitHub | Issue/PR | Automated fix proposal |
| Webhook | JSON | Custom integrations |
| File | Markdown | Audit trail |

### Slack Output Format

```
🔴 *Incident Investigation Complete*

*Site:* storename
*Duration:* 2m 15s
*Confidence:* HIGH

*Root Cause:*
Loaders missing cache configuration causing repeated API calls

*Evidence:*
• Cache hit rate: 23% (target: >80%)
• 429 errors: 1,234 in last 30min
• Top uncached: /live/invoke/vtex/loaders/productList

*Matched Learning:*
`cache-strategy-standardization-loaders.md`

*Proposed Fix:*
Add `export const cache = 'stale-while-revalidate'` to productList.ts

*Next Action:* Ready to apply fix (no human required)
```

## Autonomous Fix Application

**For high-confidence matches with code changes:**

```yaml
auto_fix_criteria:
  - confidence: very_high OR high
  - learning_match: exists
  - code_change: defined
  - risk_level: low  # No DB changes, no auth changes
  - rollback: possible  # Git-based deployment

auto_fix_workflow:
  1. Create branch: fix/incident-{id}
  2. Apply code changes from solution
  3. Run type check: deno check --unstable-tsgo
  4. Run block validation: deno run -A https://deco.cx/validate
  5. If checks pass:
     - Create PR with investigation report
     - Request auto-merge if enabled
  6. If checks fail:
     - Report failure reason
     - Escalate to human
```

## Monitoring & Feedback Loop

**Post-fix verification:**

```yaml
verification:
  wait: 10 minutes after deploy
  checks:
    - metric: error_rate
      condition: < alert_threshold
      action: mark_resolved
    
    - metric: cache_hit_rate
      condition: increased by 20%+
      action: confirm_fix_effective
    
    - metric: same_error_recurring
      condition: true
      action: escalate - fix ineffective
```

**Learning feedback:**

```yaml
feedback_loop:
  - if fix_effective:
      action: increment learning confidence score
  
  - if fix_ineffective:
      action: flag learning for review
      action: create follow-up investigation
  
  - if novel_issue_resolved:
      action: prompt for new learning creation
```
