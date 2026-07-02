import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { registerSection, registerSectionsSync } from "../cms/registry";
import RenderSection from "./RenderSection";

// NOTE: each test uses its OWN section key. The registry module captures the
// `globalThis.__deco.*` objects at module load, so re-assigning them in a
// beforeEach (the registry.test.ts pattern) does not actually clear the
// registry this module writes to — and RenderSection additionally keeps a
// module-level lazy cache keyed by resolveType. Unique keys sidestep both.

function Hero({ label }: { label?: string }) {
  // Single text node — avoids React's `<!-- -->` separator between
  // adjacent text/expression children, keeping assertions simple.
  return <h1>{`hero-${label ?? "none"}`}</h1>;
}

// A lazy loader that never settles: the lazy path suspends forever, so any
// content that DOES render must have come from the sync registry.
const neverResolves = () => new Promise<never>(() => {});

describe("RenderSection sync-first", () => {
  it("renders a sync-registered section directly (no Suspense fallback)", () => {
    const KEY = "site/sections/SyncA.tsx";
    registerSectionsSync({ [KEY]: { default: Hero } });

    const html = renderToString(<RenderSection section={{ __resolveType: KEY, label: "a" }} />);
    expect(html).toContain("hero-a");
  });

  it("renders sync for the old { Component: string } shape too", () => {
    const KEY = "site/sections/SyncB.tsx";
    registerSectionsSync({ [KEY]: { default: Hero } });

    const html = renderToString(
      <RenderSection section={{ Component: KEY as any, props: { label: "b" } }} />,
    );
    expect(html).toContain("hero-b");
  });

  it("prefers the sync component over a pending lazy loader", () => {
    const KEY = "site/sections/SyncC.tsx";
    // Both registered: lazy loader never settles, sync is available.
    // Sync-first must render the content without suspending.
    registerSection(KEY, neverResolves as any);
    registerSectionsSync({ [KEY]: { default: Hero } });

    const html = renderToString(
      <RenderSection
        section={{ __resolveType: KEY, label: "c" }}
        fallback={<span>loading</span>}
      />,
    );
    expect(html).toContain("hero-c");
    expect(html).not.toContain("loading");
  });

  it("falls back to the lazy path when no sync component is registered", () => {
    const KEY = "site/sections/LazyOnlyD.tsx";
    registerSection(KEY, neverResolves as any);

    const html = renderToString(
      <RenderSection
        section={{ __resolveType: KEY, label: "d" }}
        fallback={<span>loading</span>}
      />,
    );
    expect(html).toContain("loading");
    expect(html).not.toContain("hero-d");
  });

  it("renders the fallback when the section is not registered at all", () => {
    const html = renderToString(
      <RenderSection
        section={{ __resolveType: "site/sections/MissingE.tsx" }}
        fallback={<span>missing</span>}
      />,
    );
    expect(html).toContain("missing");
  });
});
