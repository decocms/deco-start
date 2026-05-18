import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _getLoggerAttributeFloorForTests,
  configureLogger,
  defaultLoggerAdapter,
  getLoggerAdapter,
  getLogLevel,
  type LoggerAdapter,
  logger,
  serializeError,
  setLoggerAttributeFloor,
  setLogLevel,
} from "./logger";

describe("defaultLoggerAdapter", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    configureLogger(defaultLoggerAdapter);
    setLogLevel("debug"); // permissive default for the rest of the suite
  });

  it("emits one JSON line per call", () => {
    defaultLoggerAdapter.log("info", "hello", { foo: 1 });
    expect(logSpy).toHaveBeenCalledOnce();
    const arg = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed).toMatchObject({ level: "info", msg: "hello", foo: 1 });
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("routes by level so CF Logs colorises correctly", () => {
    defaultLoggerAdapter.log("error", "boom");
    defaultLoggerAdapter.log("warn", "careful");
    defaultLoggerAdapter.log("debug", "details");
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(debugSpy).toHaveBeenCalledOnce();
  });

  it("never throws on circular refs (last-resort fallback)", () => {
    const circ: any = { name: "x" };
    circ.self = circ;
    expect(() => defaultLoggerAdapter.log("info", "circ", { circ })).not.toThrow();
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it("does not let attrs override level/msg/timestamp keys", () => {
    defaultLoggerAdapter.log("info", "real-msg", {
      level: "tampered",
      msg: "tampered",
      timestamp: "tampered",
    });
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("real-msg");
    expect(parsed.timestamp).not.toBe("tampered");
  });
});

describe("level filtering", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    configureLogger(defaultLoggerAdapter);
    setLogLevel("info");
  });

  it("drops calls below the active min level", () => {
    setLogLevel("warn");
    expect(getLogLevel()).toBe("warn");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled(); // info routes to console.log
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});

describe("configureLogger", () => {
  afterEach(() => {
    configureLogger(defaultLoggerAdapter);
    setLogLevel("info");
  });

  it("dispatches to the configured adapter", () => {
    const calls: Array<[string, string, unknown]> = [];
    const test: LoggerAdapter = {
      log(level, msg, attrs) {
        calls.push([level, msg, attrs]);
      },
    };
    configureLogger(test);
    expect(getLoggerAdapter()).toBe(test);

    logger.info("hello", { x: 1 });
    expect(calls).toEqual([["info", "hello", { x: 1 }]]);
  });

  it("falls back to default adapter if active adapter throws", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const broken: LoggerAdapter = {
      log() {
        throw new Error("nope");
      },
    };
    configureLogger(broken);
    expect(() => logger.info("survives", { x: 1 })).not.toThrow();
    // Default adapter was invoked as the fallback
    expect(logSpy).toHaveBeenCalledOnce();
    logSpy.mockRestore();
  });
});

describe("setLoggerAttributeFloor", () => {
  afterEach(() => {
    setLoggerAttributeFloor({});
    configureLogger(defaultLoggerAdapter);
    setLogLevel("info");
  });

  it("starts empty so the floor is a no-op out of the box", () => {
    expect(_getLoggerAttributeFloorForTests()).toEqual({});
  });

  it("merges floor attrs into every log call", () => {
    setLoggerAttributeFloor({
      "deco.runtime.version": "4.4.0",
      "deployment.environment": "production",
    });
    const calls: Array<Record<string, unknown> | undefined> = [];
    configureLogger({
      log(_level, _msg, attrs) {
        calls.push(attrs);
      },
    });

    logger.info("ping", { route: "/" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      "deco.runtime.version": "4.4.0",
      "deployment.environment": "production",
      route: "/",
    });
  });

  it("lets caller attrs override the floor on key collision", () => {
    setLoggerAttributeFloor({ "deployment.environment": "production" });
    const calls: Array<Record<string, unknown> | undefined> = [];
    configureLogger({
      log(_level, _msg, attrs) {
        calls.push(attrs);
      },
    });

    logger.warn("override", { "deployment.environment": "staging" });

    expect(calls[0]?.["deployment.environment"]).toBe("staging");
  });

  it("applies the floor even when the caller passes no attrs", () => {
    setLoggerAttributeFloor({ tenant: "lebiscuit" });
    const calls: Array<Record<string, unknown> | undefined> = [];
    configureLogger({
      log(_level, _msg, attrs) {
        calls.push(attrs);
      },
    });

    logger.info("no-attrs");

    expect(calls[0]).toEqual({ tenant: "lebiscuit" });
  });

  it("clearing the floor restores the no-op fast path", () => {
    setLoggerAttributeFloor({ tenant: "lebiscuit" });
    setLoggerAttributeFloor({});
    const calls: Array<Record<string, unknown> | undefined> = [];
    configureLogger({
      log(_level, _msg, attrs) {
        calls.push(attrs);
      },
    });

    logger.info("clean", { x: 1 });

    expect(calls[0]).toEqual({ x: 1 });
  });
});

describe("serializeError", () => {
  it("flattens an Error into a JSON-safe shape with stack", () => {
    const err = new Error("boom");
    const out = serializeError(err);
    expect(out).toEqual({ name: "Error", message: "boom", stack: err.stack });
  });

  it("preserves subclass name (TypeError, RangeError, custom)", () => {
    expect(serializeError(new TypeError("bad type")).name).toBe("TypeError");
    class MyErr extends Error {
      override name = "MyErr";
    }
    expect(serializeError(new MyErr("custom")).name).toBe("MyErr");
  });

  it("survives JSON.stringify round-trip", () => {
    const err = new Error("round-trip");
    const out = serializeError(err);
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
    expect(JSON.parse(JSON.stringify(out)).message).toBe("round-trip");
  });

  it("captures plain objects as JSON in message, marking them as NonError", () => {
    const out = serializeError({ code: 500, body: "vtex down" });
    expect(out.name).toBe("NonError");
    expect(out.message).toBe('{"code":500,"body":"vtex down"}');
    expect(out.stack).toBeUndefined();
  });

  it("falls back to String() when an object has circular refs", () => {
    const circ: Record<string, unknown> = { a: 1 };
    circ.self = circ;
    const out = serializeError(circ);
    expect(out.name).toBe("NonError");
    expect(typeof out.message).toBe("string");
    expect(out.stack).toBeUndefined();
  });

  it("handles primitives (string, number, null, undefined)", () => {
    expect(serializeError("just a string")).toEqual({
      name: "NonError",
      message: "just a string",
    });
    expect(serializeError(42)).toEqual({ name: "NonError", message: "42" });
    expect(serializeError(null)).toEqual({ name: "NonError", message: "null" });
    expect(serializeError(undefined)).toEqual({
      name: "NonError",
      message: "undefined",
    });
  });
});

describe("trace correlation", () => {
  afterEach(() => {
    configureLogger(defaultLoggerAdapter);
    setLogLevel("info");
  });

  it("includes trace_id/span_id when emitted inside withTracing", async () => {
    const { configureTracer, setObservabilitySpanStore, withTracing } = await import(
      "./observability"
    );

    let current: unknown = null;
    setObservabilitySpanStore({
      get: () => current as never,
      run<R>(value: never, fn: () => R): R {
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
    });
    configureTracer({
      startSpan: () => ({
        end: () => {},
        spanContext: () => ({
          traceId: "deadbeefdeadbeefdeadbeefdeadbeef",
          spanId: "1234567890abcdef",
          traceFlags: 1,
        }),
      }),
    });

    const seen: Array<Record<string, unknown> | undefined> = [];
    configureLogger({
      log(_l, _m, attrs) {
        seen.push(attrs);
      },
    });

    await withTracing("t", async () => {
      logger.info("inside-span", { custom: "yes" });
    });
    logger.info("outside-span", { custom: "no" });

    expect(seen[0]).toMatchObject({
      trace_id: "deadbeefdeadbeefdeadbeefdeadbeef",
      span_id: "1234567890abcdef",
      custom: "yes",
    });
    expect(seen[1]).toEqual({ custom: "no" });

    setObservabilitySpanStore(undefined);
  });
});
