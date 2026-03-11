---
name: incident-report
description: Create incident reports and post-mortems for platform issues. Supports both internal technical reports and client-facing communications. Use when documenting outages, security vulnerabilities, data leaks, performance degradation, or any production incident.
---

# Incident Report Skill

Generate comprehensive incident reports and post-mortems following team standards. Supports two report types: internal technical analysis and client-facing communications.

## Quick Start

1. **Classify** the incident (severity, type, audience)
2. **Gather** information using the discovery prompts
3. **Generate** the appropriate report using templates
4. **Review** using the checklist

## Phase 1: Classification

### Severity Levels

| Level | Criteria | Response Time |
|-------|----------|---------------|
| **P0 Critical** | Data breach, cross-tenant exposure, complete outage | Immediate |
| **P1 High** | Partial outage, significant performance degradation, security vulnerability | < 1 hour |
| **P2 Medium** | Degraded service, non-critical feature down | < 4 hours |
| **P3 Low** | Minor issue, cosmetic, workaround available | Next business day |

### Incident Types

- **Outage**: Service unavailable or severely degraded
- **Security**: Vulnerability, unauthorized access, data exposure
- **Data Leak**: Customer data exposed to wrong party
- **Performance**: Latency spikes, memory issues, 5xx errors
- **Configuration**: Misconfig causing issues, deployment failures

### Report Audience

| Audience | Report Type | Focus |
|----------|-------------|-------|
| **Internal** | Technical post-mortem | Root cause, technical details, action items |
| **Client** | Customer communication | Impact, resolution, prevention, reassurance |

## Phase 2: Information Gathering

Before writing, gather these details. Ask the user if any are missing:

### Core Facts (Required)

```
- Incident date and time (with timezone)
- Duration of impact
- Affected systems/services
- Affected customers/sites
- Who detected it (monitoring, customer report, internal)
- Current status (ongoing, resolved, monitoring)
```

### Technical Details (Internal Reports)

```
- What was the root cause?
- What was the timeline? (detection → investigation → fix → verification)
- What commands/logs showed the issue?
- What was the fix applied?
- Were there any secondary effects?
```

### Impact Assessment

```
- Number of affected requests/users
- Error rates (percentage)
- Revenue impact (if applicable)
- Data exposure scope (if security/data leak)
- Customer complaints received
```

### Resolution Details

```
- What immediate fix was applied?
- Who was involved in resolution?
- How was the fix verified?
- Are there follow-up actions needed?
```

## Phase 3: Generate Report

### Internal Technical Report

Use template: [templates/internal-report.md](templates/internal-report.md)

Structure:
1. **TL;DR** - 3-5 bullet summary for busy readers
2. **Executive Summary** - One paragraph overview
3. **Timeline** - Chronological events
4. **Root Cause Analysis** - Technical deep-dive
5. **Impact** - Quantified effects
6. **Resolution** - What was done
7. **Action Items** - TODO list with owners
8. **Lessons Learned** - Blameless retrospective
9. **References** - Links, logs, PRs

### Client-Facing Report

Use template: [templates/client-report.md](templates/client-report.md)

Structure:
1. **Subject Line** - Clear, professional
2. **Acknowledgment** - We take this seriously
3. **What Happened** - Non-technical explanation
4. **Impact on You** - Specific to this client
5. **Resolution** - What we did
6. **Prevention** - What we're doing to prevent recurrence
7. **Contact** - Who to reach for questions

## Phase 4: Review Checklist

Before finalizing, verify:

### Content Quality
- [ ] Timeline is accurate and complete
- [ ] Root cause is clearly identified (not symptoms)
- [ ] Impact is quantified with real numbers
- [ ] Action items have owners and priorities
- [ ] No blame assigned to individuals

### Client Reports Additional
- [ ] Technical jargon removed or explained
- [ ] Tone is professional and empathetic
- [ ] Next steps are clear
- [ ] Contact information included
- [ ] Client-specific impact addressed

### Security Incidents Additional
- [ ] Scope of exposure documented
- [ ] Affected data types listed
- [ ] Customer notification requirements checked
- [ ] Compliance implications noted (LGPD, GDPR)

## Blameless Post-Mortem Principles

1. **Focus on systems, not people** - "The monitoring gap allowed..." not "John failed to..."
2. **Assume good intent** - Everyone was trying to do the right thing
3. **Learn, don't punish** - Goal is improvement, not blame
4. **Be specific** - "Deploy at 14:32 caused..." not "Recent changes caused..."
5. **Quantify impact** - "2% of 30k requests = 600 errors" not "some errors"

## Writing Tips

### For Internal Reports
- Be technically precise
- Include actual commands, logs, configs
- Link to related PRs, issues, dashboards
- Use diagrams for complex flows

### For Client Reports
- Lead with resolution/status
- Avoid defensive language
- Be specific about prevention measures
- Keep under 500 words unless complex
- Translate technical terms

## File Naming Convention

```
{slug}-{YYYY-MM-DD}.md

Examples:
- istio-xds-message-overflow-2026-02-03.md
- openbox2-traffic-spike-502-2026-02-05.md
- aviator-cross-tenant-routing-2026-02-03.md
```

## Additional Resources

- [templates/internal-report.md](templates/internal-report.md) - Full internal template
- [templates/client-report.md](templates/client-report.md) - Client communication template
- [references/5-whys.md](references/5-whys.md) - Root cause analysis technique
