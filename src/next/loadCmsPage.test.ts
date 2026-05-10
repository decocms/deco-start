import { describe, expect, it } from "vitest";
import { loadCmsPage } from "./loadCmsPage";

describe("next/loadCmsPage", () => {
  it("accepts a Request and returns null for unknown path", async () => {
    const req = new Request("http://t/this-doesnt-exist");
    const result = await loadCmsPage(req);
    expect(result).toBeNull();
  });
});
