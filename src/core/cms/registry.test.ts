import { describe, expect, it, beforeEach } from "vitest";
import {
  registerSection,
  registerSectionsSync,
  getSection,
  getSectionOptions,
  getSyncComponent,
  getResolvedComponent,
} from "./registry";

// Reset globalThis.__deco between tests to avoid cross-test pollution
beforeEach(() => {
  const G = globalThis as any;
  G.__deco.sectionRegistry = {};
  G.__deco.sectionOptions = {};
  G.__deco.resolvedComponents = {};
  G.__deco.syncComponents = {};
});

describe("registerSection + getSection", () => {
  it("registers and retrieves a section loader", () => {
    const loader = async () => ({ default: () => null });
    registerSection("site/sections/Hero.tsx", loader);

    const retrieved = getSection("site/sections/Hero.tsx");
    expect(retrieved).toBe(loader);
  });

  it("returns undefined for unregistered section", () => {
    expect(getSection("nonexistent")).toBeUndefined();
  });
});

describe("registerSection with options", () => {
  it("stores loadingFallback in section options", () => {
    const fallback = () => null;
    registerSection(
      "site/sections/Shelf.tsx",
      async () => ({ default: () => null }),
      { loadingFallback: fallback },
    );

    const opts = getSectionOptions("site/sections/Shelf.tsx");
    expect(opts?.loadingFallback).toBe(fallback);
  });

  it("stores clientOnly flag in section options", () => {
    registerSection(
      "site/sections/Analytics.tsx",
      async () => ({ default: () => null }),
      { clientOnly: true },
    );

    const opts = getSectionOptions("site/sections/Analytics.tsx");
    expect(opts?.clientOnly).toBe(true);
  });

  it("clientOnly defaults to undefined when not set", () => {
    registerSection(
      "site/sections/Normal.tsx",
      async () => ({ default: () => null }),
      { loadingFallback: () => null },
    );

    const opts = getSectionOptions("site/sections/Normal.tsx");
    expect(opts?.clientOnly).toBeUndefined();
  });

  it("clientOnly false is preserved", () => {
    registerSection(
      "site/sections/Explicit.tsx",
      async () => ({ default: () => null }),
      { clientOnly: false },
    );

    const opts = getSectionOptions("site/sections/Explicit.tsx");
    expect(opts?.clientOnly).toBe(false);
  });

  it("returns undefined options for section without options", () => {
    registerSection("site/sections/Plain.tsx", async () => ({ default: () => null }));
    expect(getSectionOptions("site/sections/Plain.tsx")).toBeUndefined();
  });
});

describe("registerSectionsSync", () => {
  it("registers component as sync and resolved", () => {
    const MyComponent = () => null;
    registerSectionsSync({ "site/sections/Header.tsx": MyComponent });

    expect(getSyncComponent("site/sections/Header.tsx")).toBe(MyComponent);
    expect(getResolvedComponent("site/sections/Header.tsx")).toBe(MyComponent);
  });

  it("accepts module objects with LoadingFallback", () => {
    const MyComponent = () => null;
    const MyFallback = () => null;

    registerSectionsSync({
      "site/sections/Footer.tsx": {
        default: MyComponent,
        LoadingFallback: MyFallback,
      },
    });

    expect(getSyncComponent("site/sections/Footer.tsx")).toBe(MyComponent);
    const opts = getSectionOptions("site/sections/Footer.tsx");
    expect(opts?.loadingFallback).toBe(MyFallback);
  });

  it("skips entries without callable default export", () => {
    registerSectionsSync({
      "site/sections/Bad.tsx": { default: "not a function" } as any,
    });

    expect(getSyncComponent("site/sections/Bad.tsx")).toBeUndefined();
  });
});

describe("registerSectionsSync <-> getSection integration (gotcha #1 from issue #163)", () => {
  it("getSection() returns an entry for sync-registered sections", async () => {
    const FakeComponent = () => null;
    registerSectionsSync({
      "site/sections/SyncIntegrationFoo.tsx": FakeComponent,
    });
    const entry = getSection("site/sections/SyncIntegrationFoo.tsx");
    expect(entry).toBeDefined();
    // The fallback loader should resolve to the same module's default export
    const mod = await entry!();
    expect(mod.default).toBe(FakeComponent);
  });

  it("registerSectionsSync does not clobber an existing registry loader", async () => {
    const ExistingComponent = () => null;
    const SyncComponent = () => null;
    // First register a real (lazy) loader
    registerSection(
      "site/sections/ExistingFoo.tsx",
      () => Promise.resolve({ default: ExistingComponent }),
    );
    // Then call registerSectionsSync with the same key
    registerSectionsSync({
      "site/sections/ExistingFoo.tsx": SyncComponent,
    });
    const entry = getSection("site/sections/ExistingFoo.tsx");
    expect(entry).toBeDefined();
    const mod = await entry!();
    // The first registration should win — registerSectionsSync should not clobber.
    expect(mod.default).toBe(ExistingComponent);
  });
});
