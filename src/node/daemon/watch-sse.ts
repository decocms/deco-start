import {
  type FsEvent,
  scanDecoFiles,
  subscribeFsEvents,
} from "./watch";

export interface WatchSseOptions {
  /** Watch root. Defaults to process.cwd(). */
  cwd?: string;
  /** Resolves the loopback port the meta-info fetch should hit. Defaults to 5173. */
  getPort?: () => number;
}

/**
 * Web-standard SSE handler for `/_watch` and `/watch`.
 *
 * Emits the initial .deco/ snapshot, then forwards broadcast-channel events
 * for the lifetime of the connection. Closes cleanly when the request signal
 * aborts.
 */
export function handleWatchSse(req: Request, opts: WatchSseOptions = {}): Response {
  const url = new URL(req.url);
  const since = Number(url.searchParams.get("since")) || 0;
  const cwd = opts.cwd ?? process.cwd();
  const getPort = opts.getPort ?? (() => 5173);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const send = (event: FsEvent) => {
        if (closed) return;
        const data = encodeURIComponent(JSON.stringify(event));
        controller.enqueue(encoder.encode(`event: message\ndata: ${data}\n\n`));
      };

      const unsubscribe = subscribeFsEvents(send);

      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      req.signal.addEventListener("abort", close);

      try {
        for await (const event of scanDecoFiles(cwd, since)) {
          if (closed) return;
          send(event);
        }
        if (closed) return;

        send({ type: "worker-status", detail: { state: "ready" } });

        try {
          const metaResponse = await fetch(`http://localhost:${getPort()}/live/_meta`);
          if (metaResponse.ok) {
            const metaData = await metaResponse.json();
            send({ type: "meta-info", detail: { ...metaData, timestamp: Date.now() } });
          }
        } catch {
          // schema not initialised yet — admin will retry via /live/_meta
        }
      } catch (err) {
        if (!closed) {
          try {
            controller.error(err);
          } catch {
            // ignore
          }
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
