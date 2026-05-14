import { describe, expect, it } from "vitest";
import { broadcastFsEvent } from "./watch";
import { handleWatchSse } from "./watch-sse";

describe("handleWatchSse", () => {
  it("returns a text/event-stream Response", () => {
    const controller = new AbortController();
    const req = new Request("http://t/_watch", { signal: controller.signal });
    const res = handleWatchSse(req, { cwd: process.cwd() });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    controller.abort();
  });

  it("forwards broadcast events to the SSE stream", async () => {
    const controller = new AbortController();
    const req = new Request("http://t/_watch?since=" + Date.now(), { signal: controller.signal });
    const res = handleWatchSse(req, { cwd: process.cwd() });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Drain the initial fs-snapshot before publishing — scanner emits it last.
    let buffer = "";
    while (!buffer.includes("fs-snapshot")) {
      const { value } = await reader.read();
      buffer += decoder.decode(value);
    }

    broadcastFsEvent({ type: "worker-status", detail: { state: "ready" } });
    let received = "";
    while (!received.includes("worker-status")) {
      const { value } = await reader.read();
      received += decoder.decode(value);
    }
    expect(received).toContain("worker-status");
    controller.abort();
  });
});
