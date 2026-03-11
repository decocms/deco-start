# 5-Whys Root Cause Analysis

A simple technique to find the true root cause of an incident by asking "Why?" repeatedly.

## How to Use

1. Start with the problem statement
2. Ask "Why did this happen?"
3. For each answer, ask "Why?" again
4. Continue until you reach a root cause (usually 5 iterations)
5. Stop when you reach something actionable

## Example: Cross-Tenant Routing

```
Problem: Customer A's site showed Customer B's content

Why 1: Why did Customer A see Customer B's content?
→ Because the routing rules sent traffic to the wrong backend

Why 2: Why were routing rules pointing to wrong backend?
→ Because the Envoy proxy was using stale/outdated configuration

Why 3: Why was Envoy using stale configuration?
→ Because it couldn't receive new config updates from istiod

Why 4: Why couldn't it receive config updates?
→ Because the gRPC message exceeded the 4MB size limit

Why 5: Why was the message over 4MB?
→ Because we have 14,000 services and the default limit was never adjusted for our scale

ROOT CAUSE: Infrastructure configuration not updated to match platform scale
```

## Example: Memory-Related 502 Errors

```
Problem: 2% of requests returned 502 during traffic spike

Why 1: Why did requests return 502?
→ Because the application pods were killed/restarted

Why 2: Why were pods killed?
→ Because they exceeded memory limits (OOMKilled)

Why 3: Why did they exceed memory limits?
→ Because traffic increased 150x (200 → 30k req/min) and memory usage scaled with connections

Why 4: Why didn't we scale before hitting limits?
→ Because HPA was based on CPU, not memory, and CPU didn't spike proportionally

Why 5: Why wasn't memory included in scaling metrics?
→ Because we hadn't profiled memory behavior under high-concurrency scenarios

ROOT CAUSE: Autoscaling configuration not calibrated for memory-intensive traffic patterns
```

## Tips

- **Don't stop at symptoms** - "The server crashed" is a symptom, not a cause
- **Don't blame people** - "John didn't check" → "The checklist didn't include this verification"
- **Multiple branches are OK** - Complex incidents often have multiple contributing root causes
- **Actionable = root cause** - If you can write a TODO to fix it, you've found the root cause

## Common Root Cause Categories

| Category | Example Root Causes |
|----------|-------------------|
| **Configuration** | Defaults not adjusted for scale, missing limits |
| **Monitoring** | No alert for this failure mode, wrong thresholds |
| **Process** | No runbook, unclear ownership, missing checklist |
| **Architecture** | Single point of failure, no circuit breaker |
| **Testing** | Edge case not covered, no load testing |
| **Documentation** | Outdated docs, tribal knowledge not written down |
