# Analysis Scripts

Ready-to-use Python scripts for discovering optimal scaling parameters via Prometheus.

## Prerequisites

```bash
# Port-forward Prometheus
PROM_POD=$(kubectl get pods -n monitoring -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].metadata.name}')
kubectl port-forward -n monitoring $PROM_POD 19090:9090 &
```

## Script 1: Full Scaling Analysis

Collects all relevant metrics and produces a CPU vs latency correlation table.

**Usage:** Change `SITENAME` and run. Uses 12h of data by default.

```python
#!/usr/bin/env python3
"""Discover optimal scaling parameters for a Deco site."""
import json, urllib.request, urllib.parse, time
from datetime import datetime

PROM = "http://127.0.0.1:19090"
SITENAME = "CHANGE_ME"  # <-- Set this
NS = f"sites-{SITENAME}"
HOURS = 12
END = int(time.time())
START = END - HOURS * 3600

def prom_qr(query, step=120):
    params = urllib.parse.urlencode({"query": query, "start": START, "end": END, "step": step})
    with urllib.request.urlopen(f"{PROM}/api/v1/query_range?{params}") as r:
        return json.loads(r.read())

def prom_q(query):
    params = urllib.parse.urlencode({"query": query})
    with urllib.request.urlopen(f"{PROM}/api/v1/query?{params}") as r:
        return json.loads(r.read())

def to_map(data):
    m = {}
    for r in data['data']['result']:
        for ts, v in r['values']:
            try:
                f = float(v)
                if str(v) not in ('NaN', '+Inf', '-Inf'):
                    m[int(float(ts))] = f
            except: pass
    return m

# --- Current config ---
print("=" * 70)
print(f"SCALING ANALYSIS: {SITENAME} (last {HOURS}h)")
print("=" * 70)

target = prom_q(f'autoscaler_target_concurrency_per_pod{{namespace_name="{NS}"}}')
for r in target['data']['result']:
    print(f"  Current target: {r['value'][1]} conc/pod")

# --- Collect metrics ---
cpu = to_map(prom_qr(f'avg(rate(container_cpu_usage_seconds_total{{namespace="{NS}", container="app"}}[2m]))', 120))
# Fallback: try container="user-container" if "app" yields nothing
if not cpu:
    cpu = to_map(prom_qr(f'avg(rate(container_cpu_usage_seconds_total{{namespace="{NS}", container!="", container!="POD", container!="queue-proxy"}}[2m]))', 120))

pods_m = to_map(prom_qr(f'autoscaler_actual_pods{{namespace_name="{NS}"}}', 120))
conc_m = to_map(prom_qr(f'autoscaler_stable_request_concurrency{{namespace_name="{NS}"}}', 120))
panic_m = to_map(prom_qr(f'autoscaler_panic_mode{{namespace_name="{NS}"}}', 120))

# Try direct latency (requires queue-proxy PodMonitor)
lat_m = to_map(prom_qr(
    f'avg(rate(revision_app_request_latencies_sum{{namespace="{NS}"}}[2m]) / rate(revision_app_request_latencies_count{{namespace="{NS}"}}[2m]))', 120
))
has_latency = bool(lat_m)
if has_latency:
    print("  ✓ Direct latency metrics available (queue-proxy)")
else:
    print("  ✗ No direct latency metrics — using concurrency as proxy")

# --- Build data points ---
common = sorted(set(cpu.keys()) & set(pods_m.keys()) & set(conc_m.keys()))
points = []
for ts in common:
    c = cpu[ts]; p = pods_m[ts]; tc = conc_m[ts]
    if c > 0 and p > 0:
        points.append({
            'ts': ts, 'cpu_m': c * 1000, 'pods': p,
            'total_conc': tc, 'cpod': tc / p,
            'panic': panic_m.get(ts, 0),
            'lat_ms': lat_m.get(ts),
        })

if not points:
    print("  ERROR: No data points. Check namespace and metrics availability.")
    exit(1)

print(f"  Data points: {len(points)}")

# --- Panic events ---
panic_count = sum(1 for i in range(1, len(points)) if points[i]['panic'] == 1 and points[i-1]['panic'] == 0)
print(f"  Panic events: {panic_count}")

# --- Pod count stats ---
pod_vals = [p['pods'] for p in points]
print(f"  Pods: avg={sum(pod_vals)/len(pod_vals):.0f}, min={min(pod_vals):.0f}, max={max(pod_vals):.0f}")

# --- CPU per pod bucketed analysis ---
print(f"\n{'CPU range':>12}  {'Avg C/pod':>10}  {'P95 C/pod':>10}  {'Avg Pods':>9}  {'Points':>7}", end="")
if has_latency:
    print(f"  {'Avg Lat':>9}  {'P95 Lat':>9}", end="")
print()

cpu_buckets = [
    (0, 200, '0-200m'), (200, 300, '200-300m'), (300, 400, '300-400m'),
    (400, 500, '400-500m'), (500, 600, '500-600m'), (600, 700, '600-700m'),
    (700, 1500, '700m+'),
]

for lo, hi, label in cpu_buckets:
    bp = [p for p in points if lo <= p['cpu_m'] < hi]
    if bp:
        concs = sorted([p['cpod'] for p in bp])
        avg_c = sum(concs) / len(concs)
        p95_i = min(int(len(concs) * 0.95), len(concs) - 1)
        avg_pods = sum(p['pods'] for p in bp) / len(bp)
        line = f"  {label:>12}  {avg_c:10.1f}  {concs[p95_i]:10.1f}  {avg_pods:9.0f}  {len(bp):7}"
        if has_latency:
            lats = sorted([p['lat_ms'] for p in bp if p['lat_ms'] is not None])
            if lats:
                avg_l = sum(lats) / len(lats)
                p95_l = lats[min(int(len(lats) * 0.95), len(lats) - 1)]
                line += f"  {avg_l:8.1f}ms  {p95_l:8.1f}ms"
        print(line)

# --- Latency inflation factor ---
print(f"\nLatency inflation factor (excess > 1.0 = latency degrading):")
for threshold in [300, 350, 400, 450, 500, 550, 600]:
    below = [p for p in points if p['cpu_m'] < threshold]
    above = [p for p in points if p['cpu_m'] >= threshold]
    if below and above:
        avg_c_b = sum(p['cpod'] for p in below) / len(below)
        avg_c_a = sum(p['cpod'] for p in above) / len(above)
        avg_p_b = sum(p['pods'] for p in below) / len(below)
        avg_p_a = sum(p['pods'] for p in above) / len(above)
        conc_ratio = avg_c_a / avg_c_b if avg_c_b > 0 else 0
        pods_ratio = avg_p_b / avg_p_a if avg_p_a > 0 else 0
        excess = conc_ratio / pods_ratio if pods_ratio > 0 else 0
        marker = " ★ INFLECTION" if 1.3 < excess < 1.7 else ""
        print(f"  CPU <{threshold}m vs >={threshold}m: excess={excess:.2f}x{marker}")

# --- Recommendation ---
print(f"\n{'='*70}")
print("RECOMMENDATION")
print(f"{'='*70}")

# Find inflection: first threshold where excess drops below 1.5
inflection = None
for threshold in [300, 350, 400, 450, 500, 550, 600]:
    below = [p for p in points if p['cpu_m'] < threshold]
    above = [p for p in points if p['cpu_m'] >= threshold]
    if below and above:
        avg_c_b = sum(p['cpod'] for p in below) / len(below)
        avg_c_a = sum(p['cpod'] for p in above) / len(above)
        avg_p_b = sum(p['pods'] for p in below) / len(below)
        avg_p_a = sum(p['pods'] for p in above) / len(above)
        conc_ratio = avg_c_a / avg_c_b if avg_c_b > 0 else 0
        pods_ratio = avg_p_b / avg_p_a if avg_p_a > 0 else 0
        excess = conc_ratio / pods_ratio if pods_ratio > 0 else 0
        if excess < 1.5 and inflection is None:
            inflection = threshold

# Get CPU request
cpu_req = prom_q(f'kube_pod_container_resource_requests{{namespace="{NS}", container!="queue-proxy", resource="cpu"}}')
cpu_req_m = 0
for r in cpu_req['data']['result']:
    cpu_req_m = float(r['value'][1]) * 1000
    break

if inflection:
    print(f"  Latency inflection point: ~{inflection}m CPU")
    print(f"  CPU request: {cpu_req_m:.0f}m")
    print(f"  Recommended: CPU scaling at target={inflection} (millicores)")
    print(f"\n  SiteState scaling config:")
    print(f'    .scaling.metric = {{"type": "cpu", "target": {inflection}}}')
else:
    print("  No clear inflection found. Consider:")
    print("  - More data needed (run for 12-24h)")
    print("  - App may be IO-bound (keep concurrency scaling)")
    if panic_count > 0:
        print(f"  - {panic_count} panic events detected — consider switching to CPU scaling anyway to break the loop")
```

## Script 2: Post-Change Monitoring

Run after applying scaling changes to verify they're working.

```python
#!/usr/bin/env python3
"""Monitor scaling behavior after parameter change."""
import json, urllib.request, urllib.parse, time
from datetime import datetime

PROM = "http://127.0.0.1:19090"
SITENAME = "CHANGE_ME"  # <-- Set this
NS = f"sites-{SITENAME}"
END = int(time.time())
START = END - 2 * 3600  # last 2 hours

def prom_qr(query, step=60):
    params = urllib.parse.urlencode({"query": query, "start": START, "end": END, "step": step})
    with urllib.request.urlopen(f"{PROM}/api/v1/query_range?{params}") as r:
        return json.loads(r.read())

def to_map(data):
    m = {}
    for r in data['data']['result']:
        for ts, v in r['values']:
            try:
                f = float(v)
                if str(v) not in ('NaN', '+Inf', '-Inf'):
                    m[int(float(ts))] = f
            except: pass
    return m

cpu = to_map(prom_qr(f'avg(rate(container_cpu_usage_seconds_total{{namespace="{NS}", container="app"}}[2m]))'))
if not cpu:
    cpu = to_map(prom_qr(f'avg(rate(container_cpu_usage_seconds_total{{namespace="{NS}", container!="", container!="POD", container!="queue-proxy"}}[2m]))'))
pods_m = to_map(prom_qr(f'autoscaler_actual_pods{{namespace_name="{NS}"}}'))
panic_m = to_map(prom_qr(f'autoscaler_panic_mode{{namespace_name="{NS}"}}'))

common = sorted(set(cpu.keys()) & set(pods_m.keys()))

print(f"POST-CHANGE MONITORING: {SITENAME} (last 2h)")
print(f"{'Time':>6}  {'Pods':>5}  {'CPU/pod':>8}  {'Panic':>5}")
prev_pods = None
for ts in common:
    p = pods_m[ts]; c = cpu[ts] * 1000; pa = panic_m.get(ts, 0)
    t = datetime.fromtimestamp(ts).strftime('%H:%M')
    ps = "PANIC" if pa == 1 else ""
    change = ""
    if prev_pods and abs(p - prev_pods) >= 2:
        direction = "↑" if p > prev_pods else "↓"
        change = f" {direction}{abs(p-prev_pods):.0f}"
    print(f"  {t}  {p:5.0f}  {c:7.0f}m  {ps}{change}")
    prev_pods = p

# Summary
if common:
    pod_vals = [pods_m[ts] for ts in common]
    cpu_vals = [cpu[ts] * 1000 for ts in common]
    panics = sum(1 for i in range(1, len(common)) if panic_m.get(common[i], 0) == 1 and panic_m.get(common[i-1], 0) == 0)
    print(f"\n  Pods: avg={sum(pod_vals)/len(pod_vals):.0f}, min={min(pod_vals):.0f}, max={max(pod_vals):.0f}")
    print(f"  CPU/pod: avg={sum(cpu_vals)/len(cpu_vals):.0f}m, max={max(cpu_vals):.0f}m")
    print(f"  Panic events: {panics}")
    print(f"  Pod stability: {'STABLE' if max(pod_vals) - min(pod_vals) < 5 else 'OSCILLATING'}")

# Check for HPA (if using CPU scaling)
print(f"\nHPA status:")
import subprocess
try:
    result = subprocess.run(['kubectl', 'get', 'hpa', '-n', NS], capture_output=True, text=True)
    print(result.stdout if result.stdout else "  No HPA found (still using KPA?)")
except:
    print("  Could not check HPA")
```
