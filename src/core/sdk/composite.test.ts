import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeterAdapter } from "../../tanstack/middleware/observability";
import { createCompositeLogger, createCompositeMeter } from "./composite";
import type { LoggerAdapter } from "./logger";

describe("createCompositeLogger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fans calls out to every adapter", () => {
    const aCalls: any[][] = [];
    const bCalls: any[][] = [];
    const a: LoggerAdapter = { log: (...args) => void aCalls.push(args) };
    const b: LoggerAdapter = { log: (...args) => void bCalls.push(args) };
    const composite = createCompositeLogger([a, b]);

    composite.log("info", "hello", { foo: 1 });

    expect(aCalls).toEqual([["info", "hello", { foo: 1 }]]);
    expect(bCalls).toEqual([["info", "hello", { foo: 1 }]]);
  });

  it("filters falsy entries (null/undefined/false)", () => {
    const calls: any[] = [];
    const a: LoggerAdapter = { log: (...args) => void calls.push(args) };
    const composite = createCompositeLogger([null, a, undefined, false]);
    composite.log("info", "ok");
    // adapter receives the call with no third arg (undefined is omitted)
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe("info");
    expect(calls[0][1]).toBe("ok");
  });

  it("isolates errors so one bad adapter does not block others", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const okCalls: any[][] = [];
    const broken: LoggerAdapter = {
      log() {
        throw new Error("boom");
      },
    };
    const ok: LoggerAdapter = { log: (...args) => void okCalls.push(args) };
    const composite = createCompositeLogger([broken, ok]);

    expect(() => composite.log("error", "still goes through")).not.toThrow();
    expect(okCalls.length).toBe(1);
    expect(okCalls[0][0]).toBe("error");
    expect(okCalls[0][1]).toBe("still goes through");
    expect(errSpy).toHaveBeenCalled(); // composite reports the failure
  });

  it("returns the single adapter directly when only one is provided", () => {
    const a: LoggerAdapter = { log: () => {} };
    expect(createCompositeLogger([a])).toBe(a);
  });
});

describe("createCompositeMeter", () => {
  afterEach(() => vi.restoreAllMocks());

  function recorder() {
    const counter: any[] = [];
    const gauge: any[] = [];
    const histo: any[] = [];
    const meter: MeterAdapter = {
      counterInc: (n, v, l) => void counter.push([n, v, l]),
      gaugeSet: (n, v, l) => void gauge.push([n, v, l]),
      histogramRecord: (n, v, l) => void histo.push([n, v, l]),
    };
    return { meter, counter, gauge, histo };
  }

  it("fans counter/gauge/histogram across meters", () => {
    const a = recorder();
    const b = recorder();
    const composite = createCompositeMeter([a.meter, b.meter]);

    composite.counterInc("c", 1, { p: "/" });
    composite.gaugeSet?.("g", 5);
    composite.histogramRecord?.("h", 100, { route: "/p" });

    expect(a.counter[0].slice(0, 2)).toEqual(["c", 1]);
    expect(a.counter[0][2]).toEqual({ p: "/" });
    expect(b.counter[0].slice(0, 2)).toEqual(["c", 1]);
    expect(a.gauge[0].slice(0, 2)).toEqual(["g", 5]);
    expect(b.gauge[0].slice(0, 2)).toEqual(["g", 5]);
    expect(a.histo[0]).toEqual(["h", 100, { route: "/p" }]);
    expect(b.histo[0]).toEqual(["h", 100, { route: "/p" }]);
  });

  it("isolates errors per meter and per call type", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: MeterAdapter = {
      counterInc: () => {
        throw new Error("c");
      },
      gaugeSet: () => {
        throw new Error("g");
      },
      histogramRecord: () => {
        throw new Error("h");
      },
    };
    const ok = recorder();
    const composite = createCompositeMeter([broken, ok.meter]);

    composite.counterInc("c", 1);
    composite.gaugeSet?.("g", 5);
    composite.histogramRecord?.("h", 100);

    expect(ok.counter[0].slice(0, 2)).toEqual(["c", 1]);
    expect(ok.gauge[0].slice(0, 2)).toEqual(["g", 5]);
    expect(ok.histo[0].slice(0, 2)).toEqual(["h", 100]);
  });

  it("skips meters that don't implement optional ops", () => {
    const onlyCounter: MeterAdapter = { counterInc: () => {} };
    const composite = createCompositeMeter([onlyCounter]);
    expect(() => composite.gaugeSet?.("g", 1)).not.toThrow();
    expect(() => composite.histogramRecord?.("h", 1)).not.toThrow();
  });
});
