# Memory Analysis Procedures

Step-by-step procedures for analyzing memory in Deno pods via CDP.

## Procedure 1: Quick Memory Check

**Goal:** Determine if memory is a leak or lazy GC. Takes 2 minutes.

```python
# 1. Get memory BEFORE GC
mem_before = await evaluate(ws, "JSON.stringify(Deno.memoryUsage())")

# 2. Force GC
await send_cmd(ws, "HeapProfiler.collectGarbage")
await asyncio.sleep(0.5)
await send_cmd(ws, "HeapProfiler.collectGarbage")  # twice for thoroughness

# 3. Get memory AFTER GC
mem_after = await evaluate(ws, "JSON.stringify(Deno.memoryUsage())")
```

**Interpretation:**
- RSS drops >30%? → Lazy GC, not a leak. **Recommend reducing `--max-old-space-size`.**
- RSS drops <10%? → Real retained memory. Continue to Procedure 2.

**Recommendation for lazy GC:**
If most memory is reclaimable by GC, the pod doesn't have a leak — V8 is just being lazy about collecting garbage. Reduce the max old space size so GC triggers more frequently:

```bash
# In the deployment or Deno flags:
--v8-flags=--max-old-space-size=512
# or even 256 for small sites
```

This keeps RSS predictable without affecting performance. V8's incremental GC is fast (typically <10ms pauses) so more frequent runs have negligible impact on request latency.

## Procedure 2: Object Leak Detection

**Goal:** Find leaked Response/Request objects and unconsumed bodies.

### Check Response Objects

```python
resp_id = await query_objects(ws, "Response.prototype")
if resp_id:
    info = await call_on(ws, resp_id, """function() {
        let used = 0, notUsed = 0;
        const leakedUrls = [];
        for (let i = 0; i < this.length; i++) {
            if (this[i].bodyUsed) used++;
            else {
                notUsed++;
                if (leakedUrls.length < 20)
                    leakedUrls.push({
                        url: this[i].url.substring(0, 120),
                        status: this[i].status
                    });
            }
        }
        return JSON.stringify({total: this.length, used, notUsed, leakedUrls});
    }""")
```

**Interpretation:**
- `notUsed` < 5? → Normal (in-flight requests)
- `notUsed` > 50? → **Response body leak.** Bodies are fetched but never consumed (`.text()`, `.json()`, `.arrayBuffer()`, or `.body.cancel()`).
- Check the URLs to identify which code path is leaking

### Check Request Objects

```python
req_id = await query_objects(ws, "Request.prototype")
if req_id:
    info = await call_on(ws, req_id, """function() {
        const hosts = {};
        for (let i = 0; i < this.length; i++) {
            try {
                const h = new URL(this[i].url).host;
                hosts[h] = (hosts[h] || 0) + 1;
            } catch(e) {}
        }
        return JSON.stringify({total: this.length, hosts});
    }""")
```

**Interpretation:**
- Hundreds of Request objects to the same host → possible fetch loop or unbounded cache
- `localhost` requests → SSR self-fetches (normal for Fresh)

## Procedure 3: ArrayBuffer Analysis

**Goal:** Identify large memory consumers in ArrayBuffers.

```python
ab_id = await query_objects(ws, "ArrayBuffer.prototype")
if ab_id:
    info = await call_on(ws, ab_id, """function() {
        let totalBytes = 0;
        const buckets = {
            '0-1KB': 0, '1-10KB': 0, '10-100KB': 0,
            '100KB-1MB': 0, '1-10MB': 0, '10MB+': 0
        };
        const large = [];
        for (let i = 0; i < this.length; i++) {
            const sz = this[i].byteLength;
            totalBytes += sz;
            if (sz < 1024) buckets['0-1KB']++;
            else if (sz < 10240) buckets['1-10KB']++;
            else if (sz < 102400) buckets['10-100KB']++;
            else if (sz < 1048576) buckets['100KB-1MB']++;
            else if (sz < 10485760) buckets['1-10MB']++;
            else buckets['10MB+']++;

            if (sz > 100000 && large.length < 20) {
                try {
                    const preview = new TextDecoder().decode(
                        new Uint8Array(this[i], 0, Math.min(200, sz))
                    );
                    large.push({sizeMB: sz/1024/1024, preview});
                } catch(e) {
                    large.push({sizeMB: sz/1024/1024, preview: '(binary)'});
                }
            }
        }
        return JSON.stringify({
            count: this.length,
            totalMB: totalBytes/1024/1024,
            buckets,
            large
        });
    }""")
```

**Known ArrayBuffer patterns:**
- **~304 MB static buffer** — V8/ICU internal data. Always present. Ignore it.
- **`resourceMetrics` JSON buffers (0.3-0.6 MB each)** — OpenTelemetry export batches accumulating. Minor but grows over time.
- **Large JSON buffers (>1 MB)** — ProductListingPage or similar API responses. If appearing in PAIRS, might indicate response body read + original buffer both retained.
- **`data:application/json;base64,...`** — Source maps. Normal, proportional to loaded modules.
- **`<!DOCTYPE html>...`** — Rendered HTML pages. If many, SSR cache might be unbounded.

## Procedure 4: Heap Snapshot

**Goal:** Get a comprehensive view of all heap objects.

```python
await send_cmd(ws, "HeapProfiler.enable")

MSG_ID += 1
snap_id = MSG_ID
await ws.send(json.dumps({
    "id": snap_id,
    "method": "HeapProfiler.takeHeapSnapshot",
    "params": {"reportProgress": False, "treatGlobalObjectsAsRoots": True}
}))

chunks = []
for _ in range(200000):
    raw = await asyncio.wait_for(ws.recv(), timeout=120)
    data = json.loads(raw)
    if data.get("method") == "HeapProfiler.addHeapSnapshotChunk":
        chunks.append(data["params"]["chunk"])
    elif data.get("id") == snap_id:
        break

snapshot = json.loads("".join(chunks))
```

**Parsing the snapshot:**

```python
snap_meta = snapshot.get("snapshot", {})
node_count = snap_meta.get("node_count", 0)
nodes = snapshot.get("nodes", [])
strings = snapshot.get("strings", [])

# Infer field count (node_fields may be empty in Deno)
field_count = len(nodes) // node_count  # typically 6 or 7

# V8 node type indices (standard order):
# 0=hidden, 1=array, 2=string, 3=object, 4=code,
# 5=closure, 6=regexp, 7=number, 8=native,
# 9=synthetic, 10=concatenated string, 11=sliced string,
# 12=symbol, 13=bigint, 14=object shape

# Aggregate by type
type_agg = {}
for i in range(0, node_count * field_count, field_count):
    node_type = nodes[i]      # index 0 = type
    name_idx = nodes[i + 1]   # index 1 = name (string table index)
    self_size = nodes[i + 3]  # index 3 = self_size
    # aggregate...
```

**What to look for in the snapshot:**
- `string` type >100 MB → HTML pages or JSON cached in memory
- `native` (type 8) → ArrayBuffers (cross-reference with Procedure 3)
- `closure` count very high → possible listener/callback leak
- `object` with specific names → identify which data structures hold memory

## Procedure 5: Additional Checks

### Open File Descriptors

```python
fds = await evaluate(ws, """
(async () => {
    try {
        let count = 0;
        const types = {socket: 0, pipe: 0, file: 0, other: 0};
        for await (const entry of Deno.readDir('/proc/self/fd')) {
            count++;
            try {
                const link = await Deno.readLink('/proc/self/fd/' + entry.name);
                if (link.startsWith('socket:')) types.socket++;
                else if (link.startsWith('pipe:')) types.pipe++;
                else if (link.startsWith('/')) types.file++;
                else types.other++;
            } catch(e) { types.other++; }
        }
        return JSON.stringify({count, types});
    } catch(e) { return JSON.stringify({error: e.message}); }
})()
""")
```

- 50-100 FDs → normal
- 500+ FDs → possible connection leak or file handle leak

### Map/Set Objects (potential caches)

```python
map_id = await query_objects(ws, "Map.prototype")
if map_id:
    info = await call_on(ws, map_id, """function() {
        const large = [];
        for (let i = 0; i < this.length; i++) {
            if (this[i].size > 10) {
                let keys = [];
                let j = 0;
                for (const k of this[i].keys()) {
                    if (j++ >= 3) break;
                    keys.push(String(k).substring(0, 80));
                }
                large.push({size: this[i].size, keys});
            }
        }
        large.sort((a,b) => b.size - a.size);
        return JSON.stringify({total: this.length, large: large.slice(0, 15)});
    }""")
```

### Deno Module Cache Size

```python
cache_info = await evaluate(ws, """
(async () => {
    const denoDir = Deno.env.get('DENO_DIR') || '/app/deco/deno_dir';
    let count = 0, totalSize = 0;
    async function walk(dir, depth) {
        if (depth > 3) return;
        try {
            for await (const entry of Deno.readDir(dir)) {
                if (entry.isDirectory) await walk(dir + '/' + entry.name, depth + 1);
                else {
                    count++;
                    try {
                        const s = await Deno.stat(dir + '/' + entry.name);
                        totalSize += s.size;
                    } catch(e) {}
                }
            }
        } catch(e) {}
    }
    await walk(denoDir, 0);
    return JSON.stringify({denoDir, files: count, sizeMB: totalSize/1024/1024});
})()
""")
```

### Deno Version

```python
ver = await evaluate(ws, """
JSON.stringify({
    deno: Deno.version,
    pid: Deno.pid,
    hostname: Deno.hostname(),
})
""")
```

## Procedure 6: LRU Cache Inspection

**Important context:** Deco's LRU cache stores `true` (a boolean) as the value — it's a metadata index for the filesystem cache, NOT storing response bodies in memory. The `calculatedSize` is the sum of tracked Content-Length values (metadata tracking), not actual memory consumption.

```python
lru = await evaluate(ws, """
(() => {
    const results = [];
    function findLRU(obj, path, depth) {
        if (depth > 3 || !obj) return;
        try {
            for (const key of Object.keys(obj)) {
                try {
                    const val = obj[key];
                    if (val && typeof val === 'object' &&
                        typeof val.max === 'number' &&
                        typeof val.size === 'number' &&
                        typeof val.calculatedSize === 'number') {
                        results.push({
                            path: path + '.' + key,
                            size: val.size,
                            calcSizeMB: val.calculatedSize / 1024 / 1024,
                            max: val.max,
                            maxSizeMB: val.maxSize ? val.maxSize / 1024 / 1024 : null,
                        });
                    }
                    if (depth < 2) findLRU(val, path + '.' + key, depth + 1);
                } catch(e) {}
            }
        } catch(e) {}
    }
    findLRU(globalThis, 'globalThis', 0);
    return JSON.stringify(results);
})()
""")
```

**Interpretation:**
- `size` = number of entries in the LRU
- `calculatedSize` = sum of Content-Length values tracked (metadata, NOT actual memory)
- `max` = maximum number of entries
- `maxSize` = maximum calculatedSize before eviction

## Summary: What's Normal vs What's a Leak

| Metric | Normal Range | Concern Threshold |
|--------|-------------|-------------------|
| RSS after GC | 500-1500 MB | >2 GB or growing continuously |
| Heap used | 100-300 MB | >500 MB after GC |
| Response objects (bodyUsed=false) | <10 | >50 |
| ArrayBuffers (excl. static 304MB) | <100 MB | >500 MB |
| Open FDs | 50-100 | >500 |
| Promises | 1000-5000 | >50000 |
| RSS drop after GC | 10-50% | If <5%, memory is truly retained |

## Typical Healthy Memory Profile (after GC)

For a large Deco/Fresh site (e.g., fila-store, farmrio):

```
RSS:       ~1500 MB
├── Heap:  ~150 MB (JS objects)
├── External: ~350 MB (ArrayBuffers, ~304MB is static V8)
└── Native: ~1000 MB (Deno runtime + JIT + modules)
    ├── V8 JIT compiled code: ~300-500 MB
    ├── Deno Rust runtime: ~200-300 MB
    ├── Module cache (on disk): ~100-200 MB
    └── Libraries + thread stacks: ~100 MB
```

The ~1 GB native gap is expected for apps loading thousands of modules. It's stable and does not grow over time.
