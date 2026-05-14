import { describe, expect, it } from "vitest";
import { broadcastFsEvent, subscribeFsEvents, type FsEvent } from "./watch";

describe("broadcast channel", () => {
  it("delivers events to subscribers and stops after unsubscribe", () => {
    const seen: FsEvent[] = [];
    const unsubscribe = subscribeFsEvents((e) => seen.push(e));
    broadcastFsEvent({ type: "worker-status", detail: { state: "ready" } });
    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe("worker-status");
    unsubscribe();
    broadcastFsEvent({ type: "worker-status", detail: { state: "ready" } });
    expect(seen.length).toBe(1);
  });
});
