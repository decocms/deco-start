/**
 * Connect-style SSE handler — wraps the shared Web-standard `handleWatchSse`
 * for Vite's middleware stack. New code should consume `handleWatchSse`
 * directly from `src/node/daemon/watch-sse` and bind it via `toNodeMiddleware`
 * (introduced in Task 9).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  broadcastFsEvent,
  inferMetadata,
  type FsEvent,
  scanDecoFiles,
  subscribeFsEvents,
} from "../../node/daemon/watch";
import { bindWatcherToChannel } from "../../node/daemon/watcher";

export {
  broadcastFsEvent as broadcastFSEvent,
  inferMetadata,
  type FsEvent,
  type Metadata,
} from "../../node/daemon/watch";

/**
 * Back-compat shim — TanStack daemon middleware still constructs this.
 * The implementation reuses the new shared scanner + channel.
 */
export function createWatchHandler(opts?: { getPort?: () => number }) {
  const cwd = process.cwd();
  const getPort = opts?.getPort ?? (() => 5173);

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/watch" && url.pathname !== "/") return next();
    if (req.method !== "GET") return next();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const since = Number(url.searchParams.get("since")) || 0;
    let closed = false;

    const sendEvent = (event: FsEvent) => {
      if (closed) return;
      const data = encodeURIComponent(JSON.stringify(event));
      res.write(`event: message\ndata: ${data}\n\n`);
    };

    const unsubscribe = subscribeFsEvents(sendEvent);
    req.on("close", () => {
      closed = true;
      unsubscribe();
    });

    for await (const event of scanDecoFiles(cwd, since)) {
      if (closed) break;
      sendEvent(event);
    }
    if (closed) return;

    sendEvent({ type: "worker-status", detail: { state: "ready" } });

    try {
      const metaResponse = await fetch(`http://localhost:${getPort()}/live/_meta`);
      if (metaResponse.ok) {
        const metaData = await metaResponse.json();
        sendEvent({ type: "meta-info", detail: { ...metaData, timestamp: Date.now() } });
      }
    } catch {
      // schema not initialised yet
    }
  };
}

/** Back-compat — TanStack daemon binds Vite's watcher into the shared channel here. */
export function watchFS(watcher: {
  on(event: string, cb: (...args: unknown[]) => void): void;
}): void {
  bindWatcherToChannel(watcher);
}
