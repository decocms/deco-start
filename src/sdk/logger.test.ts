import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureLogger,
  defaultLoggerAdapter,
  getLoggerAdapter,
  getLogLevel,
  type LoggerAdapter,
  logger,
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
