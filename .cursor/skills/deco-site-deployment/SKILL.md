---
name: deco-site-deployment
description: Manage Deco site configuration (env vars, scaling, resources) via the Kubernetes state secret and trigger redeployment. Handles multi-cloud deployment across AWS and GCP clusters.
---

# Deco Site Deployment

Manage a Deco site's configuration and trigger redeployment. Each site has a `state` secret in its Kubernetes namespace that controls env vars, scaling rules, resources, and more. Changing this secret and triggering a redeploy applies the new configuration.

## When to Use This Skill

- Change environment variables for a site
- Adjust autoscaler settings (min/max scale, concurrency target)
- Modify resource requests/limits (CPU, memory)
- Trigger a redeployment of a site
- Debug what configuration a site is currently running with

## Prerequisites

- `kubectl` access to the target cluster
- `ADMIN_API_KEY` environment variable set (ask the user to set it if missing)
- `jq` and `base64` CLI tools

## Quick Start

```
1. ASK USER        → Which cluster to target? (ask every time)
2. READ STATE      → kubectl get secret state -n sites-<sitename> → decode
3. MODIFY          → Change the desired fields in the JSON
4. WRITE STATE     → Encode and patch the secret on the TARGET cluster
5. REDEPLOY        → POST to admin.deco.cx AND admin-gcp.deco.cx
6. VERIFY          → Check pods are rolling out with new config
```

## Files in This Skill

| File | Purpose |
|------|---------|
| `SKILL.md` | Overview, SiteState schema, procedures |

## Important: Multi-Cloud Architecture

Deco runs on multiple clouds. **Always ask the user which cluster to target** before making changes.

**Known clusters:**

| Cloud | Context | Admin endpoint |
|-------|---------|---------------|
| AWS | `arn:aws:eks:sa-east-1:578348582779:cluster/eks-cluster-eksCluster-ea385ba` | `https://admin.deco.cx` |
| GCP | `gke_gke-cluster-453314_us-east1_sites` | `https://admin-gcp.deco.cx` |

**Workflow:**

1. **Ask the user** which cluster(s) to target
2. **Change the secret** on the target cluster(s) — switch kubectl context accordingly
3. **Trigger redeploy** on **both** admin endpoints (AWS and GCP) — the deployer on each cloud reads its own cluster's state secret and applies it:
   - `https://admin.deco.cx` (reads from AWS cluster)
   - `https://admin-gcp.deco.cx` (reads from GCP cluster)

If the change should apply to both clouds, you must patch the secret on **both** clusters before triggering redeploy.

## Important: ADMIN_API_KEY

The deploy endpoint requires authentication via `x-api-key` header. **Never hardcode the key.** Always read it from the `ADMIN_API_KEY` environment variable:

```bash
if [ -z "$ADMIN_API_KEY" ]; then
  echo "ERROR: Set the ADMIN_API_KEY environment variable first"
  exit 1
fi
```

If the user hasn't set it, ask them to:
```
export ADMIN_API_KEY="<your-api-key>"
```

## SiteState Schema

The `state` secret contains a single key `state` with base64-encoded JSON matching the `SiteState` interface:

```typescript
interface SiteState {
  // Source code reference
  source?: {
    type: "github";
    repo: string;
    owner: string;
    commitSha: string;
  };
  deploymentId?: string;

  // Environment variables
  envVars?: Array<{ name: string; value: string }>;

  // Autoscaling
  scaling?: {
    initialScale?: number;
    minScale?: number;
    maxScale?: number;
    retentionPeriod?: string;  // e.g. "20m"
    metric?: ScaleMetric;
  };

  // Resource requests and limits
  resources?: {
    requests?: { memory?: string; cpu?: string; "ephemeral-storage"?: string };
    limits?: { memory?: string; cpu?: string; "ephemeral-storage"?: string };
  };

  // Caching
  caching?: {
    implementations?: Array<
      | { type: "FILE_SYSTEM"; directory: string; maxSize: number; maxItems: number }
      | { type: "CACHE_API" }
      | { type: "REDIS"; url: string }
    >;
    loaderCacheStartThreshold?: number;
  };

  // Domain bindings
  domains?: Array<{ url: string; production?: boolean; validated?: boolean }>;

  // Runtime
  entrypoint?: string;     // defaults to main.ts
  runArgs?: string;
  runnerImage?: string;
  builderImage?: string;

  // Advanced: volumes, node selection, tolerations, affinity
  volumes?: k8s.V1Volume[];
  volumeMounts?: k8s.V1VolumeMount[];
  nodeSelector?: Record<string, string>;
  tolerations?: k8s.V1Toleration[];
  nodeAffinity?: k8s.V1NodeAffinity;

  // Feature flags
  features?: { usesDecofileHotSwap?: boolean };
}
```

### ScaleMetric Types

```typescript
// Concurrency-based (default, uses Knative KPA)
{ type: "concurrency"; target: number; targetUtilizationPercentage?: number }

// RPS-based (uses Knative KPA)
{ type: "rps"; target: number }

// CPU-based (uses Knative HPA)
// IMPORTANT: target is in millicores (e.g., 400 = 400m CPU)
{ type: "cpu"; target: number }

// Memory-based (uses Knative HPA)
// IMPORTANT: target is in megabytes (e.g., 512 = 512Mi)
{ type: "memory"; target: number }
```

### How Scaling Maps to Knative Annotations

| SiteState field | Knative annotation |
|-----------------|-------------------|
| `scaling.initialScale` | `autoscaling.knative.dev/initial-scale` |
| `scaling.minScale` | `autoscaling.knative.dev/min-scale` |
| `scaling.maxScale` | `autoscaling.knative.dev/max-scale` |
| `scaling.retentionPeriod` | `autoscaling.knative.dev/scale-to-zero-pod-retention-period` |
| `scaling.metric.type` | `autoscaling.knative.dev/metric` |
| `scaling.metric.target` | `autoscaling.knative.dev/target` |
| `scaling.metric.targetUtilizationPercentage` | `autoscaling.knative.dev/target-utilization-percentage` |

**Note:** `stable-window`, `scale-down-delay`, `max-scale-down-rate`, and `panic-threshold-percentage` are NOT in SiteState. These can only be set globally via the `config-autoscaler` ConfigMap in `knative-serving` namespace or per-revision by manually adding annotations after deployment.

## Procedures

### Procedure 1: Read Current State

```bash
# Ensure correct cluster context (ask user which cluster)
# AWS: kubectl config use-context arn:aws:eks:sa-east-1:578348582779:cluster/eks-cluster-eksCluster-ea385ba
# GCP: kubectl config use-context gke_gke-cluster-453314_us-east1_sites
kubectl config use-context <TARGET_CLUSTER_CONTEXT>

# Read and decode
kubectl get secret state -n sites-<SITENAME> -o json \
  | jq -r '.data.state' | base64 -d | jq '.'
```

### Procedure 2: Modify State

Extract, modify, and write back:

```bash
SITENAME="fila-store"
NS="sites-${SITENAME}"

# 1. Extract current state
STATE=$(kubectl get secret state -n $NS -o json | jq -r '.data.state' | base64 -d)

# 2. Modify with jq (examples below)
# ... see specific modification examples ...

# 3. Encode and patch
ENCODED=$(echo "$NEW_STATE" | base64)
kubectl patch secret state -n $NS --type='json' \
  -p="[{\"op\":\"replace\",\"path\":\"/data/state\",\"value\":\"${ENCODED}\"}]"
```

### Procedure 3: Trigger Redeploy

**Must deploy to BOTH clouds:**

```bash
if [ -z "$ADMIN_API_KEY" ]; then
  echo "ERROR: Set ADMIN_API_KEY env var first"
  exit 1
fi

SITENAME="fila-store"

# Deploy to AWS
curl -s --location "https://admin.deco.cx/live/invoke/deco-sites/admin/actions/hosting/deploy.ts" \
  --header "x-api-key: ${ADMIN_API_KEY}" \
  --header "Content-Type: application/json" \
  --data "{\"sitename\": \"${SITENAME}\"}"

# Deploy to GCP
curl -s --location "https://admin-gcp.deco.cx/live/invoke/deco-sites/admin/actions/hosting/deploy.ts" \
  --header "x-api-key: ${ADMIN_API_KEY}" \
  --header "Content-Type: application/json" \
  --data "{\"sitename\": \"${SITENAME}\"}"
```

### Procedure 4: Verify Deployment

```bash
# Watch pods rolling out
kubectl get pods -n sites-${SITENAME} -w

# Check the new revision
kubectl get rev -n sites-${SITENAME} --sort-by=.metadata.creationTimestamp | tail -3

# Verify annotations on new revision
kubectl get rev -n sites-${SITENAME} -o json | \
  jq '.items[-1].metadata.annotations | with_entries(select(.key | startswith("autoscaling")))'
```

## Common Modification Examples

### Change Scaling Parameters

```bash
# Set target concurrency to 30, min 10, max 40
NEW_STATE=$(echo "$STATE" | jq '
  .scaling.minScale = 10 |
  .scaling.maxScale = 40 |
  .scaling.initialScale = 10 |
  .scaling.metric = {
    "type": "concurrency",
    "target": 30,
    "targetUtilizationPercentage": 70
  }
')
```

### Add/Change Environment Variable

```bash
# Set or update an env var (upsert pattern)
VARNAME="MY_VAR"
VARVALUE="my-value"
NEW_STATE=$(echo "$STATE" | jq --arg name "$VARNAME" --arg val "$VARVALUE" '
  if (.envVars | map(.name) | index($name)) then
    .envVars = [.envVars[] | if .name == $name then .value = $val else . end]
  else
    .envVars += [{"name": $name, "value": $val}]
  end
')
```

### Remove Environment Variable

```bash
VARNAME="MY_VAR"
NEW_STATE=$(echo "$STATE" | jq --arg name "$VARNAME" '
  .envVars = [.envVars[] | select(.name != $name)]
')
```

### Change Resource Requests/Limits

```bash
NEW_STATE=$(echo "$STATE" | jq '
  .resources.requests.cpu = "1000m" |
  .resources.requests.memory = "2Gi" |
  .resources.limits.memory = "4Gi"
')
```

### Add V8 Flags via runArgs

```bash
# Reduce V8 max heap to force more frequent GC
NEW_STATE=$(echo "$STATE" | jq '
  .runArgs = "--v8-flags=--max-old-space-size=512"
')
```

## Complete Example: Update Scaling on a Specific Cluster

```bash
#!/bin/bash
set -e

if [ -z "$ADMIN_API_KEY" ]; then
  echo "ERROR: export ADMIN_API_KEY=<key> first"
  exit 1
fi

SITENAME="fila-store"
NS="sites-${SITENAME}"

# Ask user which cluster to target, then set:
# AWS:  CLUSTER="arn:aws:eks:sa-east-1:578348582779:cluster/eks-cluster-eksCluster-ea385ba"
# GCP:  CLUSTER="gke_gke-cluster-453314_us-east1_sites"
CLUSTER="<TARGET_CLUSTER_CONTEXT>"

# Switch to target cluster
kubectl config use-context "$CLUSTER"

# Read current state
STATE=$(kubectl get secret state -n $NS -o json | jq -r '.data.state' | base64 -d)
echo "Current scaling:"
echo "$STATE" | jq '.scaling'

# Update scaling
NEW_STATE=$(echo "$STATE" | jq '
  .scaling.minScale = 10 |
  .scaling.maxScale = 40 |
  .scaling.initialScale = 10 |
  .scaling.metric = {
    "type": "concurrency",
    "target": 30,
    "targetUtilizationPercentage": 70
  }
')
echo "New scaling:"
echo "$NEW_STATE" | jq '.scaling'

# Apply to secret on target cluster
ENCODED=$(echo "$NEW_STATE" | base64)
kubectl patch secret state -n $NS --type='json' \
  -p="[{\"op\":\"replace\",\"path\":\"/data/state\",\"value\":\"${ENCODED}\"}]"
echo "Secret updated on $CLUSTER"

# Redeploy BOTH clouds (each reads its own cluster's secret)
echo "Deploying to AWS..."
curl -sf --location "https://admin.deco.cx/live/invoke/deco-sites/admin/actions/hosting/deploy.ts" \
  --header "x-api-key: ${ADMIN_API_KEY}" \
  --header "Content-Type: application/json" \
  --data "{\"sitename\": \"${SITENAME}\"}"

echo "Deploying to GCP..."
curl -sf --location "https://admin-gcp.deco.cx/live/invoke/deco-sites/admin/actions/hosting/deploy.ts" \
  --header "x-api-key: ${ADMIN_API_KEY}" \
  --header "Content-Type: application/json" \
  --data "{\"sitename\": \"${SITENAME}\"}"

echo "Done. Watch rollout:"
echo "  kubectl get pods -n $NS -w"
```

## Troubleshooting

### Deploy returns error
- Check `ADMIN_API_KEY` is set and valid
- Verify the sitename matches exactly (no `sites-` prefix)
- Check both admin endpoints are reachable

### Secret patch fails
- Ensure you're on the correct cluster context for the target cloud
- Ensure the base64 encoding is correct (no extra newlines)
- Verify the secret exists: `kubectl get secret state -n sites-<sitename>`

### New pods don't pick up changes
- The deploy creates a new Knative revision — old pods stay until traffic shifts
- Check for deployment errors: `kubectl get ksvc -n sites-<sitename> -o json | jq '.status.conditions'`
- Verify the state secret was actually updated: re-read and decode it

### Annotations not applied
- The deployer only supports fields in SiteState. For annotations like `stable-window` or `scale-down-delay`, you must set them globally in `config-autoscaler` configmap in `knative-serving` namespace, or manually patch the revision after deployment.

## Related Skills

- `deco-site-memory-debugging` — Debug memory issues on running pods
- `deco-incident-debugging` — Incident response and triage
