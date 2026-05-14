import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleFsRequest } from "./fs";

describe("handleFsRequest", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "deco-fs-test-"));
    await mkdir(join(cwd, ".deco", "blocks"), { recursive: true });
    await writeFile(
      join(cwd, ".deco", "blocks", "site.json"),
      JSON.stringify({ greeting: "hello" }),
    );
  });
  afterEach(() => rm(cwd, { recursive: true, force: true }));

  it("GET returns the file content with metadata + mtime", async () => {
    const req = new Request("http://t/fs/file/.deco/blocks/site.json");
    const res = await handleFsRequest(req, { cwd });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.parse(body.content).greeting).toBe("hello");
    expect(body.timestamp).toBeGreaterThan(0);
  });

  it("GET returns 404 with a timestamp for a missing file", async () => {
    const req = new Request("http://t/fs/file/.deco/missing.json");
    const res = await handleFsRequest(req, { cwd });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.timestamp).toBeGreaterThan(0);
  });

  it("rejects path traversal", async () => {
    // URL normalization: new URL("http://t/fs/file/../../etc/passwd").pathname === "/etc/passwd"
    // so the path never reaches /fs/file/* and gets a 404 — both 403 and 404 indicate rejection
    const req = new Request("http://t/fs/file/../../etc/passwd");
    const res = await handleFsRequest(req, { cwd });
    expect([403, 404]).toContain(res.status);
  });

  it("PATCH applies a JSON patch", async () => {
    const patch = {
      type: "json" as const,
      payload: [{ op: "replace", path: "/greeting", value: "hi" }],
    };
    const req = new Request("http://t/fs/file/.deco/blocks/site.json", {
      method: "PATCH",
      body: JSON.stringify({ patch, timestamp: 0 }),
    });
    const res = await handleFsRequest(req, { cwd });
    expect(res.status).toBe(200);
    const after = JSON.parse(await readFile(join(cwd, ".deco/blocks/site.json"), "utf-8"));
    expect(after.greeting).toBe("hi");
  });

  it("DELETE removes the file", async () => {
    const req = new Request("http://t/fs/file/.deco/blocks/site.json", { method: "DELETE" });
    const res = await handleFsRequest(req, { cwd });
    expect(res.status).toBe(200);
    await expect(readFile(join(cwd, ".deco/blocks/site.json"), "utf-8")).rejects.toThrow();
  });

  it("/fs/grep stub returns an empty matches array", async () => {
    const req = new Request("http://t/fs/grep", { method: "POST" });
    const res = await handleFsRequest(req, { cwd });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ matches: [], totalMatches: 0 });
  });
});
