---
name: deco-site-scaling-tuning
description: Discover optimal autoscaling parameters for a Deco site by analyzing Prometheus metrics. Correlates CPU, concurrency, and latency to find the right scaling target and method.
---

# Deco Site Scaling Tuning

Analyze a site's Prometheus metrics to discover the optimal autoscaling parameters. This skill helps you find the CPU/concurrency threshold where latency degrades and recommends scaling configuration accordingly.

## When to Use This Skill

- A site is overscaled (too many pods for its traffic)
- A site oscillates between scaling up and down (panic mode loop)
- Need to switch scaling metric (concurrency vs CPU vs RPS)
- Need to find the right target value for a site
- After deploying scaling changes, to verify they're working

## Prerequisites

- `kubectl` access to the target cluster
- Prometheus accessible via port-forward (from `kube-prometheus-stack` in monitoring namespace)
- Python 3 for analysis scripts
- At least 6 hours of metric history for meaningful analysis
- **For direct latency data**: queue-proxy PodMonitor must be applied (see Step 0)

## Quick Start

```
0. ENABLE METRICS   → Apply queue-proxy PodMonitor if not already done
1. PORT-FORWARD     → kubectl port-forward prometheus-pod 19090:9090
2. COLLECT DATA     → Run analysis scripts against Prometheus
3. ANALYZE          → Find CPU threshold where latency degrades
4. RECOMMEND        → Choose scaling metric and target
5. APPLY            → Use deco-site-deployment skill to apply changes
6. VERIFY           → Monitor for 1-2 hours after change
```

## Files in This Skill

| File | Purpose |
|------|---------|
| `SKILL.md` | Overview, methodology, analysis procedures |
| `analysis-scripts.md` | Ready-to-use Python scripts for Prometheus queries |

## Step 0: Enable Queue-Proxy Metrics (one-time)

Queue-proxy runs as a sidecar on every Knative pod and exposes request latency histograms. These are critical for precise tuning but are **not scraped by default**.

Apply this PodMonitor:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: knative-queue-proxy
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  namespaceSelector:
    any: true
  selector:
    matchExpressions:
      - key: serving.knative.dev/revision
        operator: Exists
  podMetricsEndpoints:
    - port: http-usermetric
      path: /metrics
      interval: 15s
```

```bash
kubectl apply -f queue-proxy-podmonitor.yaml
# Wait 2-3 hours for data to accumulate before running latency analysis
```

**Metrics unlocked by this PodMonitor:**
- `revision_app_request_latencies_bucket` — request latency histogram (p50/p95/p99)
- `revision_app_request_latencies_sum` / `_count` — for avg latency
- `revision_app_request_count` — request rate by response code

## Step 1: Establish Prometheus Connection

```bash
PROM_POD=$(kubectl get pods -n monitoring -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].metadata.name}')
kubectl port-forward -n monitoring $PROM_POD 19090:9090 &
# Verify
curl -s "http://127.0.0.1:19090/api/v1/query?query=up" | jq '.status'
```

## Step 2: Collect Current State

Before analyzing, understand what the site is currently configured for.

### 2a. Read current autoscaler config

```bash
SITENAME="<sitename>"
NS="sites-${SITENAME}"

# Current revision annotations
kubectl get rev -n $NS -o json | \
  jq '.items[] | select(.status.conditions[]?.status == "True" and .status.conditions[]?.type == "Active") |
  {name: .metadata.name, annotations: .metadata.annotations | with_entries(select(.key | startswith("autoscaling")))}'

# Global autoscaler defaults
kubectl get cm config-autoscaler -n knative-serving -o json | jq '.data | del(._example)'
```

### 2b. Current pod count and resources

```bash
kubectl get pods -n $NS --no-headers | wc -l
kubectl top pods -n $NS --no-headers | head -20
```

## Step 3: Run Analysis

Use the scripts in `analysis-scripts.md`. The analysis follows this methodology:

### Methodology: Finding the Optimal CPU Target

**Goal:** Find the CPU level at which latency starts to degrade. This is your scaling target — keep pods below this CPU to maintain good latency.

**Approach:**

1. **Collect CPU per pod, concurrency per pod, pod count, and (if available) request latency** over 6-12 hours
2. **Bucket data by CPU range** (0-200m, 200-300m, ..., 700m+)
3. **For each bucket**, compute avg/p95 concurrency per pod
4. **Compute the "latency inflation factor"** — how much concurrency increases beyond what the pod count reduction explains:
   ```
   excess = (avg_conc_above_threshold / avg_conc_below_threshold) / (avg_pods_below / avg_pods_above)
   ```
   - excess = 1.0 → concurrency increase fully explained by fewer pods (no latency degradation)
   - excess > 1.0 → latency is inflating concurrency (pods are slowing down)
   - The CPU level where excess crosses ~1.5x is your inflection point

5. **If queue-proxy latency is available**, directly plot avg latency vs CPU — the hockey stick inflection is your target

### What to Look For

```
CPU vs Concurrency/pod:

  Low CPU   (0-200m)   →  Low conc/pod   →  Pods are idle (overprovisioned)
  Medium CPU (200-400m) →  Moderate conc  →  Healthy range
  ★ INFLECTION ★       →  Conc jumps      →  Latency starting to degrade
  High CPU  (500m+)    →  High conc/pod   →  Pods overloaded, latency bad
```

The inflection point is where you want your scaling target.

### Decision Matrix

**IMPORTANT:** CPU target is in **millicores** (not percentage). E.g., `target: 400` means scale when CPU reaches 400m.

| Inflection CPU | Recommended metric | Target | Notes |
|---------------|-------------------|--------|-------|
| < CPU request | CPU scaling | target = inflection value in millicores | Standard case |
| ~ CPU request | CPU scaling | target = CPU_request × 0.8 | Conservative |
| > CPU request (no limit) | CPU scaling | target = CPU_request × 0.8, increase CPU request | Need more CPU headroom |
| No clear inflection | Concurrency scaling | Keep current but tune target | CPU isn't the bottleneck |

### Common Patterns

**Pattern: CPU-bound app (Deno SSR)**
- Baseline CPU: 200-300m (Deno runtime + V8 JIT)
- Inflection: 400-500m
- Recommendation: CPU scaling with target = inflection (e.g., 400 millicores)

**Pattern: IO-bound app (mostly external API calls)**
- CPU stays low even under high concurrency
- Inflection not visible in CPU
- Recommendation: Keep concurrency scaling, tune the target

**Pattern: Oscillating (panic loop)**
- Symptoms: pods cycle between min and max
- Cause: concurrency scaling + low target + `scale-down-delay` ratchet
- Fix: Switch to CPU scaling (breaks the latency→concurrency feedback loop)

## Step 4: Apply Changes

Use the `deco-site-deployment` skill to:
1. Update the `state` secret with new scaling config
2. Redeploy on both clouds

Example for CPU-based scaling (target is in millicores):
```bash
NEW_STATE=$(echo "$STATE" | jq '
  .scaling.metric = {
    "type": "cpu",
    "target": 400
  }
')
```

## Step 5: Verify After Change

Monitor for 1-2 hours after applying changes:

```bash
# Watch pod count stabilize
watch -n 10 "kubectl get pods -n sites-<sitename> --no-headers | wc -l"

# Check if panic mode triggers (should be N/A for HPA/CPU)
# HPA doesn't have panic mode — this is one of the advantages

# Verify HPA is active
kubectl get hpa -n sites-<sitename>

# Check HPA status
kubectl describe hpa -n sites-<sitename>
```

### Success Criteria

- Pod count stabilizes (no more oscillation)
- Avg CPU per pod stays below your target during normal traffic
- CPU crosses target only during genuine traffic spikes (and scales up proportionally)
- No panic mode events (HPA doesn't have panic mode)
- Latency stays acceptable (check with queue-proxy metrics if available)

### Rollback

If the new scaling is worse, revert by changing the state secret back to concurrency scaling:
```bash
NEW_STATE=$(echo "$STATE" | jq '
  .scaling.metric = {
    "type": "concurrency",
    "target": 15,
    "targetUtilizationPercentage": 70
  }
')
```

## Related Skills

- `deco-site-deployment` — Apply scaling changes and redeploy
- `deco-site-memory-debugging` — Debug memory issues on running pods
- `deco-incident-debugging` — Incident response and triage
