# Internal Incident Report Template

Copy and fill in this template for technical post-mortems.

---

```markdown
# Incident: [Brief Descriptive Title]

**Date of incident:** YYYY-MM-DD  
**Severity:** [P0 Critical | P1 High | P2 Medium | P3 Low]  
**Type:** [Outage | Security | Data Leak | Performance | Configuration]  
**Affected systems:** [List systems, clusters, services]  
**Root cause:** [One-line summary]  
**Impact:** [One-line impact summary]

---

## TL;DR - Critical Information

### What Happened
1. [First key point]
2. [Second key point]
3. [Third key point]

### Immediate Fix Applied
```code
[The fix that resolved the issue]
```

### Why This Matters
- [Business/security implication 1]
- [Business/security implication 2]

---

## Executive Summary

[One paragraph (3-5 sentences) explaining what happened, what caused it, what was the impact, and how it was resolved. Written for someone who will only read this section.]

---

## Timeline

All times in UTC-3 (São Paulo).

| Time | Event |
|------|-------|
| HH:MM | [Detection: How was the issue detected?] |
| HH:MM | [Investigation: First investigative action] |
| HH:MM | [Escalation: Who was brought in?] |
| HH:MM | [Identification: Root cause identified] |
| HH:MM | [Mitigation: Temporary fix applied] |
| HH:MM | [Resolution: Permanent fix deployed] |
| HH:MM | [Verification: Confirmed resolution] |

**Total duration:** X hours Y minutes  
**Time to detection:** X minutes  
**Time to resolution:** X hours Y minutes

---

## Root Cause Analysis

### The Problem

[Detailed technical explanation of what went wrong. Include architecture context if needed.]

### Why It Happened

[Use 5-Whys or similar technique]

1. **Why** did [symptom]? → Because [cause 1]
2. **Why** did [cause 1]? → Because [cause 2]
3. **Why** did [cause 2]? → Because [cause 3]
4. **Why** did [cause 3]? → Because [root cause]

### Contributing Factors

- [Factor 1 - e.g., missing monitoring]
- [Factor 2 - e.g., configuration drift]
- [Factor 3 - e.g., insufficient testing]

---

## Impact Assessment

### Quantified Impact

| Metric | Value |
|--------|-------|
| Duration | X hours |
| Affected requests | X / Y total (Z%) |
| Error rate | X% |
| Affected customers | X sites |
| Revenue impact | [If applicable] |

### Affected Customers

[List specific customers if known, or describe the affected segment]

### Data Exposure (if applicable)

- **Data types exposed:** [List specific data types]
- **Exposure scope:** [Who could see what]
- **Duration of exposure:** [Time window]

---

## Resolution

### Immediate Fix

[What was done to stop the bleeding]

```yaml
# Configuration change, command, or code
[Actual fix applied]
```

### Verification Steps

```bash
# Commands used to verify the fix
[Verification commands]
```

### Rollback Plan (if applicable)

[How to undo the fix if it causes issues]

---

## Action Items

### Priority 1: Critical (This Week)

| Action | Owner | Status | Due |
|--------|-------|--------|-----|
| [Action 1] | @name | TODO | YYYY-MM-DD |
| [Action 2] | @name | TODO | YYYY-MM-DD |

### Priority 2: High (This Sprint)

| Action | Owner | Status | Due |
|--------|-------|--------|-----|
| [Action 3] | @name | TODO | YYYY-MM-DD |

### Priority 3: Medium (This Quarter)

| Action | Owner | Status | Due |
|--------|-------|--------|-----|
| [Action 4] | @name | TODO | YYYY-MM-DD |

---

## Lessons Learned

### What Went Well
- [Positive 1 - e.g., quick detection]
- [Positive 2 - e.g., effective communication]

### What Could Be Improved
- [Improvement 1]
- [Improvement 2]

### Process Gaps Identified
- [Gap 1 - e.g., no runbook existed]
- [Gap 2 - e.g., monitoring blind spot]

---

## Monitoring & Alerting

### Existing Alerts (that fired or should have)

| Alert | Status | Notes |
|-------|--------|-------|
| [Alert name] | [Fired/Did not fire] | [Why] |

### New Alerts Needed

```yaml
# Prometheus/Grafana alert definition
[Alert configuration]
```

---

## References

- **Slack thread:** [link]
- **Related PRs:** [links]
- **Logs:** [link to log explorer query]
- **Dashboard:** [link to relevant dashboard]
- **Related incidents:** [links to similar past incidents]

---

## Document History

| Date | Author | Changes |
|------|--------|---------|
| YYYY-MM-DD | [Name] | Initial draft |
| YYYY-MM-DD | [Name] | Added [section] |
```
