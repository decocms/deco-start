/**
 * SSE endpoint for file change events — initial sync + live updates.
 *
 * Ported from: deco-cx/deco daemon/sse/api.ts + daemon/sse/channel.ts
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Event types — simplified from daemon/fs/common.ts
// ---------------------------------------------------------------------------

interface FSEvent {
  type: "fs-sync" | "fs-snapshot";
  detail: {
    metadata?: { kind: string } | null;
    filepath?: string;
    timestamp: number;
    status?: unknown;
  };
}

// ---------------------------------------------------------------------------
// Broadcast channel (EventTarget-based, same as daemon/sse/channel.ts)
// ---------------------------------------------------------------------------

const channel = new EventTarget();

export function broadcastFSEvent(event: FSEvent): void {
  channel.dispatchEvent(new CustomEvent("broadcast", { detail: event }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toPosix = (p: string) => p.replaceAll(sep, "/");

function shouldIgnore(path: string): boolean {
  return (
    path.includes(`${sep}.git${sep}`) ||
    path.includes(`${sep}node_modules${sep}`) ||
    path.includes(`${sep}.agent-home${sep}`) ||
    path.includes(`${sep}.claude${sep}`)
  );
}

async function inferMetadata(
  filepath: string,
): Promise<{ kind: string }> {
  try {
    const raw = await readFile(filepath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.__resolveType) {
      return { kind: "block" };
    }
    return { kind: "file" };
  } catch {
    return { kind: "file" };
  }
}

// ---------------------------------------------------------------------------
// Initial file scan — yields fs-sync events for each .deco/ file
// ---------------------------------------------------------------------------

async function* scanFiles(
  cwd: string,
  since: number,
): AsyncGenerator<FSEvent> {
  const decoDir = join(cwd, ".deco");
  try {
    const entries = await readdir(decoDir, {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = join(entry.parentPath, entry.name);
      if (shouldIgnore(fullPath)) continue;

      let mtime: number;
      try {
        const stats = await stat(fullPath);
        mtime = stats.mtimeMs;
      } catch {
        mtime = Date.now();
      }

      if (mtime < since) continue;

      const metadata = await inferMetadata(fullPath);
      const filepath = toPosix(fullPath.replace(cwd, ""));
      yield {
        type: "fs-sync",
        detail: { metadata, filepath, timestamp: mtime },
      };
    }
  } catch {
    // .deco dir might not exist yet
  }

  yield {
    type: "fs-snapshot",
    detail: { timestamp: Date.now() },
  };
}

// ---------------------------------------------------------------------------
// SSE handler — Connect-style middleware
// ---------------------------------------------------------------------------

export function createWatchHandler() {
  const cwd = process.cwd();

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Only handle /watch or the root SSE endpoint
    if (url.pathname !== "/watch" && url.pathname !== "/") {
      next();
      return;
    }

    if (req.method !== "GET") {
      next();
      return;
    }

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const since = Number(url.searchParams.get("since")) || 0;
    let closed = false;

    req.on("close", () => {
      closed = true;
      console.log("[deco] SSE stream closed");
    });

    function sendEvent(event: FSEvent): void {
      if (closed) return;
      const data = encodeURIComponent(JSON.stringify(event));
      res.write(`event: message\ndata: ${data}\n\n`);
    }

    // Live broadcast listener
    const handler = (e: Event) => {
      const ce = e as CustomEvent<FSEvent>;
      sendEvent(ce.detail);
    };
    channel.addEventListener("broadcast", handler);
    req.on("close", () => {
      channel.removeEventListener("broadcast", handler);
    });

    console.log("[deco] SSE stream opened");

    // Initial scan
    for await (const event of scanFiles(cwd, since)) {
      if (closed) break;
      sendEvent(event);
    }
  };
}

// ---------------------------------------------------------------------------
// Wire Vite watcher to broadcast channel
// ---------------------------------------------------------------------------

export function watchFS(watcher: {
  on(event: string, cb: (...args: unknown[]) => void): void;
}): void {
  const cwd = process.cwd();

  const onChange = async (filePath: unknown, deleted = false) => {
    if (typeof filePath !== "string") return;
    if (shouldIgnore(filePath)) return;

    const metadata = deleted ? null : await inferMetadata(filePath);
    let mtime = Date.now();
    if (!deleted) {
      try {
        const stats = await stat(filePath);
        mtime = stats.mtimeMs;
      } catch {
        // use Date.now()
      }
    }

    broadcastFSEvent({
      type: "fs-sync",
      detail: {
        metadata,
        filepath: toPosix(filePath.replace(cwd, "")),
        timestamp: mtime,
      },
    });
  };

  watcher.on("change", (path: unknown) => onChange(path));
  watcher.on("add", (path: unknown) => onChange(path));
  watcher.on("unlink", (path: unknown) => onChange(path, true));
}
