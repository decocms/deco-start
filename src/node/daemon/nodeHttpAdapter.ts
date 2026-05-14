import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

export type WebHandler = (req: Request) => Promise<Response | null> | Response | null;

/**
 * Wrap a Web-standard `Request → Response` handler as Connect-style middleware
 * for `vite dev`'s server.middlewares.use(...) stack.
 *
 * Returning `null` from the inner handler delegates to `next()` (fall-through).
 * Streaming bodies are piped through with backpressure preserved.
 */
export function toNodeMiddleware(handler: WebHandler) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    let webResponse: Response | null;
    try {
      const webReq = toWebRequest(req);
      webResponse = await handler(webReq);
    } catch (err) {
      console.error("[deco] daemon handler threw:", err);
      res.statusCode = 500;
      res.end();
      return;
    }
    if (!webResponse) return next();
    await writeWebResponse(res, webResponse);
  };
}

function toWebRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  const method = (req.method ?? "GET").toUpperCase();
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    (init as any).duplex = "half"; // required by Node's Web Request for streaming bodies
  }
  return new Request(url, init);
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  res.on("close", () => reader.cancel().catch(() => undefined));
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // Honor backpressure: pause reading until drain when write returns false.
      if (!res.write(value)) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
    res.end();
  } catch (err) {
    console.error("[deco] error streaming Response body:", err);
    res.destroy(err as Error);
  }
}
