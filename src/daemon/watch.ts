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
  type: "fs-sync" | "fs-snapshot" | "worker-status" | "meta-info";
  detail: Record<string, unknown>;
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

/**
 * Infer block type from __resolveType string.
 * Maps to manifest block categories (pages, sections, loaders, etc.).
 */
function inferBlockType(resolveType: string): string | null {
  if (!resolveType) return null;
  if (resolveType.includes("/pages/")) return "pages";
  if (resolveType.includes("/sections/")) return "sections";
  if (resolveType.includes("/loaders/")) return "loaders";
  if (resolveType.includes("/actions/")) return "actions";
  if (resolveType.includes("/matchers/")) return "matchers";
  if (resolveType.includes("/flags/")) return "sections";
  return null;
}

export interface Metadata {
  kind: "block" | "file";
  blockType?: string;
  __resolveType?: string;
  name?: string;
  path?: string;
}

/**
 * Read a JSON file and infer its metadata (block type, resolveType, etc.).
 * Matches the Deno daemon's inferMetadata from daemon/fs/api.ts.
 */
export async function inferMetadata(filepath: string): Promise<Metadata | null> {
  try {
    const raw = await readFile(filepath, "utf-8");
    const parsed = JSON.parse(raw);
    const { __resolveType, name, path: pagePath } = parsed;

    if (!__resolveType) return { kind: "file" };

    const blockType = inferBlockType(__resolveType);
    if (!blockType) return { kind: "file" };

    if (blockType === "pages") {
      return {
        kind: "block",
        blockType,
        __resolveType,
        name: name ?? undefined,
        path: pagePath ?? undefined,
      };
    }

    return { kind: "block", blockType, __resolveType };
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

export function createWatchHandler(opts?: { getPort?: () => number }) {
  const cwd = process.cwd();
  const getPort = opts?.getPort ?? (() => 5173);

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

    if (closed) return;

    // Worker status — Vite dev server is always ready
    sendEvent({
      type: "worker-status",
      detail: { state: "ready" },
    });

    // Meta info — schema + manifest so admin knows about sections/loaders/actions.
    // Fetch via HTTP so the request goes through Vite SSR where the data lives
    // (daemon's native imports create separate module instances).
    try {
      const metaResponse = await fetch(`http://localhost:${getPort()}/live/_meta`);
      if (metaResponse.ok) {
        const metaData = await metaResponse.json();
        sendEvent({
          type: "meta-info",
          detail: { ...metaData, timestamp: Date.now() },
        });
      }
    } catch {
      // Schema may not be initialized yet — admin will retry via /live/_meta
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
