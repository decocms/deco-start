# CDP Connection Guide

How to connect to a Deno pod's Chrome DevTools Protocol inspector for memory debugging.

## Prerequisites

- `kubectl` configured with cluster access
- Python 3 with `websockets` package (`pip3 install websockets`)
- Pod must be running Deno with inspector enabled (Deco sites expose port 9229 by default)

## Step 1: Identify the Pod

```bash
# List pods in the site namespace
kubectl get pods -n sites-<sitename> -o wide

# Check current memory usage
kubectl top pods -n sites-<sitename>
```

## Step 2: Port-Forward

```bash
# Forward local 9229 to pod's inspector port
kubectl port-forward -n sites-<sitename> <pod-name> 9229:9229

# If port 9229 is busy, use a different local port
kubectl port-forward -n sites-<sitename> <pod-name> 19229:9229
```

**Keep this running in a separate terminal.** Port-forwards drop frequently — check if it's alive before running scripts.

## Step 3: Get WebSocket URL

```bash
curl -s http://127.0.0.1:9229/json/list | jq '.[0].webSocketDebuggerUrl'
```

This returns something like:
```
ws://127.0.0.1:9229/ws/b9cf0f05-6e67-4ad6-865f-f418f6b4856c
```

**The UUID changes every time the pod restarts.** Always fetch a fresh URL.

## Step 4: Connect via Python

```python
import asyncio, json, websockets

WS = "ws://127.0.0.1:9229/ws/<UUID>"
MSG_ID = 0

async def send_cmd(ws, method, params=None):
    global MSG_ID
    MSG_ID += 1
    msg = {"id": MSG_ID, "method": method}
    if params:
        msg["params"] = params
    await ws.send(json.dumps(msg))
    for _ in range(10000):
        raw = await asyncio.wait_for(ws.recv(), timeout=30)
        data = json.loads(raw)
        if data.get("id") == MSG_ID:
            return data
    return None

async def evaluate(ws, expr):
    r = await send_cmd(ws, "Runtime.evaluate", {
        "expression": expr,
        "contextId": 1,  # IMPORTANT: always use contextId: 1
        "returnByValue": True,
        "awaitPromise": True,
        "timeout": 30000,
    })
    if r and "result" in r and "result" in r["result"]:
        return r["result"]["result"].get("value")
    return None

async def main():
    async with websockets.connect(WS, max_size=50*1024*1024) as ws:
        await send_cmd(ws, "Runtime.enable")
        # Your analysis code here...

asyncio.run(main())
```

## Common Mistakes and Pitfalls

### 1. Missing `contextId: 1`

**Symptom:** `Runtime.evaluate` returns empty results or "Cannot find default execution context".

**Cause:** After `Runtime.enable`, Deno emits thousands of `Runtime.consoleAPICalled` events that flood the event loop. Without explicit `contextId`, the evaluation may target the wrong context.

**Fix:** Always pass `contextId: 1` in every `Runtime.evaluate` call:
```python
await send_cmd(ws, "Runtime.evaluate", {
    "expression": expr,
    "contextId": 1,  # <-- THIS IS REQUIRED
    ...
})
```

### 2. queryObjects returns under `objects`, not `result`

**Symptom:** `KeyError: 'result'` when accessing `queryObjects` response.

**Cause:** Deno's V8 inspector returns the array under `result.objects`, not `result.result` like Chrome does.

**Fix:**
```python
# WRONG (Chrome-style):
arr_id = qr["result"]["result"].get("objectId")

# CORRECT (Deno-style):
arr_id = qr["result"].get("objects", {}).get("objectId")
```

Full pattern:
```python
async def query_objects(ws, proto_expr):
    proto_r = await send_cmd(ws, "Runtime.evaluate", {
        "expression": proto_expr,
        "contextId": 1,
    })
    proto_id = proto_r["result"].get("result", {}).get("objectId")
    if not proto_id:
        return None
    qr = await send_cmd(ws, "Runtime.queryObjects", {"prototypeObjectId": proto_id})
    if not qr or "result" not in qr:
        return None
    return qr["result"].get("objects", {}).get("objectId")
```

### 3. Event flooding drowns responses

**Symptom:** `send_cmd` never receives the response, times out.

**Cause:** `Runtime.enable` triggers a flood of `Runtime.consoleAPICalled` events (can be thousands). The event drain loop in `send_cmd` may exhaust its iteration limit before finding the response.

**Fix:** Increase the drain limit:
```python
for _ in range(10000):  # Use 10000, not 100
    raw = await asyncio.wait_for(ws.recv(), timeout=30)
    data = json.loads(raw)
    if data.get("id") == MSG_ID:
        return data
```

### 4. Port-forward drops silently

**Symptom:** `ConnectionClosedError: no close frame` or `ConnectionRefusedError`.

**Cause:** `kubectl port-forward` drops connections under load or after inactivity.

**Fix:**
1. Check if port-forward process is still running
2. Re-establish port-forward
3. Get a fresh WebSocket URL (same pod, new connection)
4. Script should handle reconnection gracefully

### 5. WebSocket message too large

**Symptom:** `PayloadTooBig` error when taking heap snapshots.

**Fix:** Increase `max_size` on the WebSocket connection:
```python
async with websockets.connect(WS, max_size=100*1024*1024) as ws:
```

### 6. Deno 2.x API changes

Some APIs changed in Deno 2.x:
- `Deno.resources()` → **removed** in Deno 2.x. Use `/proc/self/fd` instead.
- `caches.keys()` → may not be available as a function. Use `caches.open(name)` and `cache.keys()` instead.

### 7. /proc access requires permissions

**Symptom:** "Requires all access" error when reading `/proc/self/status` or `/proc/self/maps`.

**Cause:** Deno's permission system blocks filesystem reads outside allowed paths.

**Workaround:** Use `Deno.memoryUsage()` instead — it doesn't require extra permissions and gives RSS, heap, and external memory.

### 8. Heap snapshot node_fields empty

**Symptom:** Heap snapshot `snapshot.node_fields` is an empty array.

**Cause:** Deno/V8 stores `node_fields` under `snapshot.meta` or uses a different layout than Chrome.

**Fix:** Infer field count from `len(nodes) / node_count`. Standard V8 uses 6 or 7 fields per node:
```python
field_count = len(nodes) // node_count
# 6 fields: type, name, id, self_size, edge_count, trace_node_id
# 7 fields: + detachedness
```

### 9. callFunctionOn for object analysis

After `queryObjects`, use `callFunctionOn` to analyze the returned array:
```python
async def call_on(ws, obj_id, func):
    r = await send_cmd(ws, "Runtime.callFunctionOn", {
        "objectId": obj_id,
        "functionDeclaration": func,
        "returnByValue": True,
    })
    if not r or "result" not in r:
        return None
    return r["result"].get("result", {}).get("value")

# Example: count Response objects and check bodyUsed
body_info = await call_on(ws, resp_array_id, """function() {
    let used = 0, notUsed = 0;
    for (let i = 0; i < this.length; i++) {
        if (this[i].bodyUsed) used++;
        else notUsed++;
    }
    return JSON.stringify({used, notUsed});
}""")
```
