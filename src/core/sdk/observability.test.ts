import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestStore } from "../runtime/requestStore";
import {
  configureTracer,
  getActiveSpan,
  injectTraceContext,
  type Span,
  setObservabilitySpanStore,
  withTracing,
} from "./observability";

function fakeStore<T>(): RequestStore<T> {
  let current: T | undefined;
  return {
    get: () => current,
    run<R>(value: T, fn: () => R): R {
      const prev = current;
      current = value;
      try {
        const result = fn();
        if (result instanceof Promise) {
          return result.finally(() => {
            current = prev;
          }) as unknown as R;
        }
        current = prev;
        return result;
      } catch (err) {
        current = prev;
        throw err;
      }
    },
  };
}

function recordingTracer() {
  const spans: Array<{ name: string; attrs?: Record<string, unknown>; ended: boolean }> = [];
  return {
    spans,
    startSpan: (name: string, attrs?: Record<string, string | number | boolean>) => {
      const entry = { name, attrs, ended: false };
      spans.push(entry);
      const span: Span = {
        end: () => {
          entry.ended = true;
        },
        spanContext: () => ({
          traceId: "11112222333344445555666677778888",
          spanId: "aabbccddeeff0011",
          traceFlags: 1,
        }),
      };
      return span;
    },
  };
}

describe("injectTraceContext", () => {
  beforeEach(() => {
    setObservabilitySpanStore(fakeStore<Span | null>());
    configureTracer(recordingTracer());
  });

  afterEach(() => {
    setObservabilitySpanStore(undefined);
  });

  it("writes a well-formed traceparent inside an active span", async () => {
    await withTracing("t", async () => {
      const headers = new Headers();
      injectTraceContext(headers);
      expect(headers.get("traceparent")).toBe(
        "00-11112222333344445555666677778888-aabbccddeeff0011-01",
      );
    });
  });

  it("is a no-op outside any active span", () => {
    const headers = new Headers();
    injectTraceContext(headers);
    expect(headers.get("traceparent")).toBeNull();
  });

  it("pads single-bit traceFlags to two hex chars", async () => {
    // recordingTracer always emits traceFlags=1 → "01"
    await withTracing("t", async () => {
      const headers = new Headers();
      injectTraceContext(headers);
      expect(headers.get("traceparent")?.endsWith("-01")).toBe(true);
    });
  });
});

describe("withTracing — active span propagation", () => {
  beforeEach(() => {
    setObservabilitySpanStore(fakeStore<Span | null>());
    configureTracer(recordingTracer());
  });

  afterEach(() => {
    setObservabilitySpanStore(undefined);
  });

  it("getActiveSpan returns the current span inside the callback", async () => {
    await withTracing("outer", async () => {
      expect(getActiveSpan()).not.toBeNull();
    });
    expect(getActiveSpan()).toBeNull();
  });
});
