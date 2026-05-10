import { beforeEach, describe, expect, it } from "vitest";
import { registerSectionsSync, setBlocks } from "../core/cms/index";
import { loadCmsPage } from "./loadCmsPage";

describe("next/loadCmsPage", () => {
  it("accepts a Request and returns null for unknown path", async () => {
    const req = new Request("http://t/this-doesnt-exist");
    const result = await loadCmsPage(req);
    expect(result).toBeNull();
  });
});

describe("next/loadCmsPage — positive path", () => {
  beforeEach(() => {
    // Reset global state between tests so blocks/registry don't leak.
    const g = globalThis as any;
    g.__deco = g.__deco ?? {};
    g.__deco.blockData = {};
    g.__deco.revision = null;
    g.__deco.sectionRegistry = {};
    g.__deco.sectionOptions = {};
    g.__deco.resolvedComponents = {};
    g.__deco.syncComponents = {};
  });

  it("resolves a registered page via the framework-agnostic core", async () => {
    const SectionComponent = () => null;
    registerSectionsSync({
      "site/sections/Test/PositivePathSection.tsx": SectionComponent,
    });

    // Decofile shape: top-level keys are the block ids. Page blocks are
    // keyed with a `pages-` prefix (see findPageByPath in core/cms/loader.ts)
    // and contain { name, path, sections: Resolvable[] }. Each section is a
    // resolvable referencing a registered section component by __resolveType.
    setBlocks({
      "pages-known-1": {
        name: "known",
        path: "/known",
        sections: [
          {
            __resolveType: "site/sections/Test/PositivePathSection.tsx",
          },
        ],
      },
    });

    const req = new Request("http://t/known");
    const result = await loadCmsPage(req);
    expect(result).not.toBeNull();
    expect(result!.resolvedSections.length).toBeGreaterThan(0);
    expect(result!.resolvedSections[0].component).toBe(
      "site/sections/Test/PositivePathSection.tsx",
    );
  });
});
